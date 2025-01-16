import {PG_ADMIN_SHUTDOWN} from '@drdgvhbh/postgres-error-codes';
import type {MessageRelation} from 'pg-logical-replication/dist/output-plugins/pgoutput/pgoutput.types.js';
import {DatabaseError} from 'pg-protocol';

import type {LogContext} from '@rocicorp/logger';

import type {ColumnSpec, PublishedTableSpec} from '../../../db/specs.js';
import {deepEqual} from '../../../../../shared/src/json.js';
import {stringify} from '../../../types/bigint-json.js';

import type {Identifier} from '../schema/change.js';

import type {PublishedSchema} from './schema/published.js';
import {ShutdownSignal} from './errors.js';

export const idString = (id: Identifier) => `${id.schema}.${id.name}`;

export function translateError(e: unknown): Error {
  if (!(e instanceof Error)) {
    return new Error(String(e));
  }
  if (e instanceof DatabaseError && e.code === PG_ADMIN_SHUTDOWN) {
    return new ShutdownSignal(e);
  }
  return e;
}

export function specsByName(published: PublishedSchema) {
  return [
    // It would have been nice to use a CustomKeyMap here, but we rely on set-utils
    // operations which use plain Sets.
    new Map(published.tables.map(t => [idString(t), t])),
    new Map(published.indexes.map(i => [idString(i), i])),
  ] as const;
}

// ColumnSpec comparator
export const byColumnPos = (
  a: [string, ColumnSpec],
  b: [string, ColumnSpec],
) => (a[1].pos < b[1].pos ? -1 : a[1].pos > b[1].pos ? 1 : 0);

export function schemasDifferent(
  a: PublishedSchema,
  b: PublishedSchema,
  lc?: LogContext,
) {
  // Note: ignore indexes since changes need not to halt replication
  return (
    a.tables.length !== b.tables.length ||
    a.tables.some((at, i) => {
      const bt = b.tables[i];
      if (tablesDifferent(at, bt)) {
        lc?.info?.(`table ${stringify(at)} has changed`, bt);
        return true;
      }
      return false;
    })
  );
}

export function tablesDifferent(a: PublishedTableSpec, b: PublishedTableSpec) {
  if (
    a.oid !== b.oid ||
    a.schema !== b.schema ||
    a.name !== b.name ||
    !deepEqual(a.primaryKey, b.primaryKey)
  ) {
    return true;
  }
  const acols = Object.entries(a.columns).sort(byColumnPos);
  const bcols = Object.entries(b.columns).sort(byColumnPos);
  return (
    acols.length !== bcols.length ||
    acols.some(([aname, acol], i) => {
      const [bname, bcol] = bcols[i];
      return (
        aname !== bname ||
        acol.pos !== bcol.pos ||
        acol.typeOID !== bcol.typeOID
      );
    })
  );
}

export function relationDifferent(a: PublishedTableSpec, b: MessageRelation) {
  if (
    a.oid !== b.relationOid ||
    a.schema !== b.schema ||
    a.name !== b.name ||
    !deepEqual(a.primaryKey, b.keyColumns)
  ) {
    return true;
  }
  const acols = Object.entries(a.columns).sort(byColumnPos);
  const bcols = b.columns;
  return (
    acols.length !== bcols.length ||
    acols.some(([aname, acol], i) => {
      const bcol = bcols[i];
      return aname !== bcol.name || acol.typeOID !== bcol.typeOid;
    })
  );
}
