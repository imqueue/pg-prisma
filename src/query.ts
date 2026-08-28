/*!
 * @imqueue/pg-prisma — Prisma/Postgres toolkit for @imqueue services
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */

import type { AnyExpression } from '@prisma/orm-postgres/relational-core/ast';
import {
    AndExpr,
    NotExpr,
    OrExpr,
} from '@prisma/orm-postgres/relational-core/ast';
import type { RelationMap } from './derive.js';

/** Sort direction. */
export type Direction = 'asc' | 'desc';

/** The comparison operators a caller may send for one field. */
export interface FilterOps {
    /** Equal to. */
    eq?: unknown;
    /** Not equal to. */
    not?: unknown;
    /** One of. */
    in?: unknown[];
    /** None of. */
    notIn?: unknown[];
    /** Less than. */
    lt?: unknown;
    /** Less than or equal to. */
    lte?: unknown;
    /** Greater than. */
    gt?: unknown;
    /** Greater than or equal to. */
    gte?: unknown;
    /** Contains, as a substring. */
    contains?: string;
    /** Begins with. */
    startsWith?: string;
    /** Ends with. */
    endsWith?: string;
    /**
     * `insensitive` to ignore case in the three matchers above.
     *
     * @remarks
     * Prisma 7 spelled it the same way. Somebody typing a name is remembering
     * it, not quoting it, so a search that respects case answers "no such
     * thing" to a correct question.
     */
    mode?: 'default' | 'insensitive';
}

/** A filter as it arrives over the wire. */
export type Where = object;

/** A projection as it arrives over the wire: `{ id: true, user: { … } }`. */
export type Select = object;

/** An ordering as it arrives over the wire: `{ createdAt: 'desc' }`. */
export type OrderBy = object;

/** One field of a model, inside a predicate callback. */
interface Field {
    eq(value: unknown): AnyExpression;
    neq(value: unknown): AnyExpression;
    in(values: unknown[]): AnyExpression;
    notIn(values: unknown[]): AnyExpression;
    lt(value: unknown): AnyExpression;
    lte(value: unknown): AnyExpression;
    gt(value: unknown): AnyExpression;
    gte(value: unknown): AnyExpression;
    like(pattern: string): AnyExpression;
    ilike(pattern: string): AnyExpression;
    asc(): unknown;
    desc(): unknown;
}

/** One relation of a model, inside a predicate callback. */
interface RelationField {
    some(build: (fields: Fields) => AnyExpression): AnyExpression;
}

/** The object a predicate callback is handed. */
export type Fields = Record<string, Field & RelationField>;

const LOGICAL = new Set(['AND', 'OR', 'NOT']);

