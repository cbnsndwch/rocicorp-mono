import type {ChangeStreamDocument, ResumeToken} from 'mongodb';

import {AbortError} from '../../../../../shared/src/abort-error.js';

export type ReplicationError = {
  resumeToken: ResumeToken;
  err: unknown;
  lastLogTime: number;
  doc: ChangeStreamDocument;
};

export class ShutdownSignal extends AbortError {
  readonly name = 'ShutdownSignal';

  constructor(cause: unknown) {
    super(
      'shutdown signal received (e.g. another zero-cache taking over the replication stream)',
      {
        cause,
      },
    );
  }
}

export class SSLUnsupportedError extends Error {}

export class UnsupportedSchemaChangeError extends Error {
  readonly name = 'UnsupportedSchemaChangeError';

  constructor() {
    super(
      'Replication halted. Schema changes cannot be reliably replicated without event trigger support. Resync the replica to recover.',
    );
  }
}
