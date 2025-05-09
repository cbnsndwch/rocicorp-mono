import {expect, test, vi} from 'vitest';
import {Catch} from './catch.ts';
import {FanIn} from './fan-in.ts';
import {FanOut} from './fan-out.ts';
import {Filter} from './filter.ts';
import {createSource} from './test/source-factory.ts';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {testLogConfig} from '../../../otel/src/test-log-config.ts';

const lc = createSilentLogContext();

test('fan-out pushes along all paths', () => {
  const s = createSource(
    lc,
    testLogConfig,
    'table',
    {a: {type: 'number'}, b: {type: 'string'}},
    ['a'],
  );
  const connector = s.connect([['a', 'asc']]);
  const fanOut = new FanOut(connector);
  const catch1 = new Catch(fanOut);
  const catch2 = new Catch(fanOut);
  const catch3 = new Catch(fanOut);

  // dummy fan-in for invariant in fan-out
  const fanIn = new FanIn(fanOut, []);
  fanOut.setFanIn(fanIn);

  s.push({type: 'add', row: {a: 1, b: 'foo'}});
  s.push({type: 'edit', oldRow: {a: 1, b: 'foo'}, row: {a: 1, b: 'bar'}});
  s.push({type: 'remove', row: {a: 1, b: 'bar'}});

  expect(catch1.pushes).toMatchInlineSnapshot(`
    [
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "foo",
          },
        },
        "type": "add",
      },
      {
        "oldRow": {
          "a": 1,
          "b": "foo",
        },
        "row": {
          "a": 1,
          "b": "bar",
        },
        "type": "edit",
      },
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "bar",
          },
        },
        "type": "remove",
      },
    ]
  `);
  expect(catch2.pushes).toMatchInlineSnapshot(`
    [
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "foo",
          },
        },
        "type": "add",
      },
      {
        "oldRow": {
          "a": 1,
          "b": "foo",
        },
        "row": {
          "a": 1,
          "b": "bar",
        },
        "type": "edit",
      },
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "bar",
          },
        },
        "type": "remove",
      },
    ]
  `);
  expect(catch3.pushes).toMatchInlineSnapshot(`
    [
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "foo",
          },
        },
        "type": "add",
      },
      {
        "oldRow": {
          "a": 1,
          "b": "foo",
        },
        "row": {
          "a": 1,
          "b": "bar",
        },
        "type": "edit",
      },
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "bar",
          },
        },
        "type": "remove",
      },
    ]
  `);
});

test('fan-out,fan-in pairing does not duplicate pushes', () => {
  const s = createSource(
    lc,
    testLogConfig,
    'table',
    {a: {type: 'number'}, b: {type: 'string'}},
    ['a'],
  );
  const connector = s.connect([['a', 'asc']]);
  const fanOut = new FanOut(connector);
  const filter1 = new Filter(fanOut, () => true);
  const filter2 = new Filter(fanOut, () => true);
  const filter3 = new Filter(fanOut, () => true);

  const fanIn = new FanIn(fanOut, [filter1, filter2, filter3]);
  const out = new Catch(fanIn);
  fanOut.setFanIn(fanIn);

  s.push({type: 'add', row: {a: 1, b: 'foo'}});
  s.push({type: 'add', row: {a: 2, b: 'foo'}});
  s.push({type: 'add', row: {a: 3, b: 'foo'}});

  expect(out.pushes).toMatchInlineSnapshot(`
    [
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 1,
            "b": "foo",
          },
        },
        "type": "add",
      },
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 2,
            "b": "foo",
          },
        },
        "type": "add",
      },
      {
        "node": {
          "relationships": {},
          "row": {
            "a": 3,
            "b": "foo",
          },
        },
        "type": "add",
      },
    ]
  `);
});

test('fan-in fetch', () => {
  const s = createSource(
    lc,
    testLogConfig,
    'table',
    {a: {type: 'boolean'}, b: {type: 'boolean'}},
    ['a', 'b'],
  );

  s.push({type: 'add', row: {a: false, b: false}});
  s.push({type: 'add', row: {a: false, b: true}});
  s.push({type: 'add', row: {a: true, b: false}});
  s.push({type: 'add', row: {a: true, b: true}});

  const connector = s.connect([
    ['a', 'asc'],
    ['b', 'asc'],
  ]);
  const fanOut = new FanOut(connector);

  const filter1 = new Filter(fanOut, row => row.a === true);
  const filter2 = new Filter(fanOut, row => row.b === true);
  const filter3 = new Filter(fanOut, row => row.a === true && row.b === false); // duplicates a row of filter1
  const filter4 = new Filter(fanOut, row => row.a === true && row.b === true); // duplicates a row of filter1 and filter2

  const fanIn = new FanIn(fanOut, [filter1, filter2, filter3, filter4]);
  const out = new Catch(fanIn);
  const result = out.fetch();
  expect(result).toMatchInlineSnapshot(`
    [
      {
        "relationships": {},
        "row": {
          "a": false,
          "b": true,
        },
      },
      {
        "relationships": {},
        "row": {
          "a": true,
          "b": false,
        },
      },
      {
        "relationships": {},
        "row": {
          "a": true,
          "b": true,
        },
      },
    ]
  `);
});

test('cleanup called once per branch', () => {
  const s = createSource(
    lc,
    testLogConfig,
    'table',
    {a: {type: 'number'}, b: {type: 'string'}},
    ['a'],
  );
  const connector = s.connect([['a', 'asc']]);
  const fanOut = new FanOut(connector);
  const filter1 = new Filter(fanOut, () => true);
  const filter2 = new Filter(fanOut, () => true);
  const filter3 = new Filter(fanOut, () => true);

  const fanIn = new FanIn(fanOut, [filter1, filter2, filter3]);
  const out = new Catch(fanIn);

  const spy = vi.spyOn(connector, 'cleanup');

  out.cleanup();

  expect(spy).toHaveBeenCalledTimes(3);
});
