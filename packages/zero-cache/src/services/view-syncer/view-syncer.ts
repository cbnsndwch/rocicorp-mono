import type {LogContext} from '@rocicorp/logger';
import * as v from 'shared/src/valita.js';
import type {InvalidationWatcher} from '../invalidation-watcher/invalidation-watcher.js';
import type {Service} from '../service.js';
import type {Storage} from './storage/storage.js';

export const viewShapeUpdateSchema = v.object({
  // TODO: Define
});

export type ViewShapeUpdate = v.Infer<typeof viewShapeUpdateSchema>;

export const viewContentsUpdateSchema = v.object({
  // TODO: Define
});

export type ViewContentsUpdate = v.Infer<typeof viewContentsUpdateSchema>;

export interface ViewSyncer {
  sync(
    shapeUpdates: AsyncIterable<ViewShapeUpdate>,
  ): AsyncIterable<ViewContentsUpdate>;
}

export class ViewSyncerService implements ViewSyncer, Service {
  readonly id: string;
  readonly #lc: LogContext;
  readonly #storage: Storage;
  readonly #watcher: InvalidationWatcher;

  constructor(
    lc: LogContext,
    clientGroupID: string,
    storage: Storage,
    watcher: InvalidationWatcher,
  ) {
    this.id = clientGroupID;
    this.#lc = lc
      .withContext('component', 'view-syncer')
      .withContext('serviceID', this.id);
    this.#storage = storage;
    this.#watcher = watcher;
  }

  run(): Promise<void> {
    // TODO: Implement
    this.#lc;
    this.#storage;
    this.#watcher;

    throw new Error('todo');
  }
  sync(
    _shapeUpdates: AsyncIterable<ViewShapeUpdate>,
  ): AsyncIterable<ViewContentsUpdate> {
    throw new Error('todo');
  }
  stop(): Promise<void> {
    throw new Error('todo');
  }
}