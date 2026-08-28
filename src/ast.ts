/*!
 * Prisma Next (8.x) AST helpers shared by the query middlewares
 *
 * I'm Queue Software Project
 * Copyright (C) 2026  imqueue.com <support@imqueue.com>
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

import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
import type {
    AnyExpression,
    AnyQueryAst,
    ParamRef as ParamRefNode,
    SelectAst,
    TableSource,
} from '@prisma/orm-postgres/relational-core/ast';
import {
    AndExpr,
    BinaryExpr,
    ColumnRef,
    ListExpression,
    NullCheckExpr,
    ParamRef,
} from '@prisma/orm-postgres/relational-core/ast';

/**
 * The plan draft `beforeCompile` is handed.
 *
 * @remarks
 * Derived from the middleware's own signature rather than imported: the type
 * is declared in an internal chunk that no public entry re-exports, and
 * restating its shape by hand is how a field like `meta` gets quietly dropped.
 */
export type DraftPlan = NonNullable<
    Awaited<ReturnType<NonNullable<SqlMiddleware['beforeCompile']>>>
>;

/** Text codec every identifier column in this toolkit is stored under. */
export const TEXT = { codecId: 'pg/text@1' } as const;

/** Timestamp codec matching the `TimestamptzString` storage type. */
export const TIMESTAMP = { codecId: 'pg/timestamptz-string@1' } as const;

/** A bound parameter carrying `value` for `column`. */
export function param(
    value: unknown,
    column: string,
    codec: { codecId: string } = TEXT,
): ParamRefNode {
    return ParamRef.of(value, { name: column, codec });
}

/**
 * Conjoin a predicate onto whatever a statement already filters by.
 *
 * @remarks
 * Always an `AND` of the two, never a merge of their keys, so a caller
 * supplying a condition on the same column gets both and cannot widen past
 * ours.
 *
 * @param existing - The statement's own predicate, if any.
 * @param extra - The predicate to add.
 * @returns The combined predicate.
 */
export function conjoin(
    existing: AnyExpression | undefined,
    extra: AnyExpression,
): AnyExpression {
    return existing ? AndExpr.of([existing, extra]) : extra;
}

/**
 * `"<qualifier>"."<column>" IS NULL`.
 *
 * @param qualifier - Table alias where one is set, else the table name.
 * @param column - The column to test.
 * @returns The predicate.
 */
export function isNull(qualifier: string, column: string): AnyExpression {
    return NullCheckExpr.isNull(ColumnRef.of(qualifier, column));
}

/**
 * How a column is referred to inside the statement that selects from it.
 *
 * @remarks
 * A `TableSource` renders as `"public"."Session" AS "s"` when it carries an
 * alias, and a column qualified by the table name is then not in scope at all
 * — Postgres rejects it outright. The alias is the qualifier whenever there is
 * one; the name is only a fallback.
 *
 * @param source - The table source a predicate is being built against.
 * @returns The qualifier to use in a {@link ColumnRef}.
 */
export function qualifierOf(source: TableSource): string {
    return source.alias ?? source.name;
}

/**
 * One scope column's condition: equality, `IN`, or the deny sentinel.
 *
 * @remarks
 * Both shapes bind their values. A list built from `LiteralExpr` would inline
 * request-derived ids into the SQL text — the runtime's own guidance is to
 * reach for `ParamRef` rather than rely on escaping — and would give every
 * distinct id set its own query plan.
 *
 * @param qualifier - Table alias or name the column belongs to.
 * @param column - The scope column.
 * @param value - The level's resolved value; `null` denies.
 * @returns The predicate for this column.
 */
export function columnCondition(
    qualifier: string,
    column: string,
    value: string | string[] | null,
): AnyExpression {
    const ref = ColumnRef.of(qualifier, column);
    if (value === null) {
        return BinaryExpr.in(ref, ListExpression.of([]));
    }
    if (Array.isArray(value)) {
        return BinaryExpr.in(
            ref,
            ListExpression.of(value.map(one => param(one, column))),
        );
    }

    return BinaryExpr.eq(ref, param(value, column));
}

/**
 * Add a predicate to every `SELECT` in a statement that reads a given table.
 *
 * @remarks
 * **This is the whole reason the middlewares are not a table lookup on the
 * root of the statement.** Prisma Next compiles a relation read into one
 * statement containing several selects — the related rows arrive through a
 * nested select, and a paginated read wraps its subject in a derived table. A
 * filter applied only to the outermost `from` therefore misses every nested
 * read and returns the rows it was meant to exclude, with nothing logged.
 * `AnyQueryAst.rewrite` walks the whole tree, so one pass covers the root, the
 * joins, the projection subqueries and the derived sources alike.
 *
 * `rewrite` always returns a fresh node, so whether anything was actually
 * filtered is reported rather than inferred from identity — a middleware that
 * returned a new draft unconditionally would log a rewrite on every query it
 * did not touch.
 *
 * @param ast - The statement to rewrite.
 * @param predicateFor - Given a table name and the qualifier to write columns
 *   against, the predicate to conjoin, or null to leave that select alone.
 * @returns The statement, and whether any select gained a predicate.
 */
export function filterSelects(
    ast: AnyQueryAst,
    predicateFor: (table: string, qualifier: string) => AnyExpression | null,
): { ast: AnyQueryAst; changed: boolean } {
    const state = { changed: false };
    const rewritten = ast.rewrite({
        select: (node: SelectAst): SelectAst => {
            const from = node.from;
            if (from?.kind !== 'table-source') {
                return node;
            }
            const predicate = predicateFor(from.name, qualifierOf(from));
            if (!predicate) {
                return node;
            }
            state.changed = true;

            return node.withWhere(conjoin(node.where, predicate));
        },
    });

    return { ast: rewritten, changed: state.changed };
}
