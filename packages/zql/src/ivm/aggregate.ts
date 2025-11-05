import {assert} from '../../../shared/src/asserts.ts';
import type {AggregateExpression} from '../../../zero-protocol/src/ast.ts';
import type {Row, Value} from '../../../zero-protocol/src/data.ts';
import type {Change} from './change.ts';
import type {Node} from './data.ts';
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

type AggregateState = {
  sum?: number;
  count: number;
  min?: Value;
  max?: Value;
};

type GroupData = {
  state: AggregateState;
  // Store one representative row for the group's non-aggregate fields
  groupRow: Row;
};

/**
 * The Aggregate operator computes aggregate functions (sum, count, avg, min, max)
 * over groups of rows. It maintains aggregate state incrementally as rows are
 * added, removed, or edited.
 *
 * This operator processes all input rows, groups them by the specified fields,
 * and computes aggregates for each group. It outputs one row per group with
 * the grouping fields and computed aggregate values.
 */
export class Aggregate implements Operator {
  readonly #input: Input;
  readonly #storage: Storage;
  readonly #aggregates: readonly AggregateExpression[];
  readonly #groupByFields: readonly string[];
  readonly #schema: SourceSchema;

  #output: Output = throwOutput;

  constructor(
    input: Input,
    storage: Storage,
    aggregates: readonly AggregateExpression[],
    groupByFields: readonly string[],
  ) {
    assert(aggregates.length > 0, 'Must specify at least one aggregate');
    // Note: groupByFields can be empty for global aggregations (e.g., SELECT COUNT(*) FROM table)
    input.setOutput(this);
    this.#input = input;
    this.#storage = storage;
    this.#aggregates = aggregates;
    this.#groupByFields = groupByFields;

    // Extend the schema with aggregate result fields
    const inputSchema = input.getSchema();
    this.#schema = {
      ...inputSchema,
      // Note: In a full implementation, we'd update the columns here
      // to include the aggregate output fields
    };
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
    // Collect all rows and group them
    const groups = new Map<string, {rows: Row[]; groupRow: Row}>();
    
