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

/** Per-model soft-delete config: the `deletedAt` column name. */
export type SoftDeleteModels = Record<string, { deletedAt: string }>;

export interface SoftDeleteOptions {
    client: PrismaClient;
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
 * Query extension turning soft-delete models' deletes into `deletedAt` stamps and
 * filtering soft-deleted rows out of top-level reads. Deletes also target only
 * live rows — re-deleting never overwrites the original stamp (a single `delete`
 * of an already-deleted row therefore throws not-found, like any absent row).
 * `findUnique` relies on extended where-unique: non-unique scalars (here
 * `deletedAt`) are valid extra filters alongside the unique key.
 *
 * Caveat: reads *through relations* (nested `include`/`select` of a soft-delete
 * model from another model) are not intercepted and DO return soft-deleted
 * rows — filter explicitly at such call sites (e.g. `where: { deletedAt: null }`
 * on the nested relation) when it matters.
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
