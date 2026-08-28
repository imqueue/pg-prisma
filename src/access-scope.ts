/*!
 * Prisma Next (8.x) access-scope query middleware
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
import type { AnyExpression } from '@prisma/orm-postgres/relational-core/ast';
import { AndExpr, OrExpr } from '@prisma/orm-postgres/relational-core/ast';
import {
    type DraftPlan,
    columnCondition,
    conjoin,
    filterSelects,
    qualifierOf,
} from './ast.js';
import type { ScopeTables } from './derive.js';

/**
 * Resolves the current request's value for one access level:
 * - `undefined` — the level does not constrain this request (skip it),
 * - `null` — active but valueless, so deny (match nothing),
 * - a string — match rows where a scope column equals it,
 * - an array — match rows where a scope column is `IN` it (empty denies).
 */
export type AccessScopeResolver = () => string | string[] | null | undefined;

/** Everything {@link accessScope} needs to build its middleware. */
export interface AccessScopeOptions {
    /** Scope columns per physical table per level. */
    tables: ScopeTables;
    /**
     * One resolver per access level, keyed by level name.
     *
     * @remarks
     * A level named in `tables` but missing here is skipped entirely, so an
     * unregistered resolver silently widens access rather than denying it.
     */
    resolvers: Record<string, AccessScopeResolver>;
}

/**
 * Compose the scope predicate for one table, or null when nothing constrains
 * it.
 *
 * @remarks
 * Each active level contributes an OR across its columns and the levels are
 * AND-ed together. Exported so the composition can be tested without a
 * database — getting it inverted leaks rows rather than raising an error.
 *
 * A level configured with no columns yields an empty OR, which Postgres reads
 * as `FALSE`: it denies everything. That is the safe direction, and it is what
 * an empty column list should mean.
 *
 * @param qualifier - Table alias or name to build columns against.
 * @param levels - Scope columns per level for this one table.
 * @param resolvers - One resolver per access level.
 * @returns The predicate, or null when no level is active.
 */
export function scopePredicate(
    qualifier: string,
    levels: Record<string, string[]> | undefined,
    resolvers: Record<string, AccessScopeResolver>,
): AnyExpression | null {
    if (!levels) {
        return null;
    }
    const active = Object.entries(levels)
        .filter(([level]) => resolvers[level])
        .map(([level, columns]) => ({
            columns,
            value: resolvers[level]?.(),
        }))
        .filter(entry => entry.value !== undefined)
        .map(entry =>
            OrExpr.of(
                entry.columns.map(column =>
                    columnCondition(
                        qualifier,
                        column,
                        entry.value as string | string[] | null,
                    ),
                ),
            ),
        );
    if (active.length === 0) {
        return null;
    }

    return active.length === 1
        ? (active[0] as AnyExpression)
        : AndExpr.of(active);
}

/**
 * Build the middleware restricting statements to the records a caller may see.
 *
 * @remarks
 * The predicate is AND-ed onto whatever the statement already filters by, so a
 * caller cannot widen out of scope and no scope column can be spoofed by
 * supplying it in the query. `insert` is deliberately untouched: there is no
 * existing row to filter, and ownership is stamped by `stamp`.
 *
 * Reads are filtered across the **whole statement**. Prisma Next compiles a
 * relation read into one statement holding several selects, so a filter on the
 * outermost `from` alone would return out-of-scope rows through any `include`
 * — the exact bypass the Prisma 7 extension documented as a limitation.
 *
 * @param input - Per-table scope config and one resolver per level.
 * @returns Middleware for the `middleware` array of the `postgres()` factory.
 */
export function accessScope({
    tables,
    resolvers,
}: AccessScopeOptions): SqlMiddleware {
    return {
        name: 'access-scope',
        familyId: 'sql' as const,
        async beforeCompile(draft: DraftPlan): Promise<DraftPlan | undefined> {
            const ast = draft.ast;

            if (ast.kind === 'select') {
                const filtered = filterSelects(ast, (table, qualifier) =>
                    scopePredicate(qualifier, tables[table], resolvers),
                );

                return filtered.changed
                    ? { ...draft, ast: filtered.ast }
                    : undefined;
            }

            if (ast.kind === 'update' || ast.kind === 'delete') {
                const predicate = scopePredicate(
                    qualifierOf(ast.table),
                    tables[ast.table.name],
                    resolvers,
                );

                return predicate
                    ? {
                          ...draft,
                          ast: ast.withWhere(conjoin(ast.where, predicate)),
                      }
                    : undefined;
            }

            return undefined;
        },
    };
}