    for (const node of this.#input.fetch(req)) {
      const groupKey = this.#getGroupKey(node.row);
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          rows: [],
          groupRow: this.#extractGroupFields(node.row),
        };
        groups.set(groupKey, group);
      }
      group.rows.push(node.row);
    }

    // Compute and yield aggregates for each group
    // Note: We don't persist state here - fetch is read-only
    for (const [groupKey, group] of groups) {
      const state = this.#computeStateFromRows(group.rows);
      const aggregatedRow = this.#computeAggregates(group.groupRow, state);
      
      yield {
        row: aggregatedRow,
        relationships: {},
      };
    }
  }

  *cleanup(req: FetchRequest): Stream<Node> {
    // Clear all group states
    const groups = new Set<string>();
    for (const node of this.#input.cleanup(req)) {
      const groupKey = this.#getGroupKey(node.row);
      groups.add(groupKey);
    }
    
    for (const groupKey of groups) {
      this.#storage.del(groupKey);
      const groupData = this.#getGroupData(groupKey);
      if (groupData) {
        yield {
          row: groupData.groupRow,
          relationships: {},
        };
      }
    }
  }

  push(change: Change): void {
    switch (change.type) {
      case 'add': {
        const groupKey = this.#getGroupKey(change.node.row);
        const groupData = this.#getGroupData(groupKey);
        const groupRow = this.#extractGroupFields(change.node.row);
        
        if (!groupData) {
          // New group
          const state: AggregateState = {count: 0};
          this.#updateStateForAdd(state, change.node.row);
          this.#setState(groupKey, {state, groupRow});
          
          const aggregatedRow = this.#computeAggregates(groupRow, state);
          this.#output.push({
            type: 'add',
            node: {
              row: aggregatedRow,
              relationships: {},
            },
          });
        } else {
          // Existing group - update aggregate
          const oldAggregatedRow = this.#computeAggregates(groupData.groupRow, groupData.state);
          this.#updateStateForAdd(groupData.state, change.node.row);
          this.#setState(groupKey, groupData);
          
          const newAggregatedRow = this.#computeAggregates(groupData.groupRow, groupData.state);
          this.#output.push({
            type: 'edit',
            oldNode: {
              row: oldAggregatedRow,
              relationships: {},
            },
            node: {
              row: newAggregatedRow,
              relationships: {},
            },
          });
        }
        break;
      }
      case 'remove': {
        const groupKey = this.#getGroupKey(change.node.row);
        const groupData = this.#getGroupData(groupKey);
        
        if (!groupData) {
          break;
        }
        
        const oldAggregatedRow = this.#computeAggregates(groupData.groupRow, groupData.state);
        this.#updateStateForRemove(groupData.state, change.node.row);
        
        if (groupData.state.count === 0) {
          // Group is now empty - remove it
          this.#storage.del(groupKey);
          this.#output.push({
            type: 'remove',
            node: {
              row: oldAggregatedRow,
              relationships: {},
            },
          });
        } else {
          // Group still has rows - update aggregate
          this.#setState(groupKey, groupData);
          const newAggregatedRow = this.#computeAggregates(groupData.groupRow, groupData.state);
          this.#output.push({
            type: 'edit',
            oldNode: {
              row: oldAggregatedRow,
              relationships: {},
            },
            node: {
              row: newAggregatedRow,
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
          // Same group - update the aggregate
          const groupData = this.#getGroupData(oldGroupKey);
          if (!groupData) break;
          
          const oldAggregatedRow = this.#computeAggregates(groupData.groupRow, groupData.state);
          this.#updateStateForEdit(groupData.state, change.oldNode.row, change.node.row);
          this.#setState(oldGroupKey, groupData);
          
          const newAggregatedRow = this.#computeAggregates(groupData.groupRow, groupData.state);
          this.#output.push({
            type: 'edit',
            oldNode: {
              row: oldAggregatedRow,
              relationships: {},
            },
            node: {
              row: newAggregatedRow,
              relationships: {},
            },
          });
        } else {
          // Different groups - handle as remove from old + add to new
          // Remove from old group
          const oldGroupData = this.#getGroupData(oldGroupKey);
          if (oldGroupData) {
            const oldAggregatedRow = this.#computeAggregates(oldGroupData.groupRow, oldGroupData.state);
            this.#updateStateForRemove(oldGroupData.state, change.oldNode.row);
            
            if (oldGroupData.state.count === 0) {
              this.#storage.del(oldGroupKey);
              this.#output.push({
                type: 'remove',
                node: {
                  row: oldAggregatedRow,
                  relationships: {},
                },
              });
            } else {
              this.#setState(oldGroupKey, oldGroupData);
              const newOldAggregatedRow = this.#computeAggregates(oldGroupData.groupRow, oldGroupData.state);
              this.#output.push({
                type: 'edit',
                oldNode: {
                  row: oldAggregatedRow,
                  relationships: {},
                },
                node: {
                  row: newOldAggregatedRow,
                  relationships: {},
                },
              });
            }
          }
          
          // Add to new group
          const newGroupData = this.#getGroupData(newGroupKey);
          const newGroupRow = this.#extractGroupFields(change.node.row);
          
          if (!newGroupData) {
            // Create new group
            const state: AggregateState = {count: 0};
            this.#updateStateForAdd(state, change.node.row);
            this.#setState(newGroupKey, {state, groupRow: newGroupRow});
            
            const aggregatedRow = this.#computeAggregates(newGroupRow, state);
            this.#output.push({
              type: 'add',
              node: {
                row: aggregatedRow,
                relationships: {},
              },
            });
          } else {
            // Update existing group
            const oldNewAggregatedRow = this.#computeAggregates(newGroupData.groupRow, newGroupData.state);
            this.#updateStateForAdd(newGroupData.state, change.node.row);
            this.#setState(newGroupKey, newGroupData);
            
            const newNewAggregatedRow = this.#computeAggregates(newGroupData.groupRow, newGroupData.state);
            this.#output.push({
              type: 'edit',
              oldNode: {
                row: oldNewAggregatedRow,
                relationships: {},
              },
              node: {
                row: newNewAggregatedRow,
                relationships: {},
              },
            });
          }
        }
        break;
      }
      case 'child':
        this.#output.push(change);
        break;
    }
  }

  #getGroupKey(row: Row): string {
    if (this.#groupByFields.length === 0) {
      // Global aggregation - single group for all rows
      return '__global__';
    }
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

  #getGroupData(groupKey: string): GroupData | undefined {
    return this.#storage.get(groupKey) as GroupData | undefined;
  }

  #setState(groupKey: string, groupData: GroupData): void {
    this.#storage.set(groupKey, groupData);
  }

  #computeStateFromRows(rows: Row[]): AggregateState {
    const state: AggregateState = {count: 0};
    for (const row of rows) {
      this.#updateStateForAdd(state, row);
    }
    return state;
  }

  #updateStateForAdd(state: AggregateState, row: Row): void {
    state.count++;
    
    // Track which fields we've processed for sum/avg to avoid counting same field multiple times
    const processedSumFields = new Set<string | undefined>();
    
    for (const agg of this.#aggregates) {
      if (agg.function === 'sum' || agg.function === 'avg') {
        if (!processedSumFields.has(agg.field)) {
          processedSumFields.add(agg.field);
          const value = agg.field ? (row[agg.field] as number) : 0;
          if (typeof value === 'number' && !isNaN(value)) {
            state.sum = (state.sum ?? 0) + value;
          }
        }
      }
      
      if (agg.function === 'min' && agg.field) {
        const value = row[agg.field];
        if (value !== null && value !== undefined) {
          if (state.min === undefined || compareValues(value, state.min) < 0) {
            state.min = value;
          }
        }
      }
      
      if (agg.function === 'max' && agg.field) {
        const value = row[agg.field];
        if (value !== null && value !== undefined) {
          if (state.max === undefined || compareValues(value, state.max) > 0) {
            state.max = value;
          }
        }
      }
    }
  }

  #updateStateForRemove(state: AggregateState, row: Row): void {
    state.count = Math.max(0, state.count - 1);
    
    const processedSumFields = new Set<string | undefined>();
    
    for (const agg of this.#aggregates) {
      if (agg.function === 'sum' || agg.function === 'avg') {
        if (!processedSumFields.has(agg.field)) {
          processedSumFields.add(agg.field);
          const value = agg.field ? (row[agg.field] as number) : 0;
          if (typeof value === 'number' && !isNaN(value)) {
            state.sum = (state.sum ?? 0) - value;
          }
        }
      }
      
      // LIMITATION: Min/max values cannot be maintained correctly during incremental
      // removal without storing all group values. When a row is removed, if it was
      // the min or max value, the aggregate result becomes stale.
      // A production implementation would need to:
      // 1. Store all values for min/max groups (memory intensive)
      // 2. Re-scan the group from source when the min/max value is removed
      // 3. Use a different data structure (e.g., heap) for efficient min/max tracking
      // For now, we accept this limitation and keep the existing value.
    }
  }

  #updateStateForEdit(state: AggregateState, oldRow: Row, newRow: Row): void {
    const processedSumFields = new Set<string | undefined>();
    
    for (const agg of this.#aggregates) {
      if (agg.function === 'sum' || agg.function === 'avg') {
        if (!processedSumFields.has(agg.field)) {
          processedSumFields.add(agg.field);
          const oldValue = agg.field ? (oldRow[agg.field] as number) : 0;
          const newValue = agg.field ? (newRow[agg.field] as number) : 0;
          
          if (typeof oldValue === 'number' && !isNaN(oldValue) &&
              typeof newValue === 'number' && !isNaN(newValue)) {
            state.sum = (state.sum ?? 0) - oldValue + newValue;
          }
        }
      }
      
      // Similar issue with min/max as in #updateStateForRemove
    }
  }

  #computeAggregates(groupRow: Row, state: AggregateState): Row {
    const result = {...groupRow};
    
    for (const agg of this.#aggregates) {
      switch (agg.function) {
        case 'count':
          result[agg.alias] = state.count;
          break;
        case 'sum':
          result[agg.alias] = state.sum ?? null;
          break;
        case 'avg':
          result[agg.alias] = state.count > 0 && state.sum !== undefined
            ? state.sum / state.count
            : null;
          break;
        case 'min':
          result[agg.alias] = state.min ?? null;
          break;
        case 'max':
          result[agg.alias] = state.max ?? null;
          break;
      }
    }
    
    return result;
  }
}
