import {assert} from '../../../shared/src/asserts.ts';
import type {JSONValue} from '../../../shared/src/json.ts';
import {must} from '../../../shared/src/must.ts';
import type {
  AST,
  ColumnReference,
  CompoundKey,
  Condition,
  Conjunction,
  CorrelatedSubquery,
  CorrelatedSubqueryCondition,
  Disjunction,
  LiteralValue,
  Ordering,
  Parameter,
  SimpleCondition,
  ValuePosition,
} from '../../../zero-protocol/src/ast.ts';
import type {Row} from '../../../zero-protocol/src/data.ts';
import type {PrimaryKey} from '../../../zero-protocol/src/primary-key.ts';
import {Exists} from '../ivm/exists.ts';
import {FanIn} from '../ivm/fan-in.ts';
import {FanOut} from '../ivm/fan-out.ts';
import {
  buildFilterPipeline,
  type FilterInput,
} from '../ivm/filter-operators.ts';
import {Filter} from '../ivm/filter.ts';
import {Join} from '../ivm/join.ts';
import type {Input, Storage} from '../ivm/operator.ts';
import {Skip} from '../ivm/skip.ts';
import type {Source} from '../ivm/source.ts';
import {Take} from '../ivm/take.ts';
import {createPredicate, type NoSubqueryCondition} from './filter.ts';

export type StaticQueryParameters = {
  authData: Record<string, JSONValue>;
  preMutationRow?: Row | undefined;
};

/**
 * Interface required of caller to buildPipeline. Connects to constructed
 * pipeline to delegate environment to provide sources and storage.
 */
export interface BuilderDelegate {
  /**
   * Called once for each source needed by the AST.
   * Might be called multiple times with same tableName. It is OK to return
   * same storage instance in that case.
   */
  getSource(tableName: string): Source | undefined;

  /**
   * Called once for each operator that requires storage. Should return a new
   * unique storage object for each call.
   */
  createStorage(name: string): Storage;

  decorateInput(input: Input, name: string): Input;

  decorateFilterInput(input: FilterInput, name: string): FilterInput;

  /**
   * The AST is mapped on-the-wire between client and server names.
   *
   * There is no "wire" for zqlite tests so this function is provided
   * to allow tests to remap the AST.
   */
  mapAst(ast: AST): AST;
}

/**
 * Builds a pipeline from an AST. Caller must provide a delegate to create source
 * and storage interfaces as necessary.
 *
 * Usage:
 *
 * ```ts
 * class MySink implements Output {
 *   readonly #input: Input;
 *
 *   constructor(input: Input) {
 *     this.#input = input;
 *     input.setOutput(this);
 *   }
 *
 *   push(change: Change, _: Operator) {
 *     console.log(change);
 *   }
 * }
 *
 * const input = buildPipeline(ast, myDelegate);
 * const sink = new MySink(input);
 * ```
 */
export function buildPipeline(ast: AST, delegate: BuilderDelegate): Input {
  return buildPipelineInternal(delegate.mapAst(ast), delegate, '');
}

export function bindStaticParameters(
  ast: AST,
  staticQueryParameters: StaticQueryParameters | undefined,
) {
  const visit = (node: AST): AST => ({
    ...node,
    where: node.where ? bindCondition(node.where) : undefined,
    related: node.related?.map(sq => ({
      ...sq,
      subquery: visit(sq.subquery),
    })),
  });

  function bindCondition(condition: Condition): Condition {
    if (condition.type === 'simple') {
      return {
        ...condition,
        left: bindValue(condition.left),
        right: bindValue(condition.right) as Exclude<
          ValuePosition,
          ColumnReference
        >,
      };
    }
    if (condition.type === 'correlatedSubquery') {
      return {
        ...condition,
        related: {
          ...condition.related,
          subquery: visit(condition.related.subquery),
        },
      };
    }
    return {
      ...condition,
      conditions: condition.conditions.map(bindCondition),
    };
  }

  const bindValue = (value: ValuePosition): ValuePosition => {
    if (isParameter(value)) {
      const anchor = must(
        staticQueryParameters,
        'Static query params do not exist',
      )[value.anchor];
      const resolvedValue = resolveField(anchor, value.field);
      return {
        type: 'literal',
        value: resolvedValue as LiteralValue,
      };
    }
    return value;
  };

  return visit(ast);
}

function resolveField(
  anchor: Record<string, JSONValue> | Row | undefined,
  field: string | string[],
): unknown {
  if (anchor === undefined) {
    return null;
  }

  if (Array.isArray(field)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return field.reduce((acc, f) => (acc as any)?.[f], anchor) ?? null;
  }

  return anchor[field] ?? null;
}

