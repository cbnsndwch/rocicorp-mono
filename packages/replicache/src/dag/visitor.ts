import type {Hash} from '../hash.ts';
import type {Chunk} from './chunk.ts';
import type {MustGetChunk} from './store.ts';

/**
 * A visitor walks the DAG starting at a given root and visits each chunk.
 */
export class Visitor {
  #seen: Set<Hash> = new Set();
  #dagRead: MustGetChunk;

  constructor(dagRead: MustGetChunk) {
    this.#dagRead = dagRead;
  }

  async visit(h: Hash) {
    if (this.#seen.has(h)) {
      return;
    }
    this.#seen.add(h);
    const chunk = await this.#dagRead.mustGetChunk(h);
    await this.visitChunk(chunk);
  }

  async visitChunk(chunk: Chunk<unknown>) {
    await Promise.all(chunk.meta.map(ref => this.visit(ref)));
  }
}
