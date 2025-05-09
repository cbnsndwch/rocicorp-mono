import type {LogContext, LogLevel} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import {ChildProcess, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {must} from '../../../../shared/src/must.ts';
import {sleep} from '../../../../shared/src/sleep.ts';
import type {ZeroConfig} from '../../config/zero-config.ts';

type ZeroLitestreamConfig = Pick<
  ZeroConfig,
  'port' | 'log' | 'replica' | 'litestream'
>;

/**
 * @returns The time in milliseconds it took for the successful restore
 *          (i.e. not counting failed attempts).
 */
export async function restoreReplica(
  lc: LogContext,
  config: ZeroLitestreamConfig,
  maxRetries: number,
  retryIntervalMs = 3000,
): Promise<number | undefined> {
  for (let i = 0; i < maxRetries; i++) {
    if (i > 0) {
      lc.info?.(
        `replica not found. retrying in ${retryIntervalMs / 1000} seconds`,
      );
      await sleep(retryIntervalMs);
    }
    const start = Date.now();
    const restored = await tryRestore(config);
    if (restored) {
      return Date.now() - start;
    }
    if (maxRetries === 1) {
      lc.info?.('no litestream backup found');
      return undefined;
    }
  }
  throw new Error(`max attempts exceeded restoring replica`);
}

function getLitestream(
  config: ZeroLitestreamConfig,
  logLevelOverride?: LogLevel,
): {
  litestream: string;
  env: NodeJS.ProcessEnv;
} {
  const {
    executable,
    backupURL,
    logLevel,
    configPath,
    port = config.port + 2,
    checkpointThresholdMB,
    incrementalBackupIntervalMinutes,
    snapshotBackupIntervalHours,
  } = config.litestream;

  // Set the snapshot interval to something smaller than x hours so that
  // the hourly check triggers on the hour, rather than the hour after.
  const snapshotBackupIntervalMinutes = snapshotBackupIntervalHours * 60 - 5;
  const minCheckpointPageCount = checkpointThresholdMB * 250; // SQLite page size is 4k
  const maxCheckpointPageCount = minCheckpointPageCount * 10;

  return {
    litestream: must(executable, `Missing --litestream-executable`),
    env: {
      ...process.env,
      ['ZERO_REPLICA_FILE']: config.replica.file,
      ['ZERO_LITESTREAM_BACKUP_URL']: must(backupURL),
      ['ZERO_LITESTREAM_MIN_CHECKPOINT_PAGE_COUNT']: String(
        minCheckpointPageCount,
      ),
      ['ZERO_LITESTREAM_MAX_CHECKPOINT_PAGE_COUNT']: String(
        maxCheckpointPageCount,
      ),
      ['ZERO_LITESTREAM_INCREMENTAL_BACKUP_INTERVAL_MINUTES']: String(
        incrementalBackupIntervalMinutes,
      ),
      ['ZERO_LITESTREAM_LOG_LEVEL']: logLevelOverride ?? logLevel,
      ['ZERO_LITESTREAM_SNAPSHOT_BACKUP_INTERVAL_MINUTES']: String(
        snapshotBackupIntervalMinutes,
      ),
      ['ZERO_LOG_FORMAT']: config.log.format,
      ['LITESTREAM_CONFIG']: configPath,
      ['LITESTREAM_PORT']: String(port),
    },
  };
}

async function tryRestore(config: ZeroLitestreamConfig) {
  // The log output for litestream restore is minimal. Include it all.
  const {litestream, env} = getLitestream(config, 'debug');
  const {
    restoreParallelism: parallelism,
    multipartConcurrency,
    multipartSize,
  } = config.litestream;
  const multipartArgs =
    multipartConcurrency === 0 || multipartSize === 0
      ? []
      : [
          '-multipart-concurrency',
          multipartConcurrency.toString(),
          '-multipart-size',
          multipartSize.toString(),
        ];
  const proc = spawn(
    litestream,
    [
      'restore',
      '-if-db-not-exists',
      '-if-replica-exists',
      '-parallelism',
      String(parallelism),
      ...multipartArgs,
      config.replica.file,
    ],
    {env, stdio: 'inherit', windowsHide: true},
  );
  const {promise, resolve, reject} = resolver();
  proc.on('error', reject);
  proc.on('close', (code, signal) => {
    if (signal) {
      reject(`litestream killed with ${signal}`);
    } else if (code !== 0) {
      reject(`litestream exited with code ${code}`);
    } else {
      resolve();
    }
  });
  await promise;
  return existsSync(config.replica.file);
}

export function startReplicaBackupProcess(
  config: ZeroLitestreamConfig,
): ChildProcess {
  const {litestream, env} = getLitestream(config);
  return spawn(litestream, ['replicate'], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
}
