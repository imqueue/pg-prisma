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

export interface AccessScopeOptions {
    /** Scope columns per model per level (see the generated config). */
    models: AccessScopeModels;
    /** One resolver per access level, keyed by level name. */
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
 * Compose the access-scope `where` for a single model: each active level (its
 * resolver returns a value other than `undefined`) contributes an OR over its
 * columns, all AND-ed onto the caller's `where`. Returns `where` unchanged when
 * the model isn't scoped or no level is active. Pure — the extension applies it.
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
 * Query extension restricting a request to the records the active access levels
 * allow. For each scoped model, every level whose resolver returns a value (not
 * `undefined`) contributes an OR-over-its-columns filter; the level filters are
 * AND-ed together and AND-ed onto the caller's `where` — so a caller can never
 * widen out of scope, and no scope column can be spoofed. A level with a `null`
 * value denies (matches nothing); an array value becomes an `IN`.
 *
 * Applies to reads and, in skip mode, to `update`/`delete` and their `*Many`
 * forms (a write silently affects only in-scope rows). `create` is left alone
 * (authorship stamps ownership; there is nothing to filter). Relations are never
 * touched — nested `where`/`include`/`select` are fetched as-is.
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
