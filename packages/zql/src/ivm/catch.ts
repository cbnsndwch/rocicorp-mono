import {unreachable} from '../../../shared/src/asserts.js';
import type {Change} from './change.js';
import type {Node} from './data.js';
import type {FetchRequest, Input, Output} from './operator.js';

/**
 * Catch is an Output that collects all incoming stream data into arrays. Mainly
 * useful for testing.
 */
export class Catch implements Output {
  #input: Input;
  readonly pushes: Change[] = [];

  constructor(input: Input) {
    this.#input = input;
    input.setOutput(this);
  }

  fetch(req: FetchRequest = {}) {
    return [...this.#input.fetch(req)].map(expandNode);
  }

  cleanup(req: FetchRequest = {}) {
    return [...this.#input.cleanup(req)].map(expandNode);
  }

  push(change: Change) {
    this.pushes.push(expandChange(change));
  }

  reset() {
    this.pushes.length = 0;
  }

  destroy() {
    this.#input.destroy();
  }
}

export function expandChange(change: Change): Change {
  switch (change.type) {
    case 'add':
    case 'remove':
      return {
        ...change,
        node: expandNode(change.node),
      };
    case 'edit':
      // No generators to expand in edit changes.
      return change;
    case 'child':
      return {
        ...change,
        child: {
          ...change.child,
          change: expandChange(change.child.change),
        },
      };
    default:
      unreachable(change);
  }
}

export function expandNode(node: Node): Node {
  return {
    ...node,
    relationships: Object.fromEntries(
      Object.entries(node.relationships).map(([k, v]) => [
        k,
        [...v].map(expandNode),
      ]),
    ),
  };
}