import * as v from 'shared/src/valita.js';
import {astSchema} from 'zero-protocol';
import {jsonValueSchema} from './bigint-json.js';
import {
  versionFromLexi,
  versionToLexi,
} from 'zqlite-zero-cache-shared/src/lexi-version.js';

export const cvrVersionSchema = v.object({
  /**
   * The database `stateVersion` with which the rows in the CVR are consistent.
   */
  stateVersion: v.string(), // LexiVersion

  /**
   * `minorVersion` is subversion of `stateVersion` that is initially absent for each
   * `stateVersion`, and incremented for configuration changes that affect the contents
   * of the CVR such as:
   *
   * * client set changes
   * * query set changes
   * * query transformation changes (which may happen for changes
   *   in server-side logic or authorization policies)
   *
   * Such configuration changes are always correlated with a change to one or more
   * `/meta/...` records in the CVR, often (but not always) with corresponding
   * patches in `/patches/meta/...`.
   *
   * When the `stateVersion` moves forward, the `minorVersion` is reset to absent.
   * In this manner it behaves like the analogous concept in semantic versioning.
   */
  minorVersion: v.number().optional(),
});

export type CVRVersion = v.Infer<typeof cvrVersionSchema>;

export function oneAfter(v: NullableCVRVersion): CVRVersion {
  return v === null
    ? {stateVersion: versionToLexi(0)}
    : {
        stateVersion: v.stateVersion,
        minorVersion: (v.minorVersion ?? 0) + 1,
      };
}

export type NullableCVRVersion = CVRVersion | null;

export function cmpVersions(
  a: NullableCVRVersion,
  b: NullableCVRVersion,
): number {
  return a === null && b === null
    ? 0
    : a === null
    ? -1
    : b === null
    ? 1
    : a.stateVersion < b.stateVersion
    ? -1
    : a.stateVersion > b.stateVersion
    ? 1
    : (a.minorVersion ?? 0) - (b.minorVersion ?? 0);
}

export function versionToCookie(v: CVRVersion): string {
  return versionString(v);
}

export function versionToNullableCookie(v: NullableCVRVersion): string | null {
  return v === null ? null : versionToCookie(v);
}

export function cookieToVersion(cookie: string | null): NullableCVRVersion {
  if (cookie === null) {
    return null;
  }
  return versionFromString(cookie);
}

// Last Active tracking.

export const lastActiveSchema = v.object({epochMillis: v.number()});
export type LastActive = v.Infer<typeof lastActiveSchema>;

export const cvrIDSchema = v.object({id: v.string()});
export type CvrID = v.Infer<typeof cvrIDSchema>;

const cvrRecordSchema = v.object({
  /**
   * CVR records store the CVRVersion at which the record was last patched into
   * the CVR, which corresponds with a patch row that is cleaned up when the
   * record is changed (updated, deleted, and re-added in the case of rows).
   *
   * Tombstones are stored for row records but not for config records. This means
   * that "orphaned" delete patches for config records may exist, and therefore
   * scans of config patches must always run until the end of the list. On the
   * contrary, for row patches, the row record tombstones allow cleanup of delete
   * patches.
   */
  patchVersion: cvrVersionSchema,
});

export const clientRecordSchema = cvrRecordSchema.extend({
  /** The client ID, of which there can be multiple for a client group view. */
  id: v.string(),

  /** The client's desired query IDs. Patch information is stored in the QueryRecord. */
  desiredQueryIDs: v.array(v.string()),
});

export type ClientRecord = v.Infer<typeof clientRecordSchema>;

export const baseQueryRecordSchema = v.object({
  /** The client-specified ID used to identify this query. Typically a hash. */
  id: v.string(),

  /** The original AST as supplied by the client. */
  ast: astSchema,

  /**
   * The hash of the query after server-side transformations, which include:
   *
   * * Normalization (which may differ from what the client does)
   * * Query "expansion" to include primary keys and query-execution-related columns
   * * Authorization transforms
   *
   * Transformations depend on conditions that are independent of the db state version,
   * such as server-side logic and authorization policies. As such, the version of a CVR
   * version may need to be advanced independent of db state changes. This is done
   * via the `minorVersion` counter of the CVRVersion object, which is used to account
   * for both changes to the query set and changes to query transformations (which are
   * effectively remove-old-query + add-new-query).
   *
   * Note that the transformed AST itself is **not** stored, as the result of the previous
   * transformation is not useful in and of itself. If the current transformation results in
   * a different hash than that of the transformation used for the last version of the CVR,
   * it is simply handled by invalidating the existing rows, re-executed the query with
   * the new transformation, and advancing the CVR's `minorVersion` and this query's
   * `transformationVersion`.
   *
   * Note that the transformationHash is only stored when the query has reached the "gotten"
   * state. If the query is in the "desired" but not yet "gotten" state, the field is absent.
   */
  transformationHash: v.string().optional(),

  /**
   * The CVR version corresponding to the `transformationHash`. This essentially tracks when
   * this version of the query was effectively added to the CVR (as opposed to the
   * `patchVersion`, which is simply when the client was notified that its query was added
   * to the gotten set). Catchup of clients from old CVR versions require executing all
   * queries with a newer `transformationVersion`.
   */
  transformationVersion: cvrVersionSchema.optional(),
});

