/* eslint-disable no-console */
import '@dotenvx/dotenvx/config';

import {consoleLogSink, LogContext} from '@rocicorp/logger';
import {must} from '../../../shared/src/must.ts';
import {parseOptions} from '../../../shared/src/options.ts';
import * as v from '../../../shared/src/valita.ts';
import {transformAndHashQuery} from '../auth/read-authorizer.ts';
import {ZERO_ENV_VAR_PREFIX} from '../config/zero-config.ts';
import {pgClient} from '../types/pg.ts';
import {
  deployPermissionsOptions,
  loadSchemaAndPermissions,
} from './permissions.ts';

const options = {
  cvr: {db: v.string()},
  schema: deployPermissionsOptions.schema,
  debug: {
    hash: {
      type: v.string().optional(),
      desc: ['Hash of the query to fetch the AST for.'],
    },
  },
};

const config = parseOptions(
  options,
  process.argv.slice(2),
  ZERO_ENV_VAR_PREFIX,
);

const lc = new LogContext('debug', {}, consoleLogSink);
const {permissions} = await loadSchemaAndPermissions(lc, config.schema.path);

const cvrDB = pgClient(
  new LogContext('debug', undefined, consoleLogSink),
  config.cvr.db,
);

const rows =
  await cvrDB`select "clientAST", "internal" from "cvr"."queries" where "queryHash" = ${must(
    config.debug.hash,
  )} limit 1;`;

lc.info?.(
  JSON.stringify(
    transformAndHashQuery(
      lc,
      rows[0].clientAST,
      permissions,
      {},
      rows[0].internal,
    ).query,
  ),
);

await cvrDB.end();
