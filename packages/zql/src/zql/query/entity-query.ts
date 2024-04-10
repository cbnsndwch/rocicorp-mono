import {must} from 'shared/src/must.js';
import type {
  AST,
  Aggregation,
  Condition,
  EqualityOps,
  InOps,
  LikeOps,
  OrderOps,
  SimpleOperator,
} from '../ast/ast.js';
import type {Context} from '../context/context.js';
import {Misuse} from '../error/misuse.js';
import type {EntitySchema} from '../schema/entity-schema.js';
import {AggArray, Aggregate, isAggregate} from './agg.js';
import {Statement} from './statement.js';

type NotUndefined<T> = Exclude<T, undefined>;

export type ValueAsOperatorInput<
  V,
  Op extends SimpleOperator,
> = Op extends InOps
  ? NotUndefined<V>[]
  : Op extends LikeOps
  ? V extends string | undefined
    ? NotUndefined<V>
    : never
  : Op extends OrderOps
  ? V extends boolean | undefined
    ? never
    : NotUndefined<V>
  : Op extends EqualityOps
  ? NotUndefined<V>
  : never;

export type FieldAsOperatorInput<
  F extends FromSet,
  S extends SimpleSelector<F>,
  Op extends SimpleOperator,
> = S extends `${infer T}.${infer K}`
  ? ValueAsOperatorInput<F[T][K], Op>
  : ValueAsOperatorInput<ExtractNestedTypeByName<F, S>, Op>;

export type FromSet = {
  [tableOrAlias: string]: EntitySchema;
};

type NestedKeys<T> = {
  [K in keyof T]: string & keyof T[K];
}[keyof T];

type ObjectHasSingleProperty<T> = {
  [K in keyof T]: Exclude<keyof Omit<T, K>, K>;
}[keyof T];

type SimpleSelector<F extends FromSet> =
  | {
      [K in keyof F]: `${string & K}.${string & keyof F[K]}`;
    }[keyof F]
  | (ObjectHasSingleProperty<F> extends never ? NestedKeys<F> : never);

type Selector<F extends FromSet> =
  | {
      [K in keyof F]:
        | `${string & K}.${string & keyof F[K]}`
        | `${string & K}.*`;
    }[keyof F]
  | (ObjectHasSingleProperty<F> extends never ? NestedKeys<F> : never)
  | '*';

type ExtractAggregatePiece<From extends FromSet, K extends Aggregator<From>> =
  // array aggregation
  K extends AggArray<infer Selection, infer Alias>
    ? Selection extends `${infer Table}.${string}`
      ? ObjectHasSingleProperty<From> extends never
        ? {
            [K in Alias]: ExtractFieldValue<
              From,
              Selection extends SimpleSelector<From> ? Selection : never
            >[];
          }
        : {
            [K in Table]: {
              [K in Alias]: ExtractFieldValue<
                From,
                Selection extends SimpleSelector<From> ? Selection : never
              >[];
            };
          }
      : {
          [K in Alias]: ExtractFieldValue<
            From,
            Selection extends SimpleSelector<From> ? Selection : never
          >[];
        }
    : // all other aggregate functions
    K extends Aggregate<infer Selection, infer Alias>
    ? Selection extends `${infer Table}.${string}`
      ? ObjectHasSingleProperty<From> extends never
        ? {[K in Alias]: number}
        : {[K in Table]: {[K in Alias]: number}}
      : {[K in Alias]: number}
    : never;

type ExtractFieldPiece<From extends FromSet, Selection extends Selector<From>> =
  // 'table.*'
  Selection extends `${infer Table}.*`
    ? Table extends keyof From
      ? ObjectHasSingleProperty<From> extends never
        ? From[Table]
        : {[K in Table]: From[Table]}
      : never
    : // 'table.column'
    Selection extends `${infer Table}.${infer Column}`
    ? ObjectHasSingleProperty<From> extends never
      ? {
          [K in Column]: ExtractFieldValue<From, Selection>;
        }
      : {
          [K in Table]: {
            [K in Column]: ExtractFieldValue<From, Selection>;
          };
        }
    : // '*'
    Selection extends '*'
    ? ObjectHasSingleProperty<From> extends never
      ? From[keyof From]
      : From
    : // 'column' -- we're pre-validated that the object has a single property at this point
      {
        [P in string & Selection]: ExtractNestedTypeByName<
          From,
          string & Selection
        >;
      };

