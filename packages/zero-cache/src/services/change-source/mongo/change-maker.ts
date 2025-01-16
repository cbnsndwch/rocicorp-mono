import type {
  ChangeStreamDeleteDocument,
  ChangeStreamDocument,
  ChangeStreamInsertDocument,
  ChangeStreamReplaceDocument,
  ChangeStreamUpdateDocument,
} from 'mongodb';

import type {LogContext} from '@rocicorp/logger';

import {assert} from '../../../../../shared/src/asserts.js';
import {stringify} from '../../../types/bigint-json.js';

import type {
  ChangeStreamData,
  ChangeStreamMessage,
} from '../protocol/current/downstream.js';
import type {
  MessageDelete,
  MessageInsert,
  MessageRelation,
} from '../protocol/current/data.js';

import type {ReplicationError} from './errors.js';

export class ChangeMaker {
  readonly #lc: LogContext;

  #error: ReplicationError | undefined;

  constructor(lc: LogContext) {
    this.#lc = lc;
  }

  async makeChanges(doc: ChangeStreamDocument): Promise<ChangeStreamMessage[]> {
    if (this.#error) {
      this.#logError(this.#error);
      return [];
    }
    try {
      return await this.#makeChanges(doc);
    } catch (err) {
      this.#error = {doc, err, resumeToken: doc._id, lastLogTime: 0};
      this.#logError(this.#error!);
      // Rollback the current transaction to avoid dangling transactions in
      // downstream processors (i.e. changeLog, replicator).
      return [
        // ['rollback', {tag: 'rollback'}],
        ['control', {tag: 'reset-required'}],
      ];
    }
  }

  #logError(error: ReplicationError) {
    const {doc: msg, err, resumeToken, lastLogTime} = error;
    const now = Date.now();

