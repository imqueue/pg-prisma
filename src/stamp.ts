/*!
 * Prisma Next (8.x) soft-delete and authorship query middleware
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
    ParamRef,
} from '@prisma/orm-postgres/relational-core/ast';
import { UpdateAst } from '@prisma/orm-postgres/relational-core/ast';
import {
    conjoin,
    filterSelects,
    isNull,
    param,
    qualifierOf,
    type DraftPlan,
    TIMESTAMP,
} from './ast.js';
import type { StampColumns, StampTables } from './derive.js';

/** Everything {@link stamp} needs to build its middleware. */
export interface StampOptions {
    /** Soft-delete and authorship columns per physical table. */
    tables: StampTables;
    /**
     * Resolves the id of the actor performing the current write, or null when
     * there is none (system or unauthenticated).
     */
    getActorId: () => string | null;
}

/** The stamps this middleware writes; a `ParamRef` is valid in both an
 * `INSERT` row and an `UPDATE` assignment, where `AnyExpression` is not. */
type Assignments = Record<string, ParamRef>;

/** Whether an assignment sets a value that is not null. */
function setsValue(
    assignments: Readonly<Record<string, AnyExpression>>,
    column?: string,
): boolean {
    if (!column) {
        return false;
    }
    const assigned = assignments[column] as { value?: unknown } | undefined;

    return assigned !== undefined && assigned.value !== null;
}

/**
 * Build the middleware that stamps authorship and turns deletes into stamps.
 *
 * @remarks
 * One middleware rather than two because the two halves are inseparable: a
 * soft delete only exists as an `update` **because** this rewrote the `delete`
 * into one, and only this knows that the update it is stamping is a deletion.
 * Split across two middlewares — as the Prisma 7 extensions were — the second
 * has to infer the deletion from the assignments, and the pair has to be
 * ordered correctly by every caller, with `deletedBy` silently never written
 * when it is not. Neither hazard can be expressed here.
 *
 * Reads are filtered across the **whole statement**, not just its outermost
 * `from`, so a soft-deleted row reached through a relation is excluded too.
 *
 * A null actor stamps null rather than skipping the column, which is what
 * makes a system write distinguishable from one whose author was never
 * recorded.
 *
 * @param input - Per-table columns and the actor resolver.
 * @returns Middleware for the `middleware` array of the `postgres()` factory.
 */
export function stamp({ tables, getActorId }: StampOptions): SqlMiddleware {
    const author = (column: string): ParamRef => param(getActorId(), column);

    // Bound under the column's own codec: an `INSERT` accepts a parameter but
    // not a function call, so the value is produced here — which is also what
    // Prisma 7's `@updatedAt` did.
    const stampedAt = (columns: StampColumns, column: string): ParamRef =>
        param(new Date().toISOString(), column, {
            codecId: columns.timestampCodec ?? TIMESTAMP.codecId,
        });

    const authored = (
        columns: StampColumns,
        deleting: boolean,
    ): Assignments => ({
        // Prisma 7 wrote this through `@updatedAt`, which Prisma Next has no
        // equivalent of; without it the column is NOT NULL with no default and
        // every insert fails.
        ...(columns.updatedAt
            ? { [columns.updatedAt]: stampedAt(columns, columns.updatedAt) }
            : {}),
        ...(columns.updatedBy
            ? { [columns.updatedBy]: author(columns.updatedBy) }
            : {}),
        ...(deleting && columns.deletedBy
            ? { [columns.deletedBy]: author(columns.deletedBy) }
            : {}),
    });

    return {
        name: 'stamp',
        familyId: 'sql' as const,
        async beforeCompile(draft: DraftPlan): Promise<DraftPlan | undefined> {
            const ast = draft.ast;

            if (ast.kind === 'select') {
                const filtered = filterSelects(ast, (table, qualifier) => {
                    const column = tables[table]?.deletedAt;

                    return column ? isNull(qualifier, column) : null;
                });

                return filtered.changed
                    ? { ...draft, ast: filtered.ast }
                    : undefined;
            }

            if (ast.kind === 'insert') {
                const columns = tables[ast.table.name];
                if (!columns) {
                    return undefined;
                }
                const stamps: Assignments = {
                    ...(columns.createdBy
                        ? { [columns.createdBy]: author(columns.createdBy) }
                        : {}),
                    ...authored(columns, false),
                };

                return {
                    ...draft,
                    ast: ast.withRows(
                        ast.rows.map(row => ({ ...row, ...stamps })),
                    ),
                };
            }

            if (ast.kind === 'update') {
                const columns = tables[ast.table.name];
                if (!columns) {
                    return undefined;
                }
                // Only a write that sets the column to a real timestamp is a
                // deletion. Setting it to null is a restore, and stamping
                // `deletedBy` there would name whoever brought the row back.
                const deleting = setsValue(ast.set, columns.deletedAt);
                const alive = columns.deletedAt
                    ? isNull(qualifierOf(ast.table), columns.deletedAt)
                    : undefined;

                return {
                    ...draft,
                    ast: ast
                        .withSet({ ...ast.set, ...authored(columns, deleting) })
                        .withWhere(
                            alive && !deleting
                                ? conjoin(ast.where, alive)
                                : ast.where,
                        ),
                };
            }

            if (ast.kind === 'delete') {
                const columns = tables[ast.table.name];
                if (!columns?.deletedAt) {
                    return undefined;
                }
                const alive = isNull(qualifierOf(ast.table), columns.deletedAt);

                return {
                    ...draft,
                    // The RETURNING clause has to survive: it is what hands the
                    // caller the row it deleted, and what lets `audit` see a
                    // soft delete at all.
                    ast: UpdateAst.table(ast.table)
                        .withSet({
                            [columns.deletedAt]: stampedAt(
                                columns,
                                columns.deletedAt,
                            ),
                            ...authored(columns, true),
                        })
                        .withWhere(conjoin(ast.where, alive))
                        .withReturning(ast.returning),
                };
            }

            return undefined;
        },
    };
}
