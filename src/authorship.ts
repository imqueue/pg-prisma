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

/** Per-model authorship column names, plus the delete-trigger column. */
export interface AuthorshipColumns {
    createdBy: string;
    updatedBy: string;
    deletedBy: string;
    /** Soft-delete column whose being-set makes an update stamp `deletedBy`. */
    deletedAt?: string;
}

export type AuthorshipModels = Record<string, AuthorshipColumns>;

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
 * Query extension stamping the acting principal onto authored models: `createdBy`
 * + `updatedBy` on create, `updatedBy` on update, and `deletedBy` whenever a
 * write sets the model's soft-delete column (so soft-deletes routed through this
 * client — see `softDelete` — record who deleted the row). Column names are
 * per-model (see the generated `AUTHORSHIP_MODELS`). The actor id is resolved
 * lazily via `getActorId`; when it is null (a system or unauthenticated write)
 * nothing is stamped. Non-authored models pass through untouched. Stamps
 * override caller-supplied values so authorship can't be spoofed.
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