type ExtractNestedTypeByName<T, S extends string> = {
  [K in keyof T]: S extends keyof T[K] ? T[K][S] : never;
}[keyof T];

type ExtractFieldValue<
  F extends FromSet,
  S extends SimpleSelector<F>,
> = S extends `${infer T}.${infer K}` ? F[T][K] : ExtractNestedTypeByName<F, S>;

type CombineSelections<
  From extends FromSet,
  Selections extends (Selector<From> | Aggregator<From>)[],
> = Selections extends [infer First, ...infer Rest]
  ? First extends Selector<From>
    ? CombineSelections<
        From,
        Rest extends (Selector<From> | Aggregator<From>)[] ? Rest : []
      > &
        ExtractFieldPiece<From, First>
    : First extends Aggregator<From>
    ? CombineSelections<
        From,
        Rest extends (Selector<From> | Aggregator<From>)[] ? Rest : []
      > &
        ExtractAggregatePiece<From, First>
    : never
  : unknown;

type Aggregator<From extends FromSet> = Aggregate<SimpleSelector<From>, string>;

/**
 * Have you ever noticed that when you hover over Types in TypeScript, it shows
 * Pick<Omit<T, K>, K>? Rather than the final object structure after picking and omitting?
 * Or any time you use a type alias.
 *
 * MakeHumanReadable collapses the type aliases into their final form.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type MakeHumanReadable<T> = {} & {
  readonly [P in keyof T]: T[P] extends string ? T[P] : MakeHumanReadable<T[P]>;
};

export type WhereCondition<From extends FromSet> =
  | {
      op: 'AND' | 'OR';
      conditions: WhereCondition<From>[];
    }
  | SimpleCondition<From, SimpleSelector<From>, SimpleOperator>;

type SimpleCondition<
  From extends FromSet,
  Selector extends SimpleSelector<From>,
  Op extends SimpleOperator,
> = {
  op: SimpleOperator;
  field: SimpleSelector<From>;
  value: {
    type: 'literal';
    value: FieldAsOperatorInput<From, Selector, Op>;
  };
};

export class EntityQuery<From extends FromSet, Return = []> {
  readonly #ast: AST;
  readonly #name: string;
  readonly #context: Context;

  constructor(context: Context, tableName: string, ast?: AST) {
    this.#ast = ast ?? {
      table: tableName,
      orderBy: [['id'], 'asc'],
    };
    this.#name = tableName;
    this.#context = context;

    // TODO(arv): Guard this with TESTING once we have the infrastructure.
    astWeakMap.set(this, this.#ast);
  }

  select<Fields extends (Selector<From> | Aggregator<From>)[]>(
    ...x: Fields
  ): EntityQuery<From, CombineSelections<From, Fields>[]> {
    const seen = new Set(this.#ast.select?.map(s => s[1]));
    const aggregate: Aggregation[] = [];
    const select = [...(this.#ast.select ?? [])];
    for (const more of x) {
      if (!isAggregate(more)) {
        if (seen.has(more)) {
          continue;
        }
        seen.add(more);
        select.push([more, more]);

        continue;
      }
      aggregate.push(more);
    }

    return new EntityQuery<From, CombineSelections<From, Fields>[]>(
      this.#context,
      this.#name,
      {
        ...this.#ast,
        select: [...select],
        aggregate,
      },
    );
  }

  groupBy<Fields extends SimpleSelector<From>[]>(...x: Fields) {
    return new EntityQuery<From, Return>(this.#context, this.#name, {
      ...this.#ast,
      groupBy: x as string[],
    });
  }

  where(expr: WhereCondition<From>): EntityQuery<From, Return>;
  where<K extends SimpleSelector<From>, Op extends SimpleOperator>(
    field: K,
    op: Op,
    value: FieldAsOperatorInput<From, K, Op>,
  ): EntityQuery<From, Return>;
  where<K extends SimpleSelector<From>, Op extends SimpleOperator>(
    exprOrField: K | WhereCondition<From>,
    op?: Op,
    value?: FieldAsOperatorInput<From, K, Op>,
  ): EntityQuery<From, Return> {
    let expr: WhereCondition<From>;
    if (typeof exprOrField === 'string') {
      expr = expression(exprOrField, op!, value!);
    } else {
      expr = exprOrField;
    }

    let cond: WhereCondition<From>;
    const where = this.#ast.where as WhereCondition<From> | undefined;
    if (!where) {
      cond = expr;
    } else if (where.op === 'AND') {
      const {conditions} = where;
      cond = flatten('AND', [...conditions, expr]);
    } else {
      cond = {
        op: 'AND',
        conditions: [where, expr],
      };
    }

    return new EntityQuery<From, Return>(this.#context, this.#name, {
      ...this.#ast,
      where: cond as Condition,
    });
  }

  limit(n: number) {
    if (this.#ast.limit !== undefined) {
      throw new Misuse('Limit already set');
    }

    return new EntityQuery<From, Return>(this.#context, this.#name, {
      ...this.#ast,
      limit: n,
    });
  }

  asc(...x: SimpleSelector<From>[]) {
    if (!x.includes('id')) {
      x.push('id');
    }

    return new EntityQuery<From, Return>(this.#context, this.#name, {
      ...this.#ast,
      orderBy: [x, 'asc'],
    });
  }

  desc(...x: SimpleSelector<From>[]) {
    if (!x.includes('id')) {
      x.push('id');
    }

    return new EntityQuery<From, Return>(this.#context, this.#name, {
      ...this.#ast,
      orderBy: [x, 'desc'],
    });
  }

  prepare(): Statement<Return> {
    return new Statement<Return>(this.#context, this.#ast);
  }
}

const astWeakMap = new WeakMap<WeakKey, AST>();

export function astForTesting(q: WeakKey): AST {
  return must(astWeakMap.get(q));
}

type ArrayOfAtLeastTwo<T> = [T, T, ...T[]];

export function or<F extends FromSet>(
  ...conditions: ArrayOfAtLeastTwo<WhereCondition<F>>
): WhereCondition<F> {
  return flatten('OR', conditions);
}

export function and<F extends FromSet>(
  ...conditions: ArrayOfAtLeastTwo<WhereCondition<F>>
): WhereCondition<F> {
  return flatten('AND', conditions);
}

function flatten<F extends FromSet>(
  op: 'AND' | 'OR',
  conditions: WhereCondition<F>[],
): WhereCondition<F> {
  const flattened: WhereCondition<F>[] = [];
  for (const c of conditions) {
    if (c.op === op) {
      flattened.push(...c.conditions);
    } else {
      flattened.push(c);
    }
  }

  return {op, conditions: flattened};
}

export function expression<
  From extends FromSet,
  Selector extends SimpleSelector<From>,
  Op extends SimpleOperator,
>(
  field: Selector,
  op: Op,
  value: FieldAsOperatorInput<From, Selector, Op>,
): WhereCondition<From> {
  return {
    op,
    field,
    value: {
      type: 'literal',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: value as any, // TODO
    },
  };
}

export function not<From extends FromSet>(
  expr: WhereCondition<From>,
): WhereCondition<From> {
  switch (expr.op) {
    case 'AND':
      return {
        op: 'OR',
        conditions: expr.conditions.map(not),
      };
    case 'OR':
      return {
        op: 'AND',
        conditions: expr.conditions.map(not),
      };
    default:
      return {
        op: negateOperator(expr.op),
        field: expr.field,
        value: expr.value,
      };
  }
}

function negateOperator(op: SimpleOperator): SimpleOperator {
  switch (op) {
    case '=':
      return '!=';
    case '!=':
      return '=';
    case '<':
      return '>=';
    case '>':
      return '<=';
    case '>=':
      return '<';
    case '<=':
      return '>';
    case 'IN':
      return 'NOT IN';
    case 'NOT IN':
      return 'IN';
    case 'LIKE':
      return 'NOT LIKE';
    case 'NOT LIKE':
      return 'LIKE';
    case 'ILIKE':
      return 'NOT ILIKE';
    case 'NOT ILIKE':
      return 'ILIKE';
  }
}