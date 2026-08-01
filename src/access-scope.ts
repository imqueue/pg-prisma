/*!
 * Prisma access-scope query-extension helper
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

import { Prisma } from '@prisma/client/extension';

/**
 * Per-model access-scope config: `model → level → columns`. A record is in
 * scope for a level when ANY of the level's columns matches (OR); a model is in
 * scope when EVERY active level matches (AND). See the generated
 * `ACCESS_SCOPE_MODELS`.
 */
export type AccessScopeModels = Record<string, Record<string, string[]>>;

/**
 * Resolves the current request's value for one access level:
 * - `undefined` — the level does not constrain this request (skip it),
 * - `null` — active but there is no value → deny (match nothing),
 * - a string — match rows where a scope column equals it,
 * - an array — match rows where a scope column is `IN` it (empty → deny).
 */
export type AccessScopeResolver = () => string | string[] | null | undefined;

/** Everything {@link accessScope} needs to build its extension. */
export interface AccessScopeOptions {
    /** Scope columns per model per level (see the generated config). */
    models: AccessScopeModels;
    /**
     * One resolver per access level, keyed by level name.
     *
     * @remarks
     * A level named in `models` but missing here is skipped entirely, so an
     * unregistered resolver silently widens access rather than denying it. Keep
     * the two keyed consistently.
     */
    resolvers: Record<string, AccessScopeResolver>;
}

type ScopeValue = string | string[] | null;

/** One column's condition for a level value: `=`, `IN`, or the deny sentinel. */
function columnCondition(
    column: string,
    value: ScopeValue,
): Record<string, unknown> {
    if (value === null) {
        // Active but valueless → an impossible filter (nothing is `IN ()`).
        return { [column]: { in: [] as string[] } };
    }
    if (Array.isArray(value)) {
        return { [column]: { in: value } };
    }

    return { [column]: value };
}

/** OR the level's columns: a row is in scope if any column matches the value. */
function levelFilter(
    columns: string[],
    value: ScopeValue,
): Record<string, unknown> {
    return { OR: columns.map(column => columnCondition(column, value)) };
}

/**
 * Compose the access-scope `where` clause for a single model.
 *
 * @remarks
 * Each active level — one whose resolver returns anything other than `undefined` —
 * contributes an OR across its columns, and the level filters are AND-ed together
 * and AND-ed onto the caller's own `where`. Nothing is merged by key, so a caller
 * cannot widen or override the scope by supplying a condition on a scope column.
 *
 * This is the pure half of the mechanism, exported so the composition can be
 * tested and reused directly; {@link accessScope} is what applies it to queries.
 *
 * @param where - The caller's own filter, or undefined.
 * @param config - Scope columns per level for this one model, or undefined when
 *   the model is not scoped.
 * @param resolvers - One resolver per access level, keyed by level name.
 * @returns The combined filter, or `where` unchanged when the model is not scoped
 *   or no level is active — returned by identity, so callers can compare.
 */
export function accessWhere(
    where: Record<string, unknown> | undefined,
    config: Record<string, string[]> | undefined,
    resolvers: Record<string, AccessScopeResolver>,
): Record<string, unknown> | undefined {
    if (!config) {
        return where;
    }
    const filters: Record<string, unknown>[] = [];
    for (const [level, columns] of Object.entries(config)) {
        const resolver = resolvers[level];
        if (!resolver) {
            continue;
        }
        const value = resolver();
        if (value === undefined) {
            continue;
        }
        filters.push(levelFilter(columns, value));
    }
    if (filters.length === 0) {
        return where;
    }

    return { AND: [...(where ? [where] : []), ...filters] };
}

type ReadArgs = { where?: Record<string, unknown> };

/**
 * Build the query extension that restricts queries to the records the active
 * access levels allow.
 *
 * @remarks
 * For each scoped model, every level whose resolver returns a value contributes an
 * OR across that level's columns; the level filters are AND-ed together and AND-ed
 * onto the caller's `where`. A caller therefore cannot widen out of scope, and no
 * scope column can be spoofed by supplying it in the query. A `null` from a
 * resolver denies by matching nothing (`IN ()`), and an array becomes an `IN` —
 * including an empty array, which also denies.
 *
 * Coverage is ten operations: the reads (`findMany`, `findFirst`, `findUnique`,
 * their `OrThrow` variants and `count`) plus `update`, `updateMany`, `delete` and
 * `deleteMany`. On the writes the effect is silent rather than an error — an
 * out-of-scope `updateMany` simply affects no rows, and an out-of-scope `update`
 * throws the ordinary not-found. `create` is deliberately untouched: there is no
 * existing row to filter, and ownership is stamped by {@link authorship}.
 *
 * Relations are never touched. A nested `where`, `include` or `select` is fetched
 * as-is, so reaching a scoped model through a relation bypasses the scope — filter
 * explicitly at those call sites when it matters.
 *
 * @param input - The per-model scope config and one resolver per level.
 * @returns A Prisma extension to pass to `client.$extends()`.
 * @example
 * ```typescript
 * const client = new PrismaClient().$extends(accessScope({
 *     models: ACCESS_SCOPE_MODELS,
 *     resolvers: {
 *         // undefined for an admin: the level does not constrain them at all
 *         tenant: () => context.get()?.tenantId,
 *     },
 * }));
 * ```
 */
export function accessScope({ models, resolvers }: AccessScopeOptions) {
    const restrict = (model: string, args: unknown): void => {
        const config = models[model];
        if (!config) {
            return;
        }
        const a = args as ReadArgs;
        // AND our filters onto the caller's `where` (never merged by key) so the
        // scope cannot be removed or overridden by caller-supplied conditions.
        const scoped = accessWhere(a.where, config, resolvers);
        if (scoped !== a.where) {
            a.where = scoped;
        }
    };

    return Prisma.defineExtension({
        name: 'access-scope',
        query: {
            $allModels: {
                findMany({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                findFirst({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                findFirstOrThrow({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                findUnique({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                findUniqueOrThrow({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                count({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                update({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                updateMany({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                delete({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
                deleteMany({ model, args, query }) {
                    restrict(model, args);
                    return query(args);
                },
            },
        },
    });
}