function isParameter(value: ValuePosition): value is Parameter {
  return value.type === 'static';
}

function buildPipelineInternal(
  ast: AST,
  delegate: BuilderDelegate,
  name: string,
  partitionKey?: CompoundKey | undefined,
): Input {
  const source = delegate.getSource(ast.table);
  if (!source) {
    throw new Error(`Source not found: ${ast.table}`);
  }
  ast = uniquifyCorrelatedSubqueryConditionAliases(ast);

  const csqsFromCondition = gatherCorrelatedSubqueryQueriesFromCondition(
    ast.where,
  );
  const splitEditKeys: Set<string> = partitionKey
    ? new Set(partitionKey)
    : new Set();
  for (const csq of csqsFromCondition) {
    for (const key of csq.correlation.parentField) {
      splitEditKeys.add(key);
    }
  }
  if (ast.related) {
    for (const csq of ast.related) {
      for (const key of csq.correlation.parentField) {
        splitEditKeys.add(key);
      }
    }
  }
  const conn = source.connect(must(ast.orderBy), ast.where, splitEditKeys);
  let end: Input = delegate.decorateInput(conn, `${name}:source(${ast.table})`);
  const {fullyAppliedFilters} = conn;

  if (ast.start) {
    end = delegate.decorateInput(new Skip(end, ast.start), `${name}:skip)`);
  }

  for (const csq of csqsFromCondition) {
    end = applyCorrelatedSubQuery(csq, delegate, end, name);
  }

  if (ast.where && !fullyAppliedFilters) {
    end = applyWhere(end, ast.where, delegate, name);
  }

  if (ast.limit !== undefined) {
    const takeName = `${name}:take`;
    end = delegate.decorateInput(
      new Take(end, delegate.createStorage(takeName), ast.limit, partitionKey),
      takeName,
    );
  }

  if (ast.related) {
    for (const csq of ast.related) {
      end = applyCorrelatedSubQuery(csq, delegate, end, name);
    }
  }

  return end;
}

function applyWhere(
  input: Input,
  condition: Condition,
  delegate: BuilderDelegate,
  name: string,
): Input {
  return buildFilterPipeline(input, filterInput =>
    applyFilter(filterInput, condition, delegate, name),
  );
}

function applyFilter(
  input: FilterInput,
  condition: Condition,
  delegate: BuilderDelegate,
  name: string,
) {
  switch (condition.type) {
    case 'and':
      return applyAnd(input, condition, delegate, name);
    case 'or':
      return applyOr(input, condition, delegate, name);
    case 'correlatedSubquery':
      return applyCorrelatedSubqueryCondition(input, condition, delegate, name);
    case 'simple':
      return applySimpleCondition(input, condition);
  }
}

function applyAnd(
  input: FilterInput,
  condition: Conjunction,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  for (const subCondition of condition.conditions) {
    input = applyFilter(input, subCondition, delegate, name);
  }
  return input;
}

export function applyOr(
  input: FilterInput,
  condition: Disjunction,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  const [subqueryConditions, otherConditions] =
    groupSubqueryConditions(condition);
  // if there are no subquery conditions, no fan-in / fan-out is needed
  if (subqueryConditions.length === 0) {
    return new Filter(
      input,
      createPredicate({
        type: 'or',
        conditions: otherConditions,
      }),
    );
  }

  const fanOut = new FanOut(input);
  const branches = subqueryConditions.map(subCondition =>
    applyFilter(fanOut, subCondition, delegate, name),
  );
  if (otherConditions.length > 0) {
    branches.push(
      new Filter(
        fanOut,
        createPredicate({
          type: 'or',
          conditions: otherConditions,
        }),
      ),
    );
  }
  const ret = new FanIn(fanOut, branches);
  fanOut.setFanIn(ret);
  return ret;
}

export function groupSubqueryConditions(condition: Disjunction) {
  const partitioned: [
    subqueryConditions: Condition[],
    otherConditions: NoSubqueryCondition[],
  ] = [[], []];
  for (const subCondition of condition.conditions) {
    if (isNotAndDoesNotContainSubquery(subCondition)) {
      partitioned[1].push(subCondition);
    } else {
      partitioned[0].push(subCondition);
    }
  }
  return partitioned;
}

export function isNotAndDoesNotContainSubquery(
  condition: Condition,
): condition is NoSubqueryCondition {
  if (condition.type === 'correlatedSubquery') {
    return false;
  }
  if (condition.type === 'and') {
    return condition.conditions.every(isNotAndDoesNotContainSubquery);
  }
  assert(condition.type !== 'or', 'where conditions are expected to be in DNF');
  return true;
}

function applySimpleCondition(
  input: FilterInput,
  condition: SimpleCondition,
): FilterInput {
  return new Filter(input, createPredicate(condition));
}

