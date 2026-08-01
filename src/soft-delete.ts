/*!
 * Prisma soft-delete query extension
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

import { Prisma, type PrismaClient } from '@prisma/client/extension';

/**
 * Which models are soft-deleted, and which column carries the stamp.
 *
 * @remarks
 * Keyed by Prisma model name; the `deletedAt` value is the column that holds the
 * deletion timestamp, so it does not have to be literally named `deletedAt`. A
 * model absent from this map is untouched — its deletes are real deletes. The
 * code generator emits this config from your schema, so it normally comes from
 * there rather than being written by hand.
 */
export type SoftDeleteModels = Record<string, { deletedAt: string }>;

/** Everything {@link softDelete} needs to build its extension. */
export interface SoftDeleteOptions {
    /**
     * The UNEXTENDED Prisma client, used to reroute deletes into updates.
     *
     * @remarks
     * Passing the extended client here would send the rerouted update back
     * through this same extension.
     */
    client: PrismaClient;
    /** Which models are soft-deleted, and the column holding the stamp. */
    models: SoftDeleteModels;
}

const accessor = (model: string): string =>
    model.charAt(0).toLowerCase() + model.slice(1);

function excludeDeleted(
    model: string,
    args: unknown,
    softDeleteModels: SoftDeleteModels,
): void {
    const column = softDeleteModels[model]?.deletedAt;
    if (column) {
        const withWhere = args as { where?: object };
        withWhere.where = { [column]: null, ...withWhere.where };
    }
}

/**
 * Build the query extension that turns deletes into `deletedAt` stamps and hides
 * stamped rows from reads.
 *
 * @remarks
 * For every model listed in `models`, `delete` and `deleteMany` become an
 * `update`/`updateMany` that writes the current time into the configured column,
 * and the read operations (`findMany`, `findFirst`, `findUnique`, their `OrThrow`
 * variants and `count`) gain a `<column>: null` filter. Models not listed pass
 * straight through, deletes included.
 *
 * Deletes themselves also filter on `<column>: null`, so only live rows are
 * deletable and an original stamp is never overwritten by a second delete. The
 * consequence is worth stating plainly: deleting an already-soft-deleted row
 * throws not-found, exactly as deleting a row that was never there does.
 *
 * `findUnique` works here because Prisma's extended where-unique accepts
 * non-unique scalars as extra filters alongside the unique key.
 *
 * The filter is applied to TOP-LEVEL reads only. A nested `include` or `select`
 * that reaches a soft-deleted model through a relation is not intercepted, and it
 * DOES return stamped rows; add `where: { deletedAt: null }` to the nested
 * relation at those call sites when it matters.
 *
 * @param input - The unextended client and the per-model column config.
 * @returns A Prisma extension to pass to `client.$extends()`.
 * @example
 * ```typescript
 * const base = new PrismaClient();
 * const client = base.$extends(softDelete({
 *     client: base,
 *     models: { User: { deletedAt: 'deletedAt' } },
 * }));
 *
 * await client.user.delete({ where: { id } }); // stamps, does not remove
 * await client.user.findMany();                // stamped rows are absent
 * ```
 */
export function softDelete({ client, models }: SoftDeleteOptions) {
    return Prisma.defineExtension({
        name: 'soft-delete',
        query: {
            $allModels: {
                findMany({ model, args, query }) {
                    excludeDeleted(model, args, models);
                    return query(args);
                },
                findFirst({ model, args, query }) {
                    excludeDeleted(model, args, models);
                    return query(args);
                },
                findFirstOrThrow({ model, args, query }) {
                    excludeDeleted(model, args, models);
                    return query(args);
                },
                findUnique({ model, args, query }) {
                    excludeDeleted(model, args, models);
                    return query(args);
                },
                findUniqueOrThrow({ model, args, query }) {
                    excludeDeleted(model, args, models);
                    return query(args);
                },
                count({ model, args, query }) {
                    excludeDeleted(model, args, models);
                    return query(args);
                },
                delete({ model, args, query }) {
                    const column = models[model]?.deletedAt;
                    if (!column) {
                        return query(args);
                    }

                    // Only live rows are deletable — an already-soft-deleted
                    // row is "absent", so its original stamp is never
                    // overwritten (matches how reads treat it).
                    return (client as any)[accessor(model)].update({
                        where: {
                            [column]: null,
                            ...(args as { where: object }).where,
                        },
                        data: { [column]: new Date() },
                    });
                },
                deleteMany({ model, args, query }) {
                    const column = models[model]?.deletedAt;
                    if (!column) {
                        return query(args);
                    }

                    return (client as any)[accessor(model)].updateMany({
                        where: {
                            [column]: null,
                            ...(args as { where?: object }).where,
                        },
                        data: { [column]: new Date() },
                    });
                },
            },
        },
    });
}
