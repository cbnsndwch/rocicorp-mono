import type {LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import type postgres from 'postgres';
import {assert} from 'shared/src/asserts.js';
import {Queue} from 'shared/src/queue.js';

type MaybePromise<T> = Promise<T> | T;

export type Statement =
  | postgres.PendingQuery<(postgres.Row & Iterable<postgres.Row>)[]>
  | postgres.PendingQuery<postgres.Row[]>;

/**
 * A {@link Task} is logic run from within a transaction in a {@link TransactionPool}.
 * It can return a list of `Statements` (for write transactions), which the transaction
 * will execute asynchronously and await when it receives the 'done' signal, or it can
 * return a `Promise<void>` (typical for read transactions) that is awaited when
 * the task is processed.
 */
export type Task = (
  tx: postgres.TransactionSql,
  lc: LogContext,
) => MaybePromise<Statement[] | void>;

/**
 * A TransactionPool is a pool of one or more {@link postgres.TransactionSql}
 * objects that participate in processing a dynamic queue of tasks.
 *
 * This can be used for serializing a set of tasks that arrive asynchronously
 * to a single transaction (for writing) or performing parallel reads across
 * multiple connections at the same snapshot (e.g. read only snapshot transactions).
 */
export class TransactionPool {
  readonly #lc: LogContext;
  readonly #init: Task | undefined;
  readonly #cleanup: Task | undefined;
  readonly #tasks = new Queue<Task | Error | 'done'>();
  readonly #workers: Promise<unknown>[] = [];
  readonly #maxWorkers: number;
  #numWorkers: number;
  #db: postgres.Sql | undefined; // set when running. stored to allow adaptive pool sizing.

  #done = false;
  #failure: Error | undefined;

  /**
   * @param init A {@link Task} that is run in each Transaction before it begins
   *             processing general tasks. This can be used to to set the transaction
   *             mode, export/set snapshots, etc.
   * @param cleanup A {@link Task} that is run in each Transaction before it closes.
   *                This may be skipped if {@link fail} is called.
   * @param initialWorkers The number of transaction workers to process tasks.
   *                       This must be greater than 0. Defaults to 1.
   * @param maxWorkers When specified, allows the pool to grow to `maxWorkers`. This
   *                   must be greater than or equal to `initialWorkers`.
   */
  constructor(
    lc: LogContext,
    init?: Task,
    cleanup?: Task,
    initialWorkers = 1,
    maxWorkers?: number,
  ) {
    maxWorkers ??= initialWorkers;
    assert(initialWorkers > 0);
    assert(maxWorkers >= initialWorkers);

    this.#lc = lc;
    this.#init = init;
    this.#cleanup = cleanup;
    this.#numWorkers = initialWorkers;
    this.#maxWorkers = maxWorkers;
  }

  /**
   * Starts the pool of workers to process Tasks with transactions opened from the
   * specified {@link db}.
   *
   * Returns {@link done()}.
   */
  async run(db: postgres.Sql): Promise<void> {
    assert(!this.#db, 'already running');
    this.#db = db;
    for (let i = 0; i < this.#numWorkers; i++) {
      this.#addWorker(db);
    }
    await this.done();
    this.#lc.debug?.('transaction pool done');
  }

  /**
   * Returns a promise that:
   *
   * * resolves after {@link setDone} has been called, once all added tasks have
   *   been processed and all transactions have been committed or closed.
   *
   * * rejects if processing was aborted with {@link fail} or if processing any of
   *   the tasks resulted in an error. All uncommitted transactions will have been
   *   rolled back.
   *
   * Note that partial failures are possible if processing writes with multiple workers
   * (e.g. `setDone` is called, allowing some workers to commit, after which other
   *  workers encounter errors). Using a TransactionPool in this manner does not make
   * sense in terms of transactional semantics, and is thus not recommended.
   *
   * For reads, however, multiple workers is useful for performing parallel reads
   * at the same snapshot. See {@link synchronizedSnapshots} for an example.
   * Resolves or rejects when all workers are done or failed.
   */
  async done() {
    const numWorkers = this.#workers.length;
    await Promise.all(this.#workers);

    if (numWorkers < this.#workers.length) {
      // If workers were added after the initial set, they must be awaited to ensure
      // that the results (i.e. rejections) of all workers are accounted for. This only
      // needs to be re-done once, because the fact that the first `await` completed
      // guarantees that the pool is in a terminal state and no new workers can be added.
      await Promise.all(this.#workers);
    }
  }

  #addWorker(db: postgres.Sql) {
    const lc = this.#lc.withContext('worker', `#${this.#workers.length + 1}`);
    const worker = async (tx: postgres.TransactionSql) => {
      try {
        lc.debug?.('started worker');

        const pending: Promise<unknown>[] = [];

        const executeTask = async (task: Task) => {
          const result = await task(tx, this.#lc);
          if (Array.isArray(result)) {
            // Execute the statements (i.e. send to the db) immediately and add them to
            // `pending` for the final await.
            //
            // Optimization: Fail immediately on rejections to prevent more tasks from
            // queueing up. This can save a lot of time if an initial task fails before
            // many subsequent tasks (e.g. transaction replay detection).
            pending.push(
              ...result.map(stmt => stmt.execute().catch(e => this.fail(e))),
            );
            lc.debug?.(`executed ${result.length} statement(s)`);
          }
        };

        let task: Task | Error | 'done' =
          this.#init ?? (await this.#tasks.dequeue());

        while (task !== 'done') {
          if (this.#failure || task instanceof Error) {
            await Promise.allSettled(pending); // avoid unhandled rejections
            throw this.#failure ?? task;
          }
          await executeTask(task);

          // await the next task.
          task = await this.#tasks.dequeue();
        }
        if (this.#cleanup) {
          await executeTask(this.#cleanup);
        }

        lc.debug?.('worker done');
        return Promise.all(pending);
      } catch (e) {
        this.fail(e); // A failure in any worker should fail the pool.
        throw e;
      }
    };

    this.#workers.push(db.begin(worker));

    // After adding the worker, enqueue a terminal signal if we are in either of the
    // terminal states (both of which prevent more tasks from being enqueued), to ensure
    // that the added worker eventually exits.
    if (this.#done) {
      void this.#tasks.enqueue('done');
    }
    if (this.#failure) {
      void this.#tasks.enqueue(this.#failure);
    }
  }

  process(task: Task) {
    assert(!this.#done, 'already set done');
    if (this.#failure) {
      return;
    }

    void this.#tasks.enqueue(task);

    // Check if the pool size can and should be increased.
    if (this.#numWorkers < this.#maxWorkers) {
      const outstanding = this.#tasks.size();

      if (
        // Not running yet; the number of initial workers should be increased.
        (!this.#db && outstanding > this.#numWorkers) ||
        // Running but task was not picked up. Add a worker.
        (this.#db && outstanding > 0)
      ) {
        this.#db && this.#addWorker(this.#db);
        this.#numWorkers++;
        this.#lc.info?.(`Increased pool size to: ${this.#numWorkers}`);
      }
    }
  }

  /**
   * Signals to all workers to end their transaction once all pending tasks have
   * been completed.
   */
  setDone() {
    assert(!this.#done, 'already set done');
    this.#done = true;

    for (let i = 0; i < this.#workers.length; i++) {
      void this.#tasks.enqueue('done');
    }
  }

  /**
   * Signals all workers to fail their transactions with the given {@link err}.
   */
  fail(err: unknown) {
    if (!this.#failure) {
      this.#failure = ensureError(err); // Fail fast: this is checked in the worker loop.
      if (this.#failure instanceof ControlFlowError) {
        this.#lc.debug?.(this.#failure);
      } else {
        this.#lc.error?.(this.#failure);
      }

      for (let i = 0; i < this.#workers.length; i++) {
        // Enqueue the Error to terminate any workers waiting for tasks.
        void this.#tasks.enqueue(this.#failure);
      }
    }
  }
}

type SynchronizeSnapshotTasks = {
  /**
   * The `init` Task for the TransactionPool from which the snapshot
   * originates.
   */
  exportSnapshot: Task;

  /**
   * The `cleanup` Task for the TransactionPool from which the snapshot
   * originates.
   */
  cleanupExport: Task;

  /**
   * The `init` Task for the TransactionPool in which workers will
   * consequently see the same snapshot as that of the first pool.
   * In addition to setting the snapshot, the transaction mode will be
   * set to `ISOLATION LEVEL REPEATABLE READ` and `READ ONLY`.
   */
  setSnapshot: Task;
};

/**
 * Init Tasks for Postgres snapshot synchronization across transactions.
 *
 * https://www.postgresql.org/docs/9.3/functions-admin.html#:~:text=Snapshot%20Synchronization%20Functions,identical%20content%20in%20the%20database.
 */
export function synchronizedSnapshots(): SynchronizeSnapshotTasks {
  const {
    promise: snapshotExported,
    resolve: exportSnapshot,
    reject: failExport,
  } = resolver<string>();

  const {
    promise: snapshotCaptured,
    resolve: captureSnapshot,
    reject: failCapture,
  } = resolver<unknown>();

  // Note: Neither init task should `await`, as processing in each pool can proceed
  //       as soon as the statements have been sent to the db. However, the `cleanupExport`
  //       task must `await` the result of `setSnapshot` to ensure that exporting transaction
  //       does not close before the snapshot has been captured.
  return {
    exportSnapshot: tx => {
      const stmt = tx`SELECT pg_export_snapshot() AS snapshot;`.simple();
      // Intercept the promise to propagate the information to `setSnapshot`.
      stmt.then(result => exportSnapshot(result[0].snapshot), failExport);
      // Also return the stmt so that it gets awaited (and errors handled).
      return [stmt];
    },

    setSnapshot: tx =>
      snapshotExported.then(snapshotID => {
        const stmt = tx.unsafe(`
        SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET TRANSACTION SNAPSHOT '${snapshotID}';
        `);
        // Intercept the promise to propagate the information to `cleanupExport`.
        stmt.then(captureSnapshot, failCapture);
        return [stmt];
      }),

    cleanupExport: async () => {
      await snapshotCaptured;
    },
  };
}

/**
 * A superclass of Errors used for control flow that is needed to handle
 * another Error but does not constitute an error condition itself (e.g.
 * aborting transactions after a previous one fails). Subclassing this Error
 * will result in lowering the log level from `error` to `debug`.
 */
export class ControlFlowError extends Error {
  constructor(err: unknown) {
    super();
    this.cause = err;
  }
}

function ensureError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  const error = new Error();
  error.cause = err;
  return error;
}