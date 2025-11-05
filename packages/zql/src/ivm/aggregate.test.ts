import {describe, expect, test} from 'vitest';
import {Aggregate} from './aggregate.ts';
import {MemorySource} from './memory-source.ts';
import {MemoryStorage} from './memory-storage.ts';

describe('aggregate', () => {
  const columns = {
    id: {type: 'string'},
    customerId: {type: 'string'},
    amount: {type: 'number'},
  } as const;
  const primaryKey = ['id'] as const;

  test('sum aggregation', async () => {
    const source = new MemorySource('orders', columns, primaryKey);
    
    // Add test data
    source.push({
      type: 'add',
      row: {id: '1', customerId: 'c1', amount: 100},
    });
    source.push({
      type: 'add',
      row: {id: '2', customerId: 'c1', amount: 200},
    });
    source.push({
      type: 'add',
      row: {id: '3', customerId: 'c2', amount: 150},
    });

    // Create pipeline: source -> aggregate
    const ordering = [['id', 'asc']] as const;
    const sourceInput = source.connect(ordering);
    
    const aggStorage = new MemoryStorage();
    const aggregate = new Aggregate(
      sourceInput,
      aggStorage,
      [{function: 'sum', field: 'amount', alias: 'totalAmount'}],
      ['customerId'],
    );

    // Collect results
    const results: any[] = [];
    aggregate.setOutput({
      push: change => {
        if (change.type === 'add') {
          results.push(change.node.row);
        }
      },
    });

    // Fetch and verify
    const fetchResults = Array.from(aggregate.fetch({}));
    expect(fetchResults).toHaveLength(2);
    
    // Verify aggregated values
    const c1Result = fetchResults.find(n => n.row.customerId === 'c1');
    const c2Result = fetchResults.find(n => n.row.customerId === 'c2');
    
    expect(c1Result?.row.totalAmount).toBe(300);
    expect(c2Result?.row.totalAmount).toBe(150);
  });

  test('count aggregation', async () => {
    const source = new MemorySource('orders', columns, primaryKey);
    
    // Add test data
    source.push({
      type: 'add',
      row: {id: '1', customerId: 'c1', amount: 100},
    });
    source.push({
      type: 'add',
      row: {id: '2', customerId: 'c1', amount: 200},
    });
    source.push({
      type: 'add',
      row: {id: '3', customerId: 'c2', amount: 150},
    });

    // Create pipeline
    const ordering = [['id', 'asc']] as const;
    const sourceInput = source.connect(ordering);
    
    const aggStorage = new MemoryStorage();
    const aggregate = new Aggregate(
      sourceInput,
      aggStorage,
      [{function: 'count', alias: 'orderCount'}],
      ['customerId'],
    );

    // Fetch and verify
    const fetchResults = Array.from(aggregate.fetch({}));
    expect(fetchResults).toHaveLength(2);
    
    const c1Result = fetchResults.find(n => n.row.customerId === 'c1');
    const c2Result = fetchResults.find(n => n.row.customerId === 'c2');
    
    expect(c1Result?.row.orderCount).toBe(2);
    expect(c2Result?.row.orderCount).toBe(1);
  });

  test('multiple aggregates', async () => {
    const source = new MemorySource('orders', columns, primaryKey);
    
    // Add test data
    source.push({
      type: 'add',
      row: {id: '1', customerId: 'c1', amount: 100},
    });
    source.push({
      type: 'add',
      row: {id: '2', customerId: 'c1', amount: 200},
    });

    // Create pipeline with multiple aggregates
    const ordering = [['id', 'asc']] as const;
    const sourceInput = source.connect(ordering);
    
    const aggStorage = new MemoryStorage();
    const aggregate = new Aggregate(
      sourceInput,
      aggStorage,
      [
        {function: 'sum', field: 'amount', alias: 'totalAmount'},
        {function: 'count', alias: 'orderCount'},
        {function: 'avg', field: 'amount', alias: 'avgAmount'},
      ],
      ['customerId'],
    );

    // Fetch and verify
    const fetchResults = Array.from(aggregate.fetch({}));
    expect(fetchResults).toHaveLength(1);
    
    const result = fetchResults[0].row;
    expect(result.customerId).toBe('c1');
    expect(result.totalAmount).toBe(300);
    expect(result.orderCount).toBe(2);
    expect(result.avgAmount).toBe(150);
  });
});
