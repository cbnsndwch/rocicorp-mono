import {describe, expect, test} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {testLogConfig} from '../../../otel/src/test-log-config.ts';
import {buildPipeline} from '../builder/builder.ts';
import type {BuilderDelegate} from '../builder/builder.ts';
import {MemorySource} from '../ivm/memory-source.ts';
import {MemoryStorage} from '../ivm/memory-storage.ts';
import type {Storage, Input} from '../ivm/operator.ts';
import type {Source} from '../ivm/source.ts';
import type {AST} from '../../../zero-protocol/src/ast.ts';

const lc = createSilentLogContext();

describe('aggregation queries', () => {
  test('groupBy with sum', () => {
    // Create a source with order data
    const source = new MemorySource(
      'orders',
      {
        id: {type: 'string'},
        customerId: {type: 'string'},
        amount: {type: 'number'},
      },
      ['id'],
    );

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
    source.push({
      type: 'add',
      row: {id: '4', customerId: 'c2', amount: 250},
    });

    // Create AST for: SELECT customerId, SUM(amount) as total FROM orders GROUP BY customerId
    const ast: AST = {
      table: 'orders',
      orderBy: [['id', 'asc']],
      groupBy: ['customerId'],
      aggregates: [
        {function: 'sum', field: 'amount', alias: 'total'},
      ],
    };

    // Build pipeline
    const storages = new Map<string, Storage>();
    const delegate: BuilderDelegate = {
      getSource: (tableName: string) => (tableName === 'orders' ? source : undefined),
      createStorage: (name: string) => {
        const storage = new MemoryStorage();
        storages.set(name, storage);
        return storage;
      },
      decorateInput: (input: Input) => input,
      decorateFilterInput: (input: any) => input,
    };

    const pipeline = buildPipeline(ast, delegate);

    // Fetch results
    const results = Array.from(pipeline.fetch({}));

    // Verify results
    expect(results).toHaveLength(2);
    
    const c1Result = results.find(n => n.row.customerId === 'c1');
    const c2Result = results.find(n => n.row.customerId === 'c2');
    
    expect(c1Result?.row.total).toBe(300);
    expect(c2Result?.row.total).toBe(400);
  });

  test('groupBy with count', () => {
    const source = new MemorySource(
      'orders',
      {
        id: {type: 'string'},
        customerId: {type: 'string'},
        status: {type: 'string'},
      },
      ['id'],
    );

    source.push({type: 'add', row: {id: '1', customerId: 'c1', status: 'completed'}});
    source.push({type: 'add', row: {id: '2', customerId: 'c1', status: 'pending'}});
    source.push({type: 'add', row: {id: '3', customerId: 'c2', status: 'completed'}});

    const ast: AST = {
      table: 'orders',
      orderBy: [['id', 'asc']],
      groupBy: ['customerId'],
      aggregates: [
        {function: 'count', alias: 'orderCount'},
      ],
    };

    const delegate: BuilderDelegate = {
      getSource: (tableName: string) => (tableName === 'orders' ? source : undefined),
      createStorage: () => new MemoryStorage(),
      decorateInput: (input: Input) => input,
      decorateFilterInput: (input: any) => input,
    };

    const pipeline = buildPipeline(ast, delegate);
    const results = Array.from(pipeline.fetch({}));

    expect(results).toHaveLength(2);
    
    const c1Result = results.find(n => n.row.customerId === 'c1');
    const c2Result = results.find(n => n.row.customerId === 'c2');
    
    expect(c1Result?.row.orderCount).toBe(2);
    expect(c2Result?.row.orderCount).toBe(1);
  });

  test('groupBy with multiple aggregates and having', () => {
    const source = new MemorySource(
      'orders',
      {
        id: {type: 'string'},
        customerId: {type: 'string'},
        amount: {type: 'number'},
      },
      ['id'],
    );

    source.push({type: 'add', row: {id: '1', customerId: 'c1', amount: 100}});
    source.push({type: 'add', row: {id: '2', customerId: 'c1', amount: 200}});
    source.push({type: 'add', row: {id: '3', customerId: 'c2', amount: 50}});
    source.push({type: 'add', row: {id: '4', customerId: 'c3', amount: 400}});

    // SELECT customerId, SUM(amount) as total, COUNT(*) as orderCount
    // FROM orders
    // GROUP BY customerId
    // HAVING total > 100
    const ast: AST = {
      table: 'orders',
      orderBy: [['id', 'asc']],
      groupBy: ['customerId'],
      aggregates: [
        {function: 'sum', field: 'amount', alias: 'total'},
        {function: 'count', alias: 'orderCount'},
      ],
      having: {
        type: 'simple',
        op: '>',
        left: {type: 'column', name: 'total'},
        right: {type: 'literal', value: 100},
      },
    };

    const delegate: BuilderDelegate = {
      getSource: (tableName: string) => (tableName === 'orders' ? source : undefined),
      createStorage: () => new MemoryStorage(),
      decorateInput: (input: Input) => input,
      decorateFilterInput: (input: any) => input,
    };

    const pipeline = buildPipeline(ast, delegate);
    const results = Array.from(pipeline.fetch({}));

    // Should only include c1 (300) and c3 (400), not c2 (50)
    expect(results).toHaveLength(2);
    
    const customerIds = results.map(n => n.row.customerId).sort();
    expect(customerIds).toEqual(['c1', 'c3']);
    
    const c1Result = results.find(n => n.row.customerId === 'c1');
    expect(c1Result?.row.total).toBe(300);
    expect(c1Result?.row.orderCount).toBe(2);
  });

  test('groupBy with avg', () => {
    const source = new MemorySource(
      'orders',
      {
        id: {type: 'string'},
        customerId: {type: 'string'},
        amount: {type: 'number'},
      },
      ['id'],
    );

    source.push({type: 'add', row: {id: '1', customerId: 'c1', amount: 100}});
    source.push({type: 'add', row: {id: '2', customerId: 'c1', amount: 200}});
    source.push({type: 'add', row: {id: '3', customerId: 'c2', amount: 300}});

    const ast: AST = {
      table: 'orders',
      orderBy: [['id', 'asc']],
      groupBy: ['customerId'],
      aggregates: [
        {function: 'avg', field: 'amount', alias: 'avgAmount'},
      ],
    };

    const delegate: BuilderDelegate = {
      getSource: (tableName: string) => (tableName === 'orders' ? source : undefined),
      createStorage: () => new MemoryStorage(),
      decorateInput: (input: Input) => input,
      decorateFilterInput: (input: any) => input,
    };

    const pipeline = buildPipeline(ast, delegate);
    const results = Array.from(pipeline.fetch({}));

    expect(results).toHaveLength(2);
    
    const c1Result = results.find(n => n.row.customerId === 'c1');
    const c2Result = results.find(n => n.row.customerId === 'c2');
    
    expect(c1Result?.row.avgAmount).toBe(150); // (100 + 200) / 2
    expect(c2Result?.row.avgAmount).toBe(300); // 300 / 1
  });

  test('global aggregation without groupBy', () => {
    const source = new MemorySource(
      'orders',
      {
        id: {type: 'string'},
        amount: {type: 'number'},
      },
      ['id'],
    );

    source.push({type: 'add', row: {id: '1', amount: 100}});
    source.push({type: 'add', row: {id: '2', amount: 200}});
    source.push({type: 'add', row: {id: '3', amount: 300}});

    // SELECT COUNT(*) as total, SUM(amount) as totalAmount FROM orders
    const ast: AST = {
      table: 'orders',
      orderBy: [['id', 'asc']],
      aggregates: [
        {function: 'count', alias: 'total'},
        {function: 'sum', field: 'amount', alias: 'totalAmount'},
      ],
    };

    const delegate: BuilderDelegate = {
      getSource: (tableName: string) => (tableName === 'orders' ? source : undefined),
      createStorage: () => new MemoryStorage(),
      decorateInput: (input: Input) => input,
      decorateFilterInput: (input: any) => input,
    };

    const pipeline = buildPipeline(ast, delegate);
    const results = Array.from(pipeline.fetch({}));

    // Global aggregation returns a single row
    expect(results).toHaveLength(1);
    expect(results[0].row.total).toBe(3);
    expect(results[0].row.totalAmount).toBe(600);
  });
});
