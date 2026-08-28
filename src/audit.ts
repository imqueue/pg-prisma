/*!
 * Prisma Next (8.x) audit query middleware
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

import pg from 'pg';
import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
import type { AnyQueryAst } from '@prisma/orm-postgres/relational-core/ast';
import type { StampTables } from './derive.js';

/** The three write actions the trail records. */
export const AuditAction = {
    INSERT: 'INSERT',
    UPDATE: 'UPDATE',
    DELETE: 'DELETE',
} as const;

/** One of the three {@link (AuditAction:variable) | AuditAction} values. */
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Column names within the audit table.
 *
 * @remarks
 * Every one defaults to its own name, so a table whose columns are spelled the
 * obvious way is configured by saying nothing. Name only what differs.
 */
export interface AuditColumns {
    /** Column holding the JSON actor, as returned by `getPrincipal`. */
    principal?: string;
    /** Column holding the action string. */
    action?: string;
    /** Column holding the name of the model that was written. */
    modelName?: string;
    /** Column holding the affected record's `id`. */
    recordId?: string;
    /** Column holding the JSON payload of the written row. */
    changes?: string;
    /** Column stamped with the database's `now()` at insert time. */
    createdAt?: string;
}

/** Where the trail goes and what its columns are called. */
export interface AuditConfig {
    /** Table the trail is inserted into. Default `AuditLog`. */
    table?: string;
    /** Column names within that table, where they differ from the defaults. */
    columns?: AuditColumns;
}

/** The table and columns an audit trail has unless it says otherwise. */
const DEFAULTS = {
    table: 'AuditLog',
    columns: {
        principal: 'principal',
        action: 'action',
        modelName: 'modelName',
        recordId: 'recordId',
        changes: 'changes',
        createdAt: 'createdAt',
    },
} as const;

/** Everything {@link audit} needs to build its middleware. */
export interface AuditOptions {
    /**
     * Connection string for the trail's own pool.
     *
     * @remarks
     * Deliberately a second connection rather than the client being audited:
     * rows written through that client would themselves be audited, and the
     * first write would not terminate.
     */
    connectionString: string;
    /** Where the trail goes. Omitted entirely, the defaults apply. */
    config?: AuditConfig;
    /** Physical table to model name, for the tables that are recorded. */
    tables: Record<string, string>;
    /** Soft-delete columns, so a stamped delete is recorded as a delete. */
    stamps?: StampTables;
    /** Resolves the actor to record, or a falsy value to record none. */
    getPrincipal: () => unknown;
}

interface Entry {
    action: AuditAction;
    model: string;
    row: Record<string, unknown>;
}

interface Batch {
    principal: string | null;
    entries: Entry[];
}

interface Plan {
    readonly ast?: AnyQueryAst;
}

/**
 * Build the middleware recording every write to the tables it is given.
 *
 * @remarks
 * Rows are captured as the database returns them, so the trail holds what was
 * actually written — including values defaulted in SQL — and is inserted once
 * the statement completes.
 *
 * **Buffered per execution, not per client.** `onRow` is called from an async
 * generator, so two concurrent statements on one client interleave at every
 * row. A single shared buffer lets one statement's `afterQuery` flush the
 * other's rows and stamp them with the wrong actor, which on a security trail
 * is the worst failure available. Keying by the plan object confines each
 * statement to its own rows, and a `WeakMap` drops the buffer of a statement
 * that is never drained — an early `break`, or a `first()` — rather than
 * leaking it into whatever flushes next.
 *
 * The actor is resolved at the **first row**, inside the statement's own async
 * context, for the same reason.
 *
 * Call {@link close} when shutting down, or the pool keeps the process alive.
 *
 * @param input - The trail's connection, table config, tables and actor.
 * @returns Middleware with a `close()` for teardown.
 */
export function audit({
    connectionString,
    config = {},
    tables,
    stamps = {},
    getPrincipal,
}: AuditOptions): SqlMiddleware & { close(): Promise<void> } {
    const pool = new pg.Pool({ connectionString });
    const table = config.table ?? DEFAULTS.table;
    const col = { ...DEFAULTS.columns, ...config.columns };
    const pending = new WeakMap<object, Batch>();

    const tableOf = (ast?: AnyQueryAst): string | undefined =>
        ast?.kind === 'insert' ||
        ast?.kind === 'update' ||
        ast?.kind === 'delete'
            ? ast.table.name
            : undefined;

    const actionOf = (
        ast: AnyQueryAst,
        table: string,
    ): AuditAction | undefined => {
        if (ast.kind === 'insert') {
            return AuditAction.INSERT;
        }
        if (ast.kind === 'delete') {
            return AuditAction.DELETE;
        }
        if (ast.kind !== 'update') {
            return undefined;
        }
        // A soft delete reaches here as an update, because `stamp` rewrote it.
        // Classifying on the assignment keeps DELETE reachable for exactly the
        // models where a real DELETE never happens.
        const column = stamps[table]?.deletedAt;
        const assigned = column
            ? (ast.set[column] as { value?: unknown } | undefined)
            : undefined;

        return assigned !== undefined && assigned.value !== null
            ? AuditAction.DELETE
            : AuditAction.UPDATE;
    };

    return {
        name: 'audit',
        familyId: 'sql' as const,
        /** Ends the trail's pool. */
        close: (): Promise<void> => pool.end(),
        async onRow(row: Record<string, unknown>, plan: Plan): Promise<void> {
            const ast = plan?.ast;
            const table = tableOf(ast);
            const model = table ? tables[table] : undefined;
            if (
                !ast ||
                !table ||
                !model ||
                row.id === undefined ||
                row.id === null
            ) {
                return;
            }
            const action = actionOf(ast, table);
            if (!action) {
                return;
            }
            const batch = pending.get(plan) ?? {
                principal: (() => {
                    const actor = getPrincipal();

                    return actor ? JSON.stringify(actor) : null;
                })(),
                entries: [],
            };
            batch.entries.push({ action, model, row });
            pending.set(plan, batch);
        },
        async afterQuery(
            plan: Plan,
            result: { readonly completed?: boolean },
            ctx: { readonly log?: { warn?: (m: string, f?: unknown) => void } },
        ): Promise<void> {
            const batch = pending.get(plan);
            pending.delete(plan);
            // A statement that threw still reaches here, with `completed`
            // false. Recording those would put writes in the trail that the
            // database rolled back.
            if (
                !batch ||
                batch.entries.length === 0 ||
                result?.completed === false
            ) {
                return;
            }
            const values = batch.entries
                .map(
                    (_entry, i) =>
                        `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, ` +
                        `$${i * 4 + 3}, $${batch.entries.length * 4 + 1}::jsonb, ` +
                        `$${i * 4 + 4}::jsonb, now())`,
                )
                .join(', ');
            const params = batch.entries.flatMap(entry => [
                entry.action,
                entry.model,
                String(entry.row.id),
                JSON.stringify(entry.row),
            ]);
            await pool
                .query(
                    `INSERT INTO "${table}" ("id", "${col.action}", ` +
                        `"${col.modelName}", "${col.recordId}", "${col.principal}", ` +
                        `"${col.changes}", "${col.createdAt}") VALUES ${values}`,
                    [...params, batch.principal],
                )
                .then(
                    () => undefined,
                    // An audit that cannot be written must not fail the write
                    // it was recording — but a trail that silently stops is
                    // worse than one that is noisy about stopping.
                    (error: unknown) => {
                        ctx?.log?.warn?.('audit trail insert failed', {
                            error,
                        });
                    },
                );
        },
    };
}