    // Output an error to logs as replication messages continue to be dropped,
    // at most once a minute.
    if (now - lastLogTime > 60000) {
      this.#lc.error?.(
        `Unable to continue replication from LSN ${resumeToken}: ${String(
          err,
        )}`,
        // 'content' can be a large byte Buffer. Exclude it from logging output.
        {...msg, content: undefined},
      );
      error.lastLogTime = now;
    }
  }

  // eslint-disable-next-line require-await
  async #makeChanges(doc: ChangeStreamDocument): Promise<ChangeStreamData[]> {
    switch (doc.operationType) {
      //#region CRUD

      case 'insert':
        return this.#makeInsertChanges(doc);

      case 'update':
        return this.#makeUpdateChanges(doc);

      case 'delete':
        return this.#makeDeleteChanges(doc);

      case 'replace':
        return this.#makeReplaceChanges(doc);

      //#endregion CRUD

      //#region Implement

      case 'create':
        // Occurs on the creation of a collection.
        // Requires `showExpandedEvents=true` in the watch call
        //
        // from: 6.0
        // see: https://www.mongodb.com/docs/manual/reference/change-events/create/#mongodb-data-create
        return [];

      case 'createIndexes':
        // Occurs on the creation of indexes on the collection.
        // Requires `showExpandedEvents=true` in the watch call
        //
        // from: 6.0
        // see: https://www.mongodb.com/docs/manual/reference/change-events/createIndexes/#mongodb-data-createIndexes
        return [];

      case 'drop':
        // Occurs when a collection is dropped from a database
        //
        // see: https://www.mongodb.com/docs/manual/reference/change-events/drop/#mongodb-data-drop
        return [];

      case 'dropDatabase':
        // Occurs when a database is dropped
        //
        // see: https://www.mongodb.com/docs/manual/reference/change-events/dropDatabase/#mongodb-data-dropDatabase
        return [];

      case 'dropIndexes':
        // Occurs when an index is dropped from the collection
        // Requires `showExpandedEvents=true` in the watch call
        //
        // from: 6.0
        // see: https://www.mongodb.com/docs/manual/reference/change-events/dropIndexes/#mongodb-data-dropIndexes
        return [];

      case 'invalidate':
        // Occurs when an operation renders the change stream invalid
        // 
        // For example, a change stream opened on a collection that was later dropped or renamed would cause an invalidate event.
        // TODO: list potential causes and document for which a replica reset is required
        //
        // see: https://www.mongodb.com/docs/manual/reference/change-events/invalidate/#mongodb-data-invalidate
        return [];

      case 'modify':
        // Occurs when a collection is modified, such as when the collMod
        // command adds or removes options from a collection or view
        // Requires `showExpandedEvents=true` in the watch call
        //
        // from: 6.0
        // see: https://www.mongodb.com/docs/manual/reference/change-events/modify/#mongodb-data-modify
        return [];

      case 'refineCollectionShardKey':
        // Occurs when a collection's shard key is modified
        //
        // from: 6.1
        // see: https://www.mongodb.com/docs/manual/reference/change-events/refineCollectionShardKey/#mongodb-data-refineCollectionShardKey
        return [];

      case 'shardCollection':
        // Occurs when a collection is sharded
        // Requires `showExpandedEvents=true` in the watch call
        //
        // from: 6.0
        // see: https://www.mongodb.com/docs/manual/reference/change-events/shardCollection/#mongodb-data-shardCollection
        return [];

      case 'reshardCollection':
        // Occurs when the shard key for a collection and the distribution of data changes
        // Requires `showExpandedEvents=true` in the watch call
        //
        // from: 6.1
        // see: https://www.mongodb.com/docs/manual/reference/change-events/reshardCollection/#mongodb-data-reshardCollection
        return [];

      case 'rename':
        // Occurs when a collection is renamed
        //
        // see: https://www.mongodb.com/docs/manual/reference/change-events/rename/#mongodb-data-rename
        return [];

      //#endregion Implement

      // exhaustive check
      default:
        doc satisfies never;
        throw new Error(`Unexpected message type ${stringify(doc)}`);
    }
  }

  //#region Change Stream Event Handlers

  /**
   * Generates downstream changes for mongo insert change stream event
   *
   * An `insert` event occurs when an operation adds documents to a collection.
   *
   * @param doc The change stream document
   * @see {@link https://www.mongodb.com/docs/manual/reference/change-events/insert/#mongodb-data-insert Insert Change Stream Event }
   *
   */
  #makeInsertChanges(doc: ChangeStreamInsertDocument): ChangeStreamData[] {
    return [
      [
        'data',
        {
          tag: 'insert',
          new: doc.fullDocument,
          relation: relationFromChangeStreamEvent(doc),
        },
      ],
    ];
  }

  /**
   * Generates downstream changes for an `update` change stream event
   *
   * An `update` event occurs when an operation updates a document in a collection
   *
   * @param doc The change stream document
   * @see {@link https://www.mongodb.com/docs/manual/reference/change-events/update/#mongodb-data-update Update Change Stream Event}
   */
  #makeUpdateChanges(doc: ChangeStreamUpdateDocument): ChangeStreamData[] {
    return [
      [
        'data',
        {
          tag: 'update',
          key: doc.documentKey,
          old: doc.fullDocumentBeforeChange!, // TODO: validate pre-image presence
          new: doc.fullDocument!,
          relation: relationFromChangeStreamEvent(doc),
        },
      ],
    ];
  }

  /**
   * Generates downstream changes for a `replace` change stream event
   *
   * A `replace` event occurs when an update operation removes a document from a
   * collection and replaces it with a new document, such as when the
   * `replaceOne` method is called.
   *
   * @param doc The change stream document
   * @see {@link https://www.mongodb.com/docs/manual/reference/change-events/replace/#mongodb-data-replace Replace Change Stream Event}
   */
  #makeReplaceChanges(doc: ChangeStreamReplaceDocument): ChangeStreamData[] {
    const relation = relationFromChangeStreamEvent(doc);

    return [
      // first delete the old document
      [
        'data',
        {
          tag: 'delete',
          key: doc.documentKey,
          relation,
        } satisfies MessageDelete,
      ],

      // then insert the new document
      [
        'data',
        {
          tag: 'insert',
          new: doc.fullDocument!,
          relation,
        } satisfies MessageInsert,
      ],
    ];
  }

  /**
   * Generates downstream changes for a `delete` change stream event
   *
   * A `delete` event occurs when operations remove documents from a collection,
   * such as when a user or application executes the delete command.
   *
   * @param doc The change stream document
   * @see {@link https://www.mongodb.com/docs/manual/reference/change-events/delete/#mongodb-data-delete Delete Change Stream Event}
   */
  #makeDeleteChanges(doc: ChangeStreamDeleteDocument): ChangeStreamData[] {
    assert(doc.documentKey);

    return [
      [
        'data',
        {
          tag: 'delete',
          key: doc.documentKey,
          relation: relationFromChangeStreamEvent(doc),
        } satisfies MessageDelete,
      ],
    ];
  }

  //#endregion Change Stream Event Handlers

  //   #preSchema: PublishedSchema | undefined;

  //   #handleCustomMessage(msg: MessageMessage) {
  //     const event = this.#parseReplicationEvent(msg.content);
  //     if (event.type === 'ddlStart') {
  //       // Store the schema in order to diff it with a potential ddlUpdate.
  //       this.#preSchema = event.schema;
  //       return [];
  //     }
  //     // ddlUpdate
  //     const changes = this.#makeSchemaChanges(
  //       must(this.#preSchema, `ddlUpdate received without a ddlStart`),
  //       event,
  //     ).map(change => ['data', change] satisfies Data);

  //     this.#lc
  //       .withContext('query', event.context.query)
  //       .info?.(`${changes.length} schema change(s)`, changes);

  //     return changes;
  //   }

  //   /**
  //    *  A note on operation order:
  //    *
  //    * Postgres will drop related indexes when columns are dropped,
  //    * but SQLite will error instead (https://sqlite.org/forum/forumpost/2e62dba69f?t=c&hist).
  //    * The current workaround is to drop indexes first.
  //    *
  //    * More generally, the order of replicating DDL updates is:
  //    * - drop indexes
  //    * - alter tables
  //    * - drop tables
  //    * - create tables
  //    * - create indexes
  //    *
  //    * In the future the replication logic should be improved to handle this
  //    * behavior in SQLite by dropping dependent indexes manually before dropping
  //    * columns. This, for example, would be needed to properly support changing
  //    * the type of a column that's indexed.
  //    */
  //   #makeSchemaChanges(
  //     preSchema: PublishedSchema,
  //     update: DdlUpdateEvent,
  //   ): DataChange[] {
  //     const [prevTables, prevIndexes] = specsByName(preSchema);
  //     const [nextTables, nextIndexes] = specsByName(update.schema);
  //     const {tag} = update.event;
  //     const changes: DataChange[] = [];

  //     // Validate the new table schemas
  //     for (const table of nextTables.values()) {
  //       validate(this.#lc, this.#shardID, table);
  //     }

  //     const [dropped, created] = symmetricDifferences(prevIndexes, nextIndexes);

  //     // Drop indexes first so that allow dropping dependent objects.
  //     for (const id of dropped) {
  //       const {schema, name} = must(prevIndexes.get(id));
  //       changes.push({tag: 'drop-index', id: {schema, name}});
  //     }

  //     if (tag === 'ALTER PUBLICATION') {
  //       const tables = intersection(prevTables, nextTables);
  //       for (const id of tables) {
  //         changes.push(
  //           ...this.#getAddedOrDroppedColumnChanges(
  //             must(prevTables.get(id)),
  //             must(nextTables.get(id)),
  //           ),
  //         );
  //       }
  //     } else if (tag === 'ALTER TABLE') {
  //       const altered = idString(update.event.table);
  //       const table = must(nextTables.get(altered));
  //       const prevTable = prevTables.get(altered);
  //       if (!prevTable) {
  //         // table rename. Find the old name.
  //         let old: Identifier | undefined;
  //         for (const [id, {schema, name}] of prevTables.entries()) {
  //           if (!nextTables.has(id)) {
  //             old = {schema, name};
  //             break;
  //           }
  //         }
  //         if (!old) {
  //           throw new Error(`can't find previous table: ${stringify(update)}`);
  //         }
  //         changes.push({tag: 'rename-table', old, new: table});
  //       } else {
  //         changes.push(...this.#getSingleColumnChange(prevTable, table));
  //       }
  //     }

  //     // Added/dropped tables are handled in the same way for most DDL updates, with
  //     // the exception being `ALTER TABLE`, for which a table rename should not be
  //     // confused as a drop + add.
  //     if (tag !== 'ALTER TABLE') {
  //       const [dropped, created] = symmetricDifferences(prevTables, nextTables);
  //       for (const id of dropped) {
  //         const {schema, name} = must(prevTables.get(id));
  //         changes.push({tag: 'drop-table', id: {schema, name}});
  //       }
  //       for (const id of created) {
  //         const spec = must(nextTables.get(id));
  //         changes.push({tag: 'create-table', spec});
  //       }
  //     }

  //     // Add indexes last since they may reference tables / columns that need
  //     // to be created first.
  //     for (const id of created) {
  //       const spec = must(nextIndexes.get(id));
  //       changes.push({tag: 'create-index', spec});
  //     }
  //     return changes;
  //   }

  //   // ALTER PUBLICATION can only add and drop columns, but never change them.
  //   #getAddedOrDroppedColumnChanges(
  //     oldTable: TableSpec,
  //     newTable: TableSpec,
  //   ): DataChange[] {
  //     const table = {schema: newTable.schema, name: newTable.name};
  //     const [dropped, added] = symmetricDifferences(
  //       new Set(Object.keys(oldTable.columns)),
  //       new Set(Object.keys(newTable.columns)),
  //     );

  //     const changes: DataChange[] = [];
  //     for (const column of dropped) {
  //       changes.push({tag: 'drop-column', table, column});
  //     }
  //     for (const name of added) {
  //       changes.push({
  //         tag: 'add-column',
  //         table,
  //         column: {name, spec: newTable.columns[name]},
  //       });
  //     }

  //     return changes;
  //   }

  //   // ALTER TABLE can add, drop, or change/rename a single column.
  //   #getSingleColumnChange(
  //     oldTable: TableSpec,
  //     newTable: TableSpec,
  //   ): DataChange[] {
  //     const table = {schema: newTable.schema, name: newTable.name};
  //     const [d, a] = symmetricDifferences(
  //       new Set(Object.keys(oldTable.columns)),
  //       new Set(Object.keys(newTable.columns)),
  //     );
  //     const dropped = [...d];
  //     const added = [...a];
  //     assert(
  //       dropped.length <= 1 && added.length <= 1,
  //       `too many dropped [${[dropped]}] or added [${[added]}] columns`,
  //     );
  //     if (dropped.length === 1 && added.length === 1) {
  //       const oldName = dropped[0];
  //       const newName = added[0];
  //       return [
  //         {
  //           tag: 'update-column',
  //           table,
  //           old: {name: oldName, spec: oldTable.columns[oldName]},
  //           new: {name: newName, spec: newTable.columns[newName]},
  //         },
  //       ];
  //     } else if (added.length) {
  //       const name = added[0];
  //       return [
  //         {
  //           tag: 'add-column',
  //           table,
  //           column: {name, spec: newTable.columns[name]},
  //         },
  //       ];
  //     } else if (dropped.length) {
  //       return [{tag: 'drop-column', table, column: dropped[0]}];
  //     }
  //     // Not a rename, add, or drop. Find the column with a relevant update.
  //     for (const [name, oldSpec] of Object.entries(oldTable.columns)) {
  //       const newSpec = newTable.columns[name];
  //       // Besides the name, we only care about the data type.
  //       // Default values and constraints are not relevant.
  //       if (oldSpec.dataType !== newSpec.dataType) {
  //         return [
  //           {
  //             tag: 'update-column',
  //             table,
  //             old: {name, spec: oldSpec},
  //             new: {name, spec: newSpec},
  //           },
  //         ];
  //       }
  //     }
  //     return [];
  //   }

  //   #parseReplicationEvent(content: Uint8Array) {
  //     const str =
  //       content instanceof Buffer
  //         ? content.toString('utf-8')
  //         : new TextDecoder().decode(content);
  //     const json = JSON.parse(str);
  //     return v.parse(json, replicationEventSchema, 'passthrough');
  //   }

  //   /**
  //    * If `ddlDetection === true`, relation messages are irrelevant,
  //    * as schema changes are detected by event triggers that
  //    * emit custom messages.
  //    *
  //    * For degraded-mode replication (`ddlDetection === false`):
  //    * 1. query the current published schemas on upstream
  //    * 2. compare that with the InternalShardConfig.initialSchema
  //    * 3. compare that with the incoming MessageRelation
  //    * 4. On any discrepancy, throw an UnsupportedSchemaChangeError
  //    *    to halt replication.
  //    *
  //    * Note that schemas queried in step [1] will be *post-transaction*
  //    * schemas, which are not necessarily suitable for actually processing
  //    * the statements in the transaction being replicated. In other words,
  //    * this mechanism cannot be used to reliably *replicate* schema changes.
  //    * However, they serve the purpose determining if schemas have changed.
  //    */
  //   async #handleRelation(rel: MessageRelation): Promise<ChangeStreamData[]> {
  //     const {publications, ddlDetection, initialSchema} = this.#shardConfig;
  //     if (ddlDetection) {
  //       return [];
  //     }
  //     assert(initialSchema); // Written in initial-sync
  //     const currentSchema = await getPublicationInfo(
  //       this.#upstream.db,
  //       publications,
  //     );
  //     if (schemasDifferent(initialSchema, currentSchema, this.#lc)) {
  //       throw new UnsupportedSchemaChangeError();
  //     }
  //     // Even if the currentSchema is equal to the initialSchema, the
  //     // MessageRelation itself must be checked to detect transient
  //     // schema changes within the transaction (e.g. adding and dropping
  //     // a table, or renaming a column and then renaming it back).
  //     const orel = initialSchema.tables.find(t => t.oid === rel.relationOid);
  //     if (!orel) {
  //       // Can happen if a table is created and then dropped in the same transaction.
  //       this.#lc.info?.(`relation not in initialSchema: ${stringify(rel)}`);
  //       throw new UnsupportedSchemaChangeError();
  //     }
  //     if (relationDifferent(orel, rel)) {
  //       this.#lc.info?.(
  //         `relation has changed within the transaction: ${stringify(orel)}`,
  //         rel,
  //       );
  //       throw new UnsupportedSchemaChangeError();
  //     }
  //     return [];
  //   }
}

function relationFromChangeStreamEvent(
  doc:
    | ChangeStreamInsertDocument
    | ChangeStreamUpdateDocument
    | ChangeStreamReplaceDocument
    | ChangeStreamDeleteDocument,
): MessageRelation {
  return {
    tag: 'relation',
    keyColumns: ['_id'], // mongo uses _id as the primary key unless explicitly disabled
    replicaIdentity: 'default',
    schema: 'default', // mongo doesn't have namespaces (schemas)
    name: doc.ns.coll,
  };
}