/** LIKE treats these as wildcards, so a literal one has to be escaped. */
function escapeLike(value: string): string {
    return value.replace(/([\\%_])/g, '\\$1');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a value is an operator bag rather than a plain equality operand. */
function isOps(value: unknown): value is Record<string, unknown> {
    return (
        isPlainObject(value) &&
        Object.keys(value).length > 0 &&
        Object.keys(value).every(key => key in OPS || key === 'mode')
    );
}

/** Each wire operator, as the expression it builds on a field. */
const OPS: Record<string, (field: Field, operand: never) => AnyExpression> = {
    eq: (field, operand) => field.eq(operand),
    not: (field, operand) => field.neq(operand),
    in: (field, operand) => field.in(operand as unknown[]),
    notIn: (field, operand) => field.notIn(operand as unknown[]),
    lt: (field, operand) => field.lt(operand),
    lte: (field, operand) => field.lte(operand),
    gt: (field, operand) => field.gt(operand),
    gte: (field, operand) => field.gte(operand),
    contains: (field, operand) =>
        field.like(`%${escapeLike(String(operand))}%`),
    startsWith: (field, operand) =>
        field.like(`${escapeLike(String(operand))}%`),
    endsWith: (field, operand) => field.like(`%${escapeLike(String(operand))}`),
};

/** The same three, ignoring case. */
const INSENSITIVE: Record<
    string,
    (field: Field, operand: never) => AnyExpression
> = {
    contains: (field, operand) =>
        field.ilike(`%${escapeLike(String(operand))}%`),
    startsWith: (field, operand) =>
        field.ilike(`${escapeLike(String(operand))}%`),
    endsWith: (field, operand) =>
        field.ilike(`%${escapeLike(String(operand))}`),
};

/** AND a list of predicates, collapsing the single case. */
function all(parts: AnyExpression[]): AnyExpression | undefined {
    if (parts.length === 0) {
        return undefined;
    }

    return parts.length === 1 ? parts[0] : AndExpr.of(parts);
}

function leaf(field: Field, value: unknown): AnyExpression[] {
    if (!isOps(value)) {
        return [field.eq(value)];
    }

    // `mode` is not an operator, it says how the others read.
    const ops =
        (value as FilterOps).mode === 'insensitive'
            ? { ...OPS, ...INSENSITIVE }
            : OPS;

    return Object.entries(value)
        .filter(([op]) => op !== 'mode')
        .map(([op, operand]) =>
            (ops[op] as (f: Field, o: unknown) => AnyExpression)(
                field,
                operand,
            ),
        );
}

function build(
    relations: RelationMap,
    model: string,
    where: Where,
    fields: Fields,
): AnyExpression[] {
    return Object.entries(where).flatMap(([key, value]) => {
        if (LOGICAL.has(key)) {
            const parts = (Array.isArray(value) ? value : [value]).flatMap(
                one => all(build(relations, model, one as Where, fields)) ?? [],
            );
            if (parts.length === 0) {
                return [];
            }
            if (key === 'OR') {
                return [OrExpr.of(parts)];
            }
            const conjunction = all(parts) as AnyExpression;

            return key === 'NOT' ? [new NotExpr(conjunction)] : [conjunction];
        }
        const relation = relations[model]?.[key];
        if (relation) {
            return [
                fields[key]?.some(
                    nested =>
                        all(
                            build(
                                relations,
                                relation.target,
                                value as Where,
                                nested,
                            ),
                        ) as AnyExpression,
                ) as AnyExpression,
            ];
        }
        const field = fields[key];

        return field ? leaf(field, value) : [];
    });
}

/**
 * Turn a wire filter into the predicate callback `.where()` takes.
 *
 * @remarks
 * A relation filters through `some`, matching the wire shape's meaning: a
 * condition on a list relation asks whether **any** related row satisfies it.
 *
 * `contains`, `startsWith` and `endsWith` become `LIKE`, with the operand
 * escaped — a caller searching for a literal `%` or `_` would otherwise get a
 * wildcard, and the surprise is silent because the query still succeeds.
 *
 * @param relations - Relations per model, from `deriveDataLayer`.
 * @param model - The model the filter is written against.
 * @param where - The filter, or undefined for none.
 * @returns The callback, or undefined when nothing constrains the query.
 * @example
 * ```typescript
 * const predicate = toPredicate(relations, 'User', {
 *     email: { contains: '@example.com' },
 *     roles: { role: { name: { eq: 'admin' } } },
 * });
 * const rows = await db.orm.public.User.where(predicate!).all();
 * ```
 */
export function toPredicate(
    relations: RelationMap,
    model: string,
    where: Where | undefined,
): ((fields: Fields) => AnyExpression) | undefined {
    if (!where || Object.keys(where).length === 0) {
        return undefined;
    }

    return (fields: Fields): AnyExpression =>
        all(build(relations, model, where, fields)) as AnyExpression;
}

/** A projection split into what `select` takes and what `include` takes. */
export interface Projection {
    /** Scalar field names. */
    fields: string[];
    /** Relations to eager-load, each with its own projection. */
    includes: { name: string; projection: Projection | undefined }[];
}

/**
 * Split a wire projection into its scalar and relation halves.
 *
 * @remarks
 * Prisma Next separates the two — `.select(...)` names scalar fields and
 * `.include(name, branch)` pulls a relation — where the wire shape nests them
 * in one object. Splitting here keeps every caller from walking it again.
 *
 * @param relations - Relations per model, from `deriveDataLayer`.
 * @param model - The model the projection is written against.
 * @param select - The projection, or undefined for the whole row.
 * @returns The split projection, or undefined when nothing was asked for.
 */
export function toProjection(
    relations: RelationMap,
    model: string,
    select: Select | undefined,
): Projection | undefined {
    if (!select) {
        return undefined;
    }
    const entries = Object.entries(select);
    const relation = (key: string): string | undefined =>
        relations[model]?.[key]?.target;
    const fields = entries
        .filter(([key, value]) => value === true && !relation(key))
        .map(([key]) => key);

    // A relation named `true` is the whole related row, not a column to
    // select — the distinction the ORM makes between `select` and `include`.
    const includes = entries
        .filter(
            ([key, value]) =>
                relation(key) && (value === true || isPlainObject(value)),
        )
        .map(([key, value]) => ({
            name: key,
            projection:
                value === true
                    ? undefined
                    : toProjection(
                          relations,
                          relation(key) ?? model,
                          value as Select,
                      ),
        }));

    return fields.length > 0 || includes.length > 0
        ? { fields, includes }
        : undefined;
}

/**
 * Turn a wire ordering into the callbacks `.orderBy()` takes.
 *
 * @remarks
 * One callback per sort key, because `.orderBy()` accepts a single item and
 * additional keys are expressed by chaining it. Returning an array from the
 * callback instead fails deep inside parameter collection with an
 * unrecognisable error, so the shape is pinned here rather than left to a
 * caller to rediscover.
 *
 * @param orderBy - The ordering, or undefined for none.
 * @returns One callback per key, in order; empty when nothing orders it.
 * @example
 * ```typescript
 * toOrdering({ createdAt: 'desc', id: 'asc' }).reduce(
 *     (query, by) => query.orderBy(by),
 *     db.orm.public.Session,
 * );
 * ```
 */
export function toOrdering(
    orderBy: OrderBy | undefined,
): ((fields: Fields) => unknown)[] {
    return Object.entries(orderBy ?? {})
        .filter(([, direction]) => direction === 'asc' || direction === 'desc')
        .map(
            ([key, direction]) =>
                (fields: Fields): unknown =>
                    direction === 'desc'
                        ? fields[key]?.desc()
                        : fields[key]?.asc(),
        );
}
