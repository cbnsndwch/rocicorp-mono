import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {StatementRunner} from 'zero-cache/src/db/statements.js';
import {DbFile, expectTables} from 'zero-cache/src/test/lite.js';
import {
  getReplicationVersions,
  getSubscriptionState,
  initReplicationState,
  updateReplicationWatermark,
} from './replication-state.js';

describe('replicator/schema/replication-state', () => {
  let dbFile: DbFile;
  let db: StatementRunner;

  beforeEach(() => {
    dbFile = new DbFile('replication_state_test');
    db = new StatementRunner(dbFile.connect());
    initReplicationState(db.db, ['zero_data', 'zero_metadata'], '0/0a');
  });

  afterEach(async () => {
    await dbFile.unlink();
  });

  test('initial replication state', () => {
    expectTables(db.db, {
      ['_zero.ReplicationConfig']: [
        {
          lock: 1,
          publications: '["zero_data","zero_metadata"]',
        },
      ],
      ['_zero.ReplicationState']: [
        {
          lock: 1,
          watermark: '0/0a',
          stateVersion: '00',
          nextStateVersion: '0a',
        },
      ],
    });
  });

  test('subscription state', () => {
    expect(getSubscriptionState(db)).toEqual({
      publications: ['zero_data', 'zero_metadata'],
      watermark: '0/0a',
    });
  });

  test('get versions', () => {
    expect(getReplicationVersions(db)).toEqual({
      stateVersion: '00',
      nextStateVersion: '0a',
    });
  });

  test('update watermark state', () => {
    updateReplicationWatermark(db, '0/0f');
    expectTables(db.db, {
      ['_zero.ReplicationState']: [
        {
          lock: 1,
          watermark: '0/0f',
          stateVersion: '0a',
          nextStateVersion: '0f',
        },
      ],
    });
    expect(getReplicationVersions(db)).toEqual({
      stateVersion: '0a',
      nextStateVersion: '0f',
    });
    expect(getSubscriptionState(db)).toEqual({
      publications: ['zero_data', 'zero_metadata'],
      watermark: '0/0f',
    });

    updateReplicationWatermark(db, '0/1b');
    expectTables(db.db, {
      ['_zero.ReplicationState']: [
        {
          lock: 1,
          watermark: '0/1b',
          stateVersion: '0f',
          nextStateVersion: '0r',
        },
      ],
    });
    expect(getReplicationVersions(db)).toEqual({
      stateVersion: '0f',
      nextStateVersion: '0r',
    });
    expect(getSubscriptionState(db)).toEqual({
      publications: ['zero_data', 'zero_metadata'],
      watermark: '0/1b',
    });
  });
});