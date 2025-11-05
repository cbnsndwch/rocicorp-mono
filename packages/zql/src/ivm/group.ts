import {assert} from '../../../shared/src/asserts.ts';
import type {Row, Value} from '../../../zero-protocol/src/data.ts';
import type {Change, EditChange} from './change.ts';
import type {Constraint} from './constraint.ts';
import {compareValues, type Node} from './data.ts';
import {
  throwOutput,
  type FetchRequest,
  type Input,
  type Operator,
  type Output,
  type Storage,
} from './operator.ts';
import type {SourceSchema} from './schema.ts';
import type {Stream} from './stream.ts';

/**
 * The Group operator groups rows by one or more fields and maintains
 * group state incrementally. It's the foundation for aggregation operations.
 *
 * This operator transforms input rows into groups, where each group is
 * identified by unique values of the grouping fields. The output includes
 * both the grouping fields and any aggregate values computed by downstream
 * operators.
 */
export class Group implements Operator {
  readonly #input: Input;
  readonly #storage: Storage;
  readonly #groupByFields: readonly string[];
  readonly #schema: SourceSchema;

  #output: Output = throwOutput;

  constructor(
    input: Input,
    storage: Storage,
    groupByFields: readonly string[],
  ) {
    assert(groupByFields.length > 0, 'Must specify at least one groupBy field');
    input.setOutput(this);
    this.#input = input;
    this.#storage = storage;
    this.#groupByFields = groupByFields;

    // The schema stays the same for now - we'll let Aggregate modify it
    this.#schema = input.getSchema();
  }

  setOutput(output: Output): void {
    this.#output = output;
  }

  getSchema(): SourceSchema {
    return this.#schema;
  }

  destroy(): void {
    this.#input.destroy();
  }

  *fetch(req: FetchRequest): Stream<Node> {
    // Group rows by the groupBy fields
    const groups = new Map<string, Node[]>();

    for (const node of this.#input.fetch(req)) {
      const groupKey = this.#getGroupKey(node.row);
      let group = groups.get(groupKey);
      if (!group) {
        group = [];
        groups.set(groupKey, group);
      }
      group.push(node);
    }

    // Emit one row per group with the grouping fields
    for (const [groupKey, nodes] of groups) {
      if (nodes.length === 0) continue;
      
      // Use the first node's grouping fields as the representative
      const groupRow = this.#extractGroupFields(nodes[0].row);
      
      yield {
        row: groupRow,
        relationships: {},
      };
    }
  }

  *cleanup(req: FetchRequest): Stream<Node> {
    // For cleanup, just pass through
    for (const node of this.#input.cleanup(req)) {
      const groupRow = this.#extractGroupFields(node.row);
      yield {
        row: groupRow,
        relationships: {},
      };
    }
  }

  push(change: Change): void {
    switch (change.type) {
      case 'add': {
        const groupKey = this.#getGroupKey(change.node.row);
        this.#incrementGroupCount(groupKey);
        
        // Only emit if this is the first row in the group
        const count = this.#getGroupCount(groupKey);
        if (count === 1) {
          const groupRow = this.#extractGroupFields(change.node.row);
          this.#output.push({
            type: 'add',
            node: {
              row: groupRow,
              relationships: {},
            },
          });
        }
        break;
      }
      case 'remove': {
        const groupKey = this.#getGroupKey(change.node.row);
        this.#decrementGroupCount(groupKey);
        
        // Only emit removal if this was the last row in the group
        const count = this.#getGroupCount(groupKey);
        if (count === 0) {
          const groupRow = this.#extractGroupFields(change.node.row);
          this.#output.push({
            type: 'remove',
            node: {
              row: groupRow,
              relationships: {},
            },
          });
        }
        break;
      }
      case 'edit': {
        const oldGroupKey = this.#getGroupKey(change.oldNode.row);
        const newGroupKey = this.#getGroupKey(change.node.row);

        if (oldGroupKey === newGroupKey) {
          // Row stayed in same group - no change to group structure
          break;
        }

        // Row moved to a different group
        this.#decrementGroupCount(oldGroupKey);
        this.#incrementGroupCount(newGroupKey);

        const oldCount = this.#getGroupCount(oldGroupKey);
        const newCount = this.#getGroupCount(newGroupKey);

        // Remove old group if it's now empty
        if (oldCount === 0) {
          const oldGroupRow = this.#extractGroupFields(change.oldNode.row);
          this.#output.push({
            type: 'remove',
            node: {
              row: oldGroupRow,
              relationships: {},
            },
          });
        }

        // Add new group if this is the first row
        if (newCount === 1) {
          const newGroupRow = this.#extractGroupFields(change.node.row);
          this.#output.push({
            type: 'add',
            node: {
              row: newGroupRow,
              relationships: {},
            },
          });
        }
        break;
      }
      case 'child':
        // Groups don't have child relationships
        break;
    }
  }

  #getGroupKey(row: Row): string {
    const values = this.#groupByFields.map(field => row[field]);
    return JSON.stringify(values);
  }

  #extractGroupFields(row: Row): Row {
    const groupRow: Row = {};
    for (const field of this.#groupByFields) {
      groupRow[field] = row[field];
    }
    return groupRow;
  }

  #getGroupCount(groupKey: string): number {
    return (this.#storage.get(groupKey) as number | undefined) ?? 0;
  }

  #incrementGroupCount(groupKey: string): void {
    const count = this.#getGroupCount(groupKey);
    this.#storage.set(groupKey, count + 1);
  }

  #decrementGroupCount(groupKey: string): void {
    const count = this.#getGroupCount(groupKey);
    if (count <= 1) {
      this.#storage.del(groupKey);
    } else {
      this.#storage.set(groupKey, count - 1);
    }
  }
}
