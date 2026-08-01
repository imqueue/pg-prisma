/*!
 * Prisma authorship-stamping query extension
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

/** Which columns on one model carry authorship, and which one triggers a delete stamp. */
export interface AuthorshipColumns {
    /** Column stamped once, when the row is created. */
    createdBy: string;
    /** Column stamped on create and on every update. */
    updatedBy: string;
    /** Column stamped when an update sets `deletedAt`. */
    deletedBy: string;
    /**
     * Soft-delete column whose being set makes an update stamp `deletedBy`.
     *
     * @remarks
     * Optional: a model without one simply never stamps `deletedBy`. The
     * extension looks at the incoming `data` for this key rather than at the
     * stored row, so it stamps whenever a write is setting the column to a
     * non-null value — which is what a soft delete rerouted through
     * {@link softDelete} looks like.
     */
    deletedAt?: string;
}

/**
 * Which models carry authorship, keyed by Prisma model name.
 *
 * @remarks
 * A model absent from this map passes through untouched. The code generator emits
 * this as `AUTHORSHIP_MODELS`, so it normally comes from your schema rather than
 * being written by hand.
 */
export type AuthorshipModels = Record<string, AuthorshipColumns>;

/** Everything {@link authorship} needs to build its extension. */
export interface AuthorshipOptions {
    /** Per-model authorship column config (the models to stamp). */
    models: AuthorshipModels;
    /**
     * Resolves the id of the actor performing the current write, or null when
     * there is none (system/unauthenticated). The extension is deliberately
     * ignorant of *where* the id comes from — the caller supplies it (e.g. from
     * the request context).
     */
    getActorId: () => string | null;
}

type WriteArgs = {
    data?: Record<string, unknown> | Record<string, unknown>[];
    create?: Record<string, unknown>;
    update?: Record<string, unknown>;
};

/** Drop any caller-supplied authorship fields — the plugin is their sole writer. */
function stripAuthorship(
    data: Record<string, unknown>,
    cols: AuthorshipColumns,
): Record<string, unknown> {
    const clean = { ...data };
    delete clean[cols.createdBy];
    delete clean[cols.updatedBy];
    delete clean[cols.deletedBy];

    return clean;
}

/**
 * Build the query extension that stamps who created, updated or deleted a row.
 *
 * @remarks
 * Five operations are covered. `create` and `createMany` stamp `createdBy` and
 * `updatedBy` (each element of a `createMany` array individually). `update` and
 * `updateMany` stamp `updatedBy`, plus `deletedBy` when the write is also setting
 * the model's `deletedAt` column — which is what a soft delete rerouted by
 * {@link softDelete} looks like from here. `upsert` stamps its `create` and
 * `update` branches with the matching rule, resolving the actor once for both.
 *
 * Authorship cannot be spoofed: any caller-supplied value for the three
 * authorship columns is stripped from `data` before the stamp is applied, so this
 * extension is their sole writer. That holds even when there is no actor — with
 * `getActorId` returning null, the caller's values are still removed and nothing
 * is written in their place, so a system write leaves the columns untouched
 * rather than taking whatever the caller passed.
 *
 * Models absent from `models` pass through completely untouched, authorship
 * columns included.
 *
 * @param input - The per-model column config and the actor resolver.
 * @returns A Prisma extension to pass to `client.$extends()`.
 * @example
 * ```typescript
 * const client = new PrismaClient().$extends(authorship({
 *     models: AUTHORSHIP_MODELS,
 *     getActorId: () => context.get()?.userId ?? null,
 * }));
 * ```
 */
export function authorship({ models, getActorId }: AuthorshipOptions) {
    const forCreate = (
        data: Record<string, unknown>,
        cols: AuthorshipColumns,
        by: string | null,
    ): Record<string, unknown> => {
        const clean = stripAuthorship(data, cols);

        return by === null
            ? clean
            : { ...clean, [cols.createdBy]: by, [cols.updatedBy]: by };
    };

    const forUpdate = (
        data: Record<string, unknown>,
        cols: AuthorshipColumns,
        by: string | null,
    ): Record<string, unknown> => {
        const clean = stripAuthorship(data, cols);
        if (by === null) {
            return clean;
        }
        const deleting =
            cols.deletedAt !== undefined && data[cols.deletedAt] != null;

        return {
            ...clean,
            [cols.updatedBy]: by,
            ...(deleting ? { [cols.deletedBy]: by } : {}),
        };
    };

    return Prisma.defineExtension({
        name: 'authorship',
        query: {
            $allModels: {
                create({ model, args, query }) {
                    const cols = models[model];
                    if (cols) {
                        const a = args as WriteArgs;
                        a.data = forCreate(
                            (a.data as Record<string, unknown>) ?? {},
                            cols,
                            getActorId(),
                        );
                    }

                    return query(args);
                },
                createMany({ model, args, query }) {
                    const cols = models[model];
                    if (cols) {
                        const by = getActorId();
                        const a = args as WriteArgs;
                        a.data = Array.isArray(a.data)
                            ? a.data.map(d => forCreate(d, cols, by))
                            : forCreate(a.data ?? {}, cols, by);
                    }

                    return query(args);
                },
                update({ model, args, query }) {
                    const cols = models[model];
                    if (cols) {
                        const a = args as WriteArgs;
                        a.data = forUpdate(
                            (a.data as Record<string, unknown>) ?? {},
                            cols,
                            getActorId(),
                        );
                    }

                    return query(args);
                },
                updateMany({ model, args, query }) {
                    const cols = models[model];
                    if (cols) {
                        const a = args as WriteArgs;
                        a.data = forUpdate(
                            (a.data as Record<string, unknown>) ?? {},
                            cols,
                            getActorId(),
                        );
                    }

                    return query(args);
                },
                upsert({ model, args, query }) {
                    const cols = models[model];
                    if (cols) {
                        const by = getActorId();
                        const a = args as WriteArgs;
                        a.create = forCreate(a.create ?? {}, cols, by);
                        a.update = forUpdate(a.update ?? {}, cols, by);
                    }

                    return query(args);
                },
            },
        },
    });
}
