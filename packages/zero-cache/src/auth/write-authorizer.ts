import type {SQLQuery} from '@databases/sql';
import {LogContext} from '@rocicorp/logger';
import type {JWTPayload} from 'jose';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pid} from 'node:process';
import {assert} from '../../../shared/src/asserts.js';
import type {JSONValue} from '../../../shared/src/json.js';
import {randInt} from '../../../shared/src/rand.js';
import * as v from '../../../shared/src/valita.js';
import type {
  InsertOp,
  DeleteOp,
  UpsertOp,
  UpdateOp,
  CRUDOp,
} from '../../../zero-protocol/src/mod.js';
import {
  primaryKeyValueSchema,
  type PrimaryKeyValue,
} from '../../../zero-protocol/src/primary-key.js';
import type {BuilderDelegate} from '../../../zql/src/builder/builder.js';
import {
  bindStaticParameters,
  buildPipeline,
} from '../../../zql/src/builder/builder.js';
import {Database} from '../../../zqlite/src/db.js';
import {compile, sql} from '../../../zqlite/src/internal/sql.js';
import {TableSource} from '../../../zqlite/src/table-source.js';
import type {ZeroConfig} from '../config/zero-config.js';
import {listTables} from '../db/lite-tables.js';
import {mapLiteDataTypeToZqlSchemaValue} from '../types/lite.js';
import {DatabaseStorage} from '../services/view-syncer/database-storage.js';
import type {NormalizedTableSpec} from '../services/view-syncer/pipeline-driver.js';
import {normalize} from '../services/view-syncer/pipeline-driver.js';
import type {
  PermissionsConfig,
  Policy,
} from '../../../zero-schema/src/compiled-permissions.js';
import {StatementRunner} from '../db/statements.js';
import type {Schema} from '../../../zero-schema/src/schema.js';
import {AuthQuery, authQuery} from '../../../zql/src/query/auth-query.js';
import {must} from '../../../shared/src/must.js';
import type {Query} from '../../../zql/src/query/query.js';
import type {TableSchema} from '../../../zero-schema/src/table-schema.js';
import type {Condition} from '../../../zero-protocol/src/ast.js';
import {dnf} from '../../../zql/src/query/dnf.js';
import type {Row} from '../../../zero-protocol/src/data.js';

type Phase = 'preMutation' | 'postMutation';

export interface WriteAuthorizer {
  canPreMutation(
    authData: JWTPayload | undefined,
    ops: Exclude<CRUDOp, UpsertOp>[],
  ): boolean;
  canPostMutation(
    authData: JWTPayload | undefined,
    ops: Exclude<CRUDOp, UpsertOp>[],
  ): boolean;
  normalizeOps(ops: CRUDOp[]): Exclude<CRUDOp, UpsertOp>[];
}

export class WriteAuthorizerImpl implements WriteAuthorizer {
  readonly #schema: Schema;
  readonly #permissionsConfig: PermissionsConfig;
  readonly #replica: Database;
  readonly #builderDelegate: BuilderDelegate;
  readonly #tableSpecs: Map<string, NormalizedTableSpec>;
  readonly #tables = new Map<string, TableSource>();
  readonly #statementRunner: StatementRunner;
  readonly #lc: LogContext;

