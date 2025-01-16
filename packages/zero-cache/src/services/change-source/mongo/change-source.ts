import {Db, MongoClient} from 'mongodb';

import {Lock} from '@rocicorp/lock';
import {LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';

import {randInt} from '../../../../../shared/src/rand.js';

import {Subscription} from '../../../types/subscription.js';

import type {
  ChangeSource,
  ChangeStream,
} from '../../change-streamer/change-streamer-service.js';
import type { ChangeStreamMessage } from '../protocol/current/mod.js';

import {ChangeMaker} from './change-maker.js';
import {SSLUnsupportedError} from './errors.js';
import {translateError} from './utils.js';

/**
 * MongoDB implementation of a {@link ChangeSource} backed by a change stream.
 *
 * @see https://docs.mongodb.com/manual/changeStreams/
 */
export class MongoChangeSource implements ChangeSource {
  readonly #lc: LogContext;
  readonly #upstreamUri: string;

  constructor(lc: LogContext, upstreamUri: string) {
    this.#lc = lc.withContext('component', 'change-source');
    this.#upstreamUri = upstreamUri;
  }

  async startStream(resumeToken: string): Promise<ChangeStream> {
    // expire idle connections between 5 and 10 minutes to free up server state
    const maxIdleTimeMS = randInt(5 * 60, 10 * 60);

    const client = new MongoClient(this.#upstreamUri, {maxIdleTimeMS});

    try {
      this.#lc.info?.(`starting mongo chage stream @${resumeToken}`);

      const url = new URL(this.#upstreamUri);

      const sslParam = url.searchParams.get('ssl');
      const tlsParam = url.searchParams.get('tls');

      const hasExplicitTlsTrue = sslParam === 'true' || tlsParam === 'true';
      const hasExplicitTlsFalse = sslParam === 'false' || tlsParam === 'false';

      // Use of the +srv connection string modifier automatically sets the tls
      // (or the equivalent ssl) option to true for the connection. You can
      // override this behavior by explicitly setting the tls/ssl option to
      // false with tls=false (or ssl=false) in the query string.
      //
      // see: https://www.mongodb.com/docs/manual/reference/connection-string/#srv-connection-format
      const isSrvRecord = url.protocol === 'mongodb+srv';

      const useTls =
        hasExplicitTlsTrue || (isSrvRecord && !hasExplicitTlsFalse);

      this.#lc.debug?.(`connecting with tls=${useTls} ${url.search}`);

      // default DB is specified as the URI path
      const db = client.db(url.pathname.slice(1));

      return await this.#startStream(db, resumeToken, useTls);
    } finally {
      // TODO: evaluate whether to force connection close after a timeout
      // gracefully close the connection, allowing any in-flight operations to complete
      await client.close();
    }
  }

  async #startStream(
    db: Db,
    resumeAfter: string,
    useTls: boolean,
  ): Promise<ChangeStream> {
    const changes = Subscription.create<ChangeStreamMessage>({
      cleanup: () => stream.close(),
    });

    // To avoid a race conditions when handing off the replication stream
    // between tasks, query the `confirmed_flush_lsn` for the replication
    // slot only after the replication stream starts, as that is when it
    // is guaranteed not to change (i.e. until we ACK a commit).
    const {promise: nextWatermark, resolve, reject} = resolver<string>();

    const handleError = (err: Error) => {
      if (
        useTls &&
        // https://github.com/brianc/node-postgres/blob/8b2768f91d284ff6b97070aaf6602560addac852/packages/pg/lib/connection.js#L74
        err.message === 'The server does not support SSL connections'
      ) {
        reject(new SSLUnsupportedError());
        return;
      }

      const e = translateError(err);
      reject(e);
      changes.fail(e);
    };

    const changeMaker = new ChangeMaker(this.#lc);
    const lock = new Lock();

    const stream = db
      .watch([], {
        resumeAfter,
        fullDocument: 'updateLookup',
        timeoutMS: Number.MAX_SAFE_INTEGER,
      })
      .on('init', resolve)
      .on('change', event =>
        lock.withLock(async () => {
          // lock to ensure in-order processing
          for (const change of await changeMaker.makeChanges(event)) {
            changes.push(change);
          }
        }),
      )
      .on('end', () => changes.cancel())
      .on('error', handleError);

    // const service = new LogicalReplicationService(
    //   {
    //     connectionString: this.#upstreamUri,
    //     ssl,
    //     ['application_name']: `zero-replicator`,
    //   },
    //   {acknowledge: {auto: false, timeoutSeconds: 0}},
    // )
    //   .on('start', () =>
    //     this.#getNextWatermark(db, slot, clientStart).then(
    //       resolve,
    //       handleError,
    //     ),
    //   )
    //   .on(
    //     'heartbeat',
    //     (lsn, _time, respond) => acker?.onHeartbeat(lsn, respond),
    //   )
    //   .on('data', (lsn, msg) => {
    //     acker?.onData(lsn);
    //     // lock to ensure in-order processing
    //     return lock.withLock(async () => {
    //       for (const change of await changeMaker.makeChanges(lsn, msg)) {
    //         changes.push(change);
    //       }
    //     });
    //   })
    //   .on('error', handleError);

    // service
    //   .subscribe(
    //     new PgoutputPlugin({
    //       protoVersion: 1,
    //       publicationNames: this.#replicationConfig.publications,
    //       messages: true,
    //     }),
    //     slot,
    //     fromLexiVersion(resumeAfter),
    //   )
    //   .then(() => changes.cancel(), handleError);

    const initialWatermark = await nextWatermark;
    this.#lc.info?.(`change stream started at ${initialWatermark}`);

    return {
      initialWatermark,
      changes,
      acks: {push: () => {}},
    };
  }
}
