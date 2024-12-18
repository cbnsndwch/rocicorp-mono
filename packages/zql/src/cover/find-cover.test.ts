import {expect, test} from 'vitest';
import {issueSchema, labelSchema} from '../query/test/testSchemas.js';
import {
  astForTestingSymbol,
  newQuery,
  QueryImpl,
  type QueryDelegate,
} from '../query/query-impl.js';
import type {Query, QueryType} from '../query/query.js';
import type {TableSchema} from '../../../zero-schema/src/table-schema.js';
import {covers} from './find-cover.js';

function ast(q: Query<TableSchema, QueryType>) {
  return (q as QueryImpl<TableSchema, QueryType>)[astForTestingSymbol];
}
const mockDelegate = {} as QueryDelegate;

test.each([
  {
    name: 'query covers itself',
    cover: newQuery(mockDelegate, issueSchema),
    covered: [newQuery(mockDelegate, issueSchema)],
  },
  {
    name: 'unconstrained query covers constrained queries',
    cover: newQuery(mockDelegate, issueSchema),
    covered: [
      newQuery(mockDelegate, issueSchema).where('title', '=', 'foo'),
      newQuery(mockDelegate, issueSchema).limit(10),
    ],
  },
  {
    name: 'constrained query cannot cover any queries',
    cover: newQuery(mockDelegate, issueSchema).where('title', '=', 'foo'),
    uncovered: [
      newQuery(mockDelegate, issueSchema),
      newQuery(mockDelegate, issueSchema).limit(10),
    ],
  },
  {
    name: 'queries rooted at different tables cannot cover each other',
    cover: newQuery(mockDelegate, issueSchema),
    uncovered: [newQuery(mockDelegate, labelSchema)],
  },
  {
    name: 'limited query cannot cover any queries',
    cover: newQuery(mockDelegate, issueSchema).limit(10),
    uncovered: [
      newQuery(mockDelegate, issueSchema),
      newQuery(mockDelegate, issueSchema).where('title', '=', 'foo'),
      newQuery(mockDelegate, issueSchema).limit(2),
    ],
  },
  {
    name: 'all relationships must be covered',
    cover: newQuery(mockDelegate, issueSchema)
      .related('labels')
      .related('comments')
      .related('owner'),
    covered: [
      newQuery(mockDelegate, issueSchema)
        .related('labels')
        .related('comments')
        .related('owner'),
      newQuery(mockDelegate, issueSchema).related('labels').related('comments'),
      newQuery(mockDelegate, issueSchema).related('labels'),
    ],
  },
  {
    name: 'all relationships must be covered 2',
    cover: newQuery(mockDelegate, issueSchema)
      .related('labels')
      .related('comments'),
    covered: [
      newQuery(mockDelegate, issueSchema).related('labels').related('comments'),
      newQuery(mockDelegate, issueSchema).related('labels'),
    ],
    uncovered: [
      newQuery(mockDelegate, issueSchema)
        .related('labels')
        .related('comments')
        .related('owner'),
    ],
  },
  {
    name: 'relationships in where can be covered too',
    cover: newQuery(mockDelegate, issueSchema)
      .related('labels')
      .related('comments'),
    covered: [
      newQuery(mockDelegate, issueSchema).whereExists('labels'),
      newQuery(mockDelegate, issueSchema)
        .whereExists('labels')
        .whereExists('comments'),
      newQuery(mockDelegate, issueSchema)
        .whereExists('labels')
        .related('comments')
        .related('labels'),
    ],
  },
  // recursive relationships
])('$name', ({name, cover, covered, uncovered}) => {
  if (name !== 'relationships in where can be covered too') {
    return;
  }
  for (const c of covered ?? []) {
    expect(covers(ast(cover), ast(c))).toBe(true);
  }
  for (const u of uncovered ?? []) {
    expect(covers(ast(cover), ast(u))).toBe(false);
  }
});