  constructor(
    lc: LogContext,
    config: Pick<ZeroConfig, 'storageDBTmpDir'>,
    schema: Schema,
    permissions: PermissionsConfig | undefined,
    replica: Database,
    cgID: string,
  ) {
    this.#lc = lc.withContext('class', 'WriteAuthorizerImpl');
    this.#schema = schema;
    this.#permissionsConfig = permissions ?? {};
    this.#replica = replica;
    const tmpDir = config.storageDBTmpDir ?? tmpdir();
    const writeAuthzStorage = DatabaseStorage.create(
      lc,
      path.join(tmpDir, `mutagen-${pid}-${randInt(1000000, 9999999)}`),
    );
    const cgStorage = writeAuthzStorage.createClientGroupStorage(cgID);
    this.#builderDelegate = {
      getSource: name => this.#getSource(name),
      createStorage: () => cgStorage.createStorage(),
    };
    this.#tableSpecs = new Map(
      listTables(replica).map(spec => [spec.name, normalize(spec)]),
    );
    this.#statementRunner = new StatementRunner(replica);
  }

  canPreMutation(
    authData: JWTPayload | undefined,
    ops: Exclude<CRUDOp, UpsertOp>[],
  ) {
    for (const op of ops) {
      switch (op.op) {
        case 'insert':
          // insert does not run pre-mutation checks
          break;
        case 'update': {
          const oldRow = this.#getPreMutationRow(op);
          const proposedRow = {
            ...oldRow,
            ...op.value,
          };
          if (
            !this.#canDo(
              'preMutation',
              'update',
              authData,
              op,
              oldRow,
              proposedRow,
            )
          ) {
            return false;
          }

          break;
        }
        case 'delete': {
          const oldRow = this.#getPreMutationRow(op);
          if (
            !this.#canDo(
              'preMutation',
              'delete',
              authData,
              op,
              oldRow,
              undefined,
            )
          ) {
            return false;
          }
          break;
        }
      }
    }
    return true;
  }

  canPostMutation(
    authData: JWTPayload | undefined,
    ops: Exclude<CRUDOp, UpsertOp>[],
  ) {
    this.#statementRunner.beginConcurrent();
    try {
      const preMutationRows: (Row | undefined)[] = [];
      const postProposedMutationRows: (Row | undefined)[] = [];
      for (const op of ops) {
        const source = this.#getSource(op.tableName);
        switch (op.op) {
          case 'insert': {
            source.push({
              type: 'add',
              row: op.value,
            });
            preMutationRows.push(undefined);
            postProposedMutationRows.push(op.value);
            break;
          }
          // TODO (mlaw): what if someone updates the same thing twice?
          case 'update': {
            const oldRow = this.#getPreMutationRow(op);
            source.push({
              type: 'edit',
              oldRow,
              row: op.value,
            });
            preMutationRows.push(oldRow);
            postProposedMutationRows.push({
              ...oldRow,
              ...op.value,
            });
            break;
          }
          case 'delete': {
            const row = this.#getPreMutationRow(op);
            source.push({
              type: 'remove',
              row,
            });
            preMutationRows.push(row);
            postProposedMutationRows.push(undefined);
            break;
          }
        }
      }

      assert(preMutationRows.length === ops.length);
      assert(postProposedMutationRows.length === ops.length);

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        switch (op.op) {
          case 'insert':
            if (
              !this.#timedCanDo(
                'postMutation',
                'insert',
                authData,
                op,
                preMutationRows[i],
                postProposedMutationRows[i],
              )
            ) {
              return false;
            }
            break;
          case 'update':
            if (
              !this.#timedCanDo(
                'postMutation',
                'update',
                authData,
                op,
                preMutationRows[i],
                postProposedMutationRows[i],
              )
            ) {
              return false;
            }
            break;
          case 'delete':
            // delete does not run post-mutation checks.
            break;
        }
      }
    } finally {
      this.#statementRunner.rollback();
    }

    return true;
  }

  normalizeOps(ops: CRUDOp[]): Exclude<CRUDOp, UpsertOp>[] {
    return ops.map(op => {
      if (op.op === 'upsert') {
        const preMutationRow = this.#getPreMutationRow(op);
        if (preMutationRow) {
          return {
            op: 'update',
            tableName: op.tableName,
            primaryKey: op.primaryKey,
            value: op.value,
          };
        }
        return {
          op: 'insert',
          tableName: op.tableName,
          primaryKey: op.primaryKey,
          value: op.value,
        };
      }
      return op;
    });
  }

  #getSource(tableName: string) {
    let source = this.#tables.get(tableName);
    if (source) {
      return source;
    }
    const tableSpec = this.#tableSpecs.get(tableName);
    if (!tableSpec) {
      throw new Error(`Table ${tableName} not found`);
    }
    const {columns, primaryKey} = tableSpec;
    assert(primaryKey.length);
    source = new TableSource(
      this.#replica,
      tableName,
      Object.fromEntries(
        Object.entries(columns).map(([name, {dataType}]) => [
          name,
          mapLiteDataTypeToZqlSchemaValue(dataType),
        ]),
      ),
      [primaryKey[0], ...primaryKey.slice(1)],
    );
    this.#tables.set(tableName, source);

    return source;
  }

  #timedCanDo<A extends keyof ActionOpMap>(
    phase: Phase,
    action: A,
    authData: JWTPayload | undefined,
    op: ActionOpMap[A],
    preMutationRow: Row | undefined,
    proposedMutationRow: Row | undefined,
  ) {
    const start = performance.now();
    try {
      const ret = this.#canDo(
        phase,
        action,
        authData,
        op,
        preMutationRow,
        proposedMutationRow,
      );
      return ret;
    } finally {
      this.#lc.info?.(
        'action:',
        action,
        'duration:',
        performance.now() - start,
        'tableName:',
        op.tableName,
        'primaryKey:',
        op.primaryKey,
      );
    }
  }

  #canDo<A extends keyof ActionOpMap>(
    phase: Phase,
    action: A,
    authData: JWTPayload | undefined,
    op: ActionOpMap[A],
    preMutationRow: Row | undefined,
    proposedMutationRow: Row | undefined,
  ) {
    const rules = this.#permissionsConfig[op.tableName];
    if (rules?.row === undefined) {
      return true;
    }

    const rowPolicies = rules.row;
    let rowQuery = authQuery(
      must(
        this.#schema.tables[op.tableName],
        'No schema found for table ' + op.tableName,
      ),
    );
    op.primaryKey.forEach(pk => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rowQuery = rowQuery.where(pk, '=', op.value[pk] as any);
    });

    let applicableRowPolicy: Policy | undefined;
    switch (action) {
      case 'insert':
        if (rowPolicies && rowPolicies.insert && phase === 'postMutation') {
          applicableRowPolicy = rowPolicies.insert;
        }
        break;
      case 'update':
        if (rowPolicies && rowPolicies.update) {
          if (phase === 'preMutation') {
            applicableRowPolicy = rowPolicies.update.preMutation;
          } else if (phase === 'postMutation') {
            applicableRowPolicy = rowPolicies.update.postProposedMutation;
          }
        }
        break;
      case 'delete':
        if (rowPolicies && rowPolicies.delete && phase === 'preMutation') {
          applicableRowPolicy = rowPolicies.delete;
        }
        break;
    }

    return this.#passesPolicyGroup(
      applicableRowPolicy,
      authData,
      rowQuery,
      preMutationRow,
      proposedMutationRow,
    );
  }

  #getPreMutationRow(op: UpsertOp | UpdateOp | DeleteOp) {
    const {value} = op;
    const conditions: SQLQuery[] = [];
    const values: PrimaryKeyValue[] = [];
    for (const pk of op.primaryKey) {
      conditions.push(sql`${sql.ident(pk)}=?`);
      values.push(v.parse(value[pk], primaryKeyValueSchema));
    }

    return this.#statementRunner.get(
      compile(
        sql`SELECT * FROM ${sql.ident(op.tableName)} WHERE ${sql.join(
          conditions,
          sql` AND `,
        )}`,
      ),
      ...values,
    );
  }

  #passesPolicyGroup(
    applicableRowPolicy: Policy | undefined,
    authData: JWTPayload | undefined,
    rowQuery: Query<TableSchema>,
    preMutationRow: Row | undefined,
    proposedMutationRow: Row | undefined,
  ) {
    if (applicableRowPolicy === undefined) {
      return true;
    }

    return this.#passesPolicy(
      applicableRowPolicy,
      authData,
      rowQuery,
      preMutationRow,
      proposedMutationRow,
    );
  }

  #passesPolicy(
    policy: Policy | undefined,
    authData: JWTPayload | undefined,
    rowQuery: Query<TableSchema>,
    preMutationRow: Row | undefined,
    proposedMutationRow: Row | undefined,
  ) {
    if (policy === undefined) {
      return true;
    }
    if (policy.length === 0) {
      return false;
    }
    let rowQueryAst = (rowQuery as AuthQuery<TableSchema>).ast;
    rowQueryAst = bindStaticParameters(
      {
        ...rowQueryAst,
        where: updateWhere(rowQueryAst.where, policy),
      },
      {
        authData: authData as Record<string, JSONValue>,
        preMutationRow,
        proposedMutationRow,
      },
    );

    const input = buildPipeline(rowQueryAst, this.#builderDelegate);
    try {
      const res = input.fetch({});
      for (const _ of res) {
        // if any row is returned at all, the
        // rule passes.
        return true;
      }
    } finally {
      input.destroy();
    }

    // no rows returned by any rules? The policy fails.
    return false;
  }
}

function updateWhere(where: Condition | undefined, policy: Policy) {
  assert(where, 'A where condition must exist for RowQuery');

  return dnf({
    type: 'and',
    conditions: [
      where,
      {type: 'or', conditions: policy.map(([, rule]) => rule)},
    ],
  });
}

type ActionOpMap = {
  insert: InsertOp;
  update: UpdateOp;
  delete: DeleteOp;
};
