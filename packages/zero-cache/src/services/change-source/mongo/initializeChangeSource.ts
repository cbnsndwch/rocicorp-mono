import type {LogContext} from '@rocicorp/logger';

import {Database} from '../../../../../zqlite/src/db.js';
import {StatementRunner} from '../../../db/statements.js';
import {getSubscriptionState} from '../../replicator/schema/replication-state.js';

import type {ChangeSource} from '../../change-streamer/change-streamer-service.js';
import {type ReplicationConfig} from '../../change-streamer/schema/tables.js';

import {MongoChangeSource} from './change-source.js';
// import {initSyncSchema} from './sync-schema.js';

// import type {InitialSyncOptions} from './initial-sync.js';
// import type {ShardConfig} from './shard-config.js';

/**
 * Initializes a MongoDB change source, including the initial sync of the
 * replica, before streaming changes from the corresponding logical replication
 * stream.
 */

export function initializeChangeSource(
  lc: LogContext,
  upstreamURI: string,
  //   shard: ShardConfig,
  replicaDbFile: string,
  //   syncOptions: InitialSyncOptions,
): {replicationConfig: ReplicationConfig; changeSource: ChangeSource} {
  //   await initSyncSchema(
  //     lc,
  //     `replica-${shard.id}`,
  //     shard,
  //     replicaDbFile,
  //     upstreamURI,
  //     syncOptions,
  //   );

  const replica = new Database(lc, replicaDbFile);
  const replicationConfig = getSubscriptionState(new StatementRunner(replica));
  replica.close();

  //   if (shard.publications.length) {
  //     // Verify that the publications match what has been synced.
  //     const requested = [...shard.publications].sort();
  //     const replicated = replicationConfig.publications
  //       .filter(p => !p.startsWith(INTERNAL_PUBLICATION_PREFIX))
  //       .sort();
  //     if (!deepEqual(requested, replicated)) {
  //       throw new Error(
  //         `Invalid ShardConfig. Requested publications [${requested}] do not match synced publications: [${replicated}]`,
  //       );
  //     }
  //   }

  const changeSource = new MongoChangeSource(lc, upstreamURI);

  return {replicationConfig, changeSource};
}