function applyCorrelatedSubQuery(
  sq: CorrelatedSubquery,
  delegate: BuilderDelegate,
  end: Input,
  name: string,
) {
  assert(sq.subquery.alias, 'Subquery must have an alias');
  const child = buildPipelineInternal(
    sq.subquery,
    delegate,
    `${name}.${sq.subquery.alias}`,
    sq.correlation.childField,
  );
  const joinName = `${name}:join(${sq.subquery.alias})`;
  end = new Join({
    parent: end,
    child,
    storage: delegate.createStorage(joinName),
    parentKey: sq.correlation.parentField,
    childKey: sq.correlation.childField,
    relationshipName: sq.subquery.alias,
    hidden: sq.hidden ?? false,
    system: sq.system ?? 'client',
  });
  return delegate.decorateInput(end, joinName);
}

function applyCorrelatedSubqueryCondition(
  input: FilterInput,
  condition: CorrelatedSubqueryCondition,
  delegate: BuilderDelegate,
  name: string,
): FilterInput {
  assert(condition.op === 'EXISTS' || condition.op === 'NOT EXISTS');
  const existsName = `${name}:exists(${condition.related.subquery.alias})`;
  return delegate.decorateFilterInput(
    new Exists(
      input,
      delegate.createStorage(existsName),
      must(condition.related.subquery.alias),
      condition.related.correlation.parentField,
      condition.op,
    ),
    existsName,
  );
}

function gatherCorrelatedSubqueryQueriesFromCondition(
  condition: Condition | undefined,
) {
  const csqs: CorrelatedSubquery[] = [];
  const gather = (condition: Condition) => {
    if (condition.type === 'correlatedSubquery') {
      assert(condition.op === 'EXISTS' || condition.op === 'NOT EXISTS');
      csqs.push({
        ...condition.related,
        subquery: {
          ...condition.related.subquery,
          limit:
            condition.related.system === 'permissions'
              ? PERMISSIONS_EXISTS_LIMIT
              : EXISTS_LIMIT,
        },
      });
      return;
    }
    if (condition.type === 'and' || condition.type === 'or') {
      for (const c of condition.conditions) {
        gather(c);
      }
      return;
    }
  };
  if (condition) {
    gather(condition);
  }
  return csqs;
}

const EXISTS_LIMIT = 3;
const PERMISSIONS_EXISTS_LIMIT = 1;

export function assertOrderingIncludesPK(
  ordering: Ordering,
  pk: PrimaryKey,
): void {
  const orderingFields = ordering.map(([field]) => field);
  const missingFields = pk.filter(pkField => !orderingFields.includes(pkField));

  if (missingFields.length > 0) {
    throw new Error(
      `Ordering must include all primary key fields. Missing: ${missingFields.join(
        ', ',
      )}. ZQL automatically appends primary key fields to the ordering if they are missing 
      so a common cause of this error is a casing mismatch between Postgres and ZQL.
      E.g., "userid" vs "userID".
      You may want to add double-quotes around your Postgres column names to prevent Postgres from lower-casing them:
      https://www.postgresql.org/docs/current/sql-syntax-lexical.htm`,
    );
  }
}
function uniquifyCorrelatedSubqueryConditionAliases(ast: AST): AST {
  if (!ast.where) {
    return ast;
  }
  const {where} = ast;
  if (where.type !== 'and' && where.type !== 'or') {
    return ast;
  }
  let count = 0;

  const uniquifyCorrelatedSubquery = (csqc: CorrelatedSubqueryCondition) => ({
    ...csqc,
    related: {
      ...csqc.related,
      subquery: {
        ...csqc.related.subquery,
        alias: (csqc.related.subquery.alias ?? '') + '_' + count++,
      },
    },
  });

  const uniquifyAnd = (and: Conjunction) => {
    const conds = [];
    for (const cond of and.conditions) {
      if (cond.type === 'correlatedSubquery') {
        conds.push(uniquifyCorrelatedSubquery(cond));
      } else {
        conds.push(cond);
      }
    }
    return {
      ...and,
      conditions: conds,
    };
  };
  if (where.type === 'and') {
    return {
      ...ast,
      where: uniquifyAnd(where),
    };
  }
  // or
  const conds = [];
  for (const cond of where.conditions) {
    if (cond.type === 'simple') {
      conds.push(cond);
    } else if (cond.type === 'correlatedSubquery') {
      conds.push(uniquifyCorrelatedSubquery(cond));
    } else if (cond.type === 'and') {
      conds.push(uniquifyAnd(cond));
    }
  }
  return {
    ...ast,
    where: {
      ...where,
      conditions: conds,
    },
  };
}