/**
 * Internal queries track rows in the database for internal use, such as the
 * `lastMutationID`s in the `zero.clients` table. They participate in the standard
 * invalidation / update logic for row contents, but not in the desired/got or
 * size-based quota logic for client-requested queries.
 */
export const internalQueryRecordSchema = baseQueryRecordSchema.extend({
  internal: v.literal(true),
});

export type InternalQueryRecord = v.Infer<typeof internalQueryRecordSchema>;

export const clientQueryRecordSchema = baseQueryRecordSchema.extend({
  internal: v.literal(false).optional(),

  // For queries, the `patchVersion` indicates when query was added to the got set,
  // and is absent if not yet gotten.
  patchVersion: cvrVersionSchema.optional(),

  // Maps each of the desiring client's IDs to the version at which
  // the queryID was added to their desired query set (i.e. individual `patchVersion`s).
  desiredBy: v.record(cvrVersionSchema),

  // TODO: Iron this out.
  // estimatedBytes: v.number(),
  // lru information?
});

export type ClientQueryRecord = v.Infer<typeof clientQueryRecordSchema>;

export const queryRecordSchema = v.union(
  clientQueryRecordSchema,
  internalQueryRecordSchema,
);

export type QueryRecord = v.Infer<typeof queryRecordSchema>;

export const rowIDSchema = v.object({
  schema: v.string(),
  table: v.string(),
  rowKey: v.record(jsonValueSchema),
});

export const metaRecordSchema = v.union(
  cvrVersionSchema,
  lastActiveSchema,
  clientRecordSchema,
  queryRecordSchema,
);

// Union type of rows under "/meta/..."x" for fetching all rows in a single list() call.
export type MetaRecord = v.Infer<typeof metaRecordSchema>;

export type RowID = v.Infer<typeof rowIDSchema>;

export const rowRecordSchema = cvrRecordSchema.extend({
  id: rowIDSchema,
  rowVersion: v.string(), // '_0_version' of the row
  // column => query IDs, or `null` for a row that was removed from the view (i.e. tombstone).
  queriedColumns: v.record(v.array(v.string())).nullable(),
});

export type RowRecord = v.Infer<typeof rowRecordSchema>;

export const patchSchema = v.object({
  type: v.union(v.literal('client'), v.literal('row'), v.literal('query')),
  op: v.union(v.literal('put'), v.literal('del')),
});

export const putRowPatchSchema = patchSchema.extend({
  type: v.literal('row'),
  op: v.literal('put'),
  id: rowIDSchema,
  rowVersion: v.string(), // '_0_version' of the row
  columns: v.array(v.string()),
});

export const delRowPatchSchema = patchSchema.extend({
  type: v.literal('row'),
  op: v.literal('del'),
  id: rowIDSchema,
});

export const rowPatchSchema = v.union(putRowPatchSchema, delRowPatchSchema);

export type RowPatch = v.Infer<typeof rowPatchSchema>;

export const queryPatchSchema = patchSchema.extend({
  type: v.literal('query'),
  id: v.string(),
  clientID: v.string().optional(), // defined for "desired", undefined for "got"
});

export type QueryPatch = v.Infer<typeof queryPatchSchema>;

export type PutQueryPatch = QueryPatch & {op: 'put'};
export type DelQueryPatch = QueryPatch & {op: 'del'};

export const clientPatchSchema = patchSchema.extend({
  type: v.literal('client'),
  id: v.string(),
});

export type ClientPatch = v.Infer<typeof clientPatchSchema>;

export const metadataPatchSchema = v.union(clientPatchSchema, queryPatchSchema);

export type MetadataPatch = v.Infer<typeof metadataPatchSchema>;

export function versionString(v: CVRVersion) {
  // The separator (e.g. ":") needs to be lexicographically greater than the
  // storage key path separator (e.g. "/") so that "01/row-hash" is less than "01:01/row-hash".
  // In particular, the traditional separator for major.minor versions (".") does not
  // satisfy this quality.
  return v.minorVersion
    ? `${v.stateVersion}:${versionToLexi(v.minorVersion)}`
    : v.stateVersion;
}

export function versionFromString(str: string): CVRVersion {
  const parts = str.split(':');
  const stateVersion = parts[0];
  switch (parts.length) {
    case 1: {
      versionFromLexi(stateVersion); // Purely for validation.
      return {stateVersion};
    }
    case 2: {
      const minorVersion = versionFromLexi(parts[1]);
      if (minorVersion > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`minorVersion ${parts[1]} exceeds max safe integer`);
      }
      return {stateVersion, minorVersion: Number(minorVersion)};
    }
    default:
      throw new TypeError(`Invalid version string ${str}`);
  }
}