import type {Schema} from '../../zero-schema/src/builder/schema-builder.ts';
import type {TableSchema} from '../../zero-schema/src/table-schema.ts';
import type {
  SchemaCRUD,
  SchemaQuery,
  TableCRUD,
  TransactionBase,
  DBTransaction,
  Transaction,
} from '../../zql/src/mutate/custom.ts';
import {
  formatPgInternalConvert,
  sqlConvertArgUnsafe,
  sql,
} from '../../z2s/src/sql.ts';
import {must} from '../../shared/src/must.ts';

interface ServerTransaction<S extends Schema, TWrappedTransaction>
  extends TransactionBase<S> {
  readonly location: 'server';
  readonly reason: 'authoritative';
  readonly dbTransaction: DBTransaction<TWrappedTransaction>;
}

export type CustomMutatorDefs<S extends Schema, TDBTransaction> = {
  readonly [Table in keyof S['tables']]?: {
    readonly [key: string]: CustomMutatorImpl<S, TDBTransaction>;
  };
} & {
  [namespace: string]: {
    [key: string]: CustomMutatorImpl<S, TDBTransaction>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CustomMutatorImpl<S extends Schema, TDBTransaction, TArgs = any> = (
  tx: Transaction<S, TDBTransaction>,
  args: TArgs,
) => Promise<void>;

export class TransactionImpl<S extends Schema, TWrappedTransaction>
  implements ServerTransaction<S, TWrappedTransaction>
{
  readonly location = 'server';
  readonly reason = 'authoritative';
  readonly dbTransaction: DBTransaction<TWrappedTransaction>;
  readonly clientID: string;
  readonly mutationID: number;
  readonly mutate: SchemaCRUD<S>;
  readonly query: SchemaQuery<S>;

  constructor(
    dbTransaction: DBTransaction<TWrappedTransaction>,
    clientID: string,
    mutationID: number,
    mutate: SchemaCRUD<S>,
    query: SchemaQuery<S>,
  ) {
    this.dbTransaction = dbTransaction;
    this.clientID = clientID;
    this.mutationID = mutationID;
    this.mutate = mutate;
    this.query = query;
  }
}

const dbTxSymbol = Symbol();
type WithHiddenTx = {[dbTxSymbol]: DBTransaction<unknown>};

export function makeSchemaCRUD<S extends Schema>(
  schema: S,
): (dbTransaction: DBTransaction<unknown>) => SchemaCRUD<S> {
  const schemaCRUDs: Record<string, TableCRUD<TableSchema>> = {};
  for (const tableSchema of Object.values(schema.tables)) {
    schemaCRUDs[tableSchema.name] = makeTableCRUD(tableSchema);
  }

  /**
   * For users with very large schemas it is expensive to re-create
   * all the CRUD mutators for each transaction. Instead, we create
   * them all once up-front and then bind them to the transaction
   * as requested.
   */
  class CRUDHandler {
    readonly #dbTransaction: DBTransaction<unknown>;
    constructor(dbTransaction: DBTransaction<unknown>) {
      this.#dbTransaction = dbTransaction;
    }

    get(target: Record<string, TableCRUD<TableSchema>>, prop: string) {
      if (prop in target) {
        return target[prop];
      }

      const txHolder: WithHiddenTx = {
        [dbTxSymbol]: this.#dbTransaction,
      };
      target[prop] = Object.fromEntries(
        Object.entries(schemaCRUDs[prop]).map(([name, method]) => [
          name,
          method.bind(txHolder),
        ]),
      ) as TableCRUD<TableSchema>;

      return target[prop];
    }
  }

  return (dbTransaction: DBTransaction<unknown>) =>
    new Proxy({}, new CRUDHandler(dbTransaction)) as SchemaCRUD<S>;
}

function makeTableCRUD(schema: TableSchema): TableCRUD<TableSchema> {
  return {
    async insert(this: WithHiddenTx, value) {
      const targetedColumns = origAndServerNamesFor(Object.keys(value), schema);
      const stmt = formatPgInternalConvert(
        sql`INSERT INTO ${sql.ident(serverName(schema))} (${sql.join(
          targetedColumns.map(([, serverName]) => sql.ident(serverName)),
          ',',
        )}) VALUES (${sql.join(
          Object.entries(value).map(([col, v]) => sqlValue(schema, col, v)),
          ', ',
        )})`,
      );
      const tx = this[dbTxSymbol];
      await tx.query(stmt.text, stmt.values);
    },
    async upsert(this: WithHiddenTx, value) {
      const targetedColumns = origAndServerNamesFor(Object.keys(value), schema);
      const primaryKeyColumns = origAndServerNamesFor(
        schema.primaryKey,
        schema,
      );
      const stmt = formatPgInternalConvert(
        sql`INSERT INTO ${sql.ident(serverName(schema))} (${sql.join(
          targetedColumns.map(([, serverName]) => sql.ident(serverName)),
          ',',
        )}) VALUES (${sql.join(
          Object.entries(value).map(([col, val]) => sqlValue(schema, col, val)),
          ', ',
        )}) ON CONFLICT (${sql.join(
          primaryKeyColumns.map(([, serverName]) => sql.ident(serverName)),
          ', ',
        )}) DO UPDATE SET ${sql.join(
          Object.entries(value).map(
            ([col, val]) =>
              sql`${sql.ident(
                schema.columns[col].serverName ?? col,
              )} = ${sqlValue(schema, col, val)}`,
          ),
          ', ',
        )}`,
      );
      const tx = this[dbTxSymbol];
      await tx.query(stmt.text, stmt.values);
    },
    async update(this: WithHiddenTx, value) {
      const targetedColumns = origAndServerNamesFor(Object.keys(value), schema);
      const stmt = formatPgInternalConvert(
        sql`UPDATE ${sql.ident(serverName(schema))} SET ${sql.join(
          targetedColumns.map(
            ([origName, serverName]) =>
              sql`${sql.ident(serverName)} = ${sqlValue(schema, origName, value[origName])}`,
          ),
          ', ',
        )} WHERE ${primaryKeyClause(schema, value)}`,
      );
      const tx = this[dbTxSymbol];
      await tx.query(stmt.text, stmt.values);
    },
    async delete(this: WithHiddenTx, value) {
      const stmt = formatPgInternalConvert(
        sql`DELETE FROM ${sql.ident(
          serverName(schema),
        )} WHERE ${primaryKeyClause(schema, value)}`,
      );
      const tx = this[dbTxSymbol];
      await tx.query(stmt.text, stmt.values);
    },
  };
}

function serverName(x: {name: string; serverName?: string | undefined}) {
  return x.serverName ?? x.name;
}

function primaryKeyClause(schema: TableSchema, row: Record<string, unknown>) {
  const primaryKey = origAndServerNamesFor(schema.primaryKey, schema);
  return sql`${sql.join(
    primaryKey.map(
      ([origName, serverName]) =>
        sql`${sql.ident(serverName)} = ${sqlValue(schema, origName, row[origName])}`,
    ),
    ' AND ',
  )}`;
}

function origAndServerNamesFor(
  originalNames: readonly string[],
  schema: TableSchema,
): [origName: string, serverName: string][] {
  return originalNames.map(name => {
    const col = schema.columns[name];
    return [name, col.serverName ?? name] as const;
  });
}

function sqlValue(schema: TableSchema, column: string, value: unknown) {
  return sqlConvertArgUnsafe(must(schema.columns[column].type), value);
}
