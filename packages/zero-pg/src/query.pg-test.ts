import {beforeEach, describe, expect, test} from 'vitest';
import type {SchemaQuery, DBTransaction} from '../../zql/src/mutate/custom.ts';
import type {PostgresDB} from '../../zero-cache/src/types/pg.ts';
import {schema, schemaSql, seedDataSql} from './test/schema.ts';
import {testDBs} from '../../zero-cache/src/test/db.ts';
import {makeSchemaQuery} from './query.ts';
import {Transaction} from './test/util.ts';

describe('makeSchemaQuery', () => {
  let pg: PostgresDB;
  let queryProvider: (tx: DBTransaction<unknown>) => SchemaQuery<typeof schema>;

  beforeEach(async () => {
    pg = await testDBs.create('makeSchemaQuery-test');
    await pg.unsafe(schemaSql);
    await pg.unsafe(seedDataSql);

    queryProvider = makeSchemaQuery(schema);
  });

  test('select', async () => {
    await pg.begin(async tx => {
      const query = queryProvider(new Transaction(tx));
      const result = await query.basic.run();
      expect(result).toEqual([{id: '1', a: 2, b: 'foo', c: true}]);

      const result2 = await query.names.run();
      expect(result2).toEqual([{id: '2', a: 3, b: 'bar', c: false}]);

      const result3 = await query.compoundPk.run();
      expect(result3).toEqual([{a: 'a', b: 1, c: 'c'}]);
    });
  });

  test('select singular', async () => {
    await pg.begin(async tx => {
      const query = queryProvider(new Transaction(tx));
      const result = await query.basic.one().run();
      expect(result).toEqual({id: '1', a: 2, b: 'foo', c: true});
    });
  });
});
