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

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
import type { AnyQueryAst } from '@prisma/orm-postgres/relational-core/ast';
import type { StampTables } from './derive.js';
import { survivesLostConnections } from './pool.js';

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
    /**
     * Settings for the trail's own pool — its size, how long an idle
     * connection is kept, timeouts. Omitted, `pg`'s defaults apply.
     *
     * @remarks
     * The trail writes once per audited statement, so it wants about as many
     * connections as the client it audits; `pg`'s default of ten is more than
     * a deliberately small data pool and doubles what one process holds.
     */
    pool?: Omit<pg.PoolConfig, 'connectionString'>;
    /** Where the trail goes. Omitted entirely, the defaults apply. */
    config?: AuditConfig;
    /** Physical table to model name, for the tables that are recorded. */
    tables: Record<string, string>;
    /** Soft-delete columns, so a stamped delete is recorded as a delete. */
    stamps?: StampTables;
    /** Resolves the actor to record, or a falsy value to record none. */
    getPrincipal: () => unknown;
    /**
     * Told whenever the trail could not record a write as it should, in
     * place of the default report.
     *
     * @remarks
     * A trail that cannot be written must not fail the write it records, so
     * a failure is reported instead of thrown: the insert was refused
     * (`error.cause` is the driver's error), or a write ran in a transaction
     * while no client has been passed through `bind()`, which is said once.
     *
     * Omitted, the message goes to `console.error`, and to the runtime's
     * `ctx.log.warn` as well when there is one. `console.error` is what makes
     * it visible: `postgres()` does not forward a `log` to the runtime it
     * builds, so there `ctx.log` is a no-op, and only a runtime constructed by
     * hand has a log to hear it. Given, this replaces both, so a failure is
     * reported once, where the application decided.
     */
    onError?: (error: Error) => void;
}

/** The part of the runtime's log the trail reports to. */
interface RuntimeLog {
    warn?(event: unknown): void;
}

interface Entry {
    action: AuditAction;
    model: string;
    row: Record<string, unknown>;
}

interface Batch {
    principal: string | null;
    entries: Entry[];
    /** The runtime log of the statement, kept for a write made later. */
    log?: RuntimeLog | undefined;
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
 * **A write in a transaction is recorded once the transaction commits.** The
 * trail is written through its own pool, so a row inserted when the statement
 * completes stays in the trail when the transaction rolls back afterwards —
 * a write that never happened, attributed to a real actor. The middleware is
 * told only that a statement ran in *a* transaction, not which one or how it
 * ended, so the client is passed through `bind()`: its `transaction` then
 * holds the trail rows of the writes made inside it, writes them once COMMIT
 * has succeeded, and drops them when it rolls back. A crash between the
 * commit and that insert loses them; the trail errs towards missing a write
 * rather than recording one that did not happen.
 *
 * Two kinds of transaction are not seen by `bind()` and are recorded when the
 * statement completes, as before: one opened on a client that was not bound
 * — said once through `onError` while no client is bound — and the one the
 * ORM opens for itself around a top-level `db.orm` `update()`, `delete()` or
 * nested write, which leaves a trail row behind if its COMMIT fails. For an
 * audited table, write through `repositoriesFor` instead: its writes are
 * single statements, with no transaction around them and so no such window.
 *
 * Inside a bound transaction, write only through `tx`. A write through the
 * outer client runs on another connection and commits on its own, but its
 * rows are held with the transaction's — and dropped with them when the
 * transaction rolls back, leaving a committed write unrecorded.
 *
 * Call `close()` on the returned middleware when shutting down, or the pool
 * keeps the process alive.
 *
 * @param input - The trail's connection, table config, tables and actor.
 * @returns Middleware with a `close()` for teardown and a `bind()` for the
 * client it is installed on.
 * @example
 * ```typescript
 * const trail = audit({ connectionString, tables, getPrincipal });
 * const db = trail.bind(
 *     postgres<Contract>({ contractJson, url, middleware: [trail] }),
 * );
 *
 * await db.transaction(async tx => {
 *     await tx.orm.public.Invoice.where({ id }).update({ amount });
 *     await charge(); // throws: the update rolls back and is not recorded
 * });
 * ```
 */
export function audit({
    connectionString,
    pool: settings = {},
    config = {},
    tables,
    stamps = {},
    getPrincipal,
    onError,
}: AuditOptions): SqlMiddleware & {
    /** Ends the trail's pool. */
    close(): Promise<void>;
    /**
     * The client, with the writes of its transactions recorded on commit.
     *
     * @remarks
     * Everything but `transaction` is the client's own. A client with no
     * `transaction` of its own — one already inside a transaction — is
     * returned as it is.
     */
    bind<Client extends object>(client: Client): Client;
} {
    const pool = survivesLostConnections(
        new pg.Pool({ ...settings, connectionString }),
    );
    const table = config.table ?? DEFAULTS.table;
    const col = { ...DEFAULTS.columns, ...config.columns };
    const pending = new WeakMap<object, Batch>();
    // The trail rows held by the bound transaction a statement runs in.
    const open = new AsyncLocalStorage<Batch[]>();
    let bound = false;
    let unboundReported = false;

    // Neither a reporter nor a log that throws may fail the write either.
    const report = (error: Error, log?: RuntimeLog): void => {
        if (onError) {
            try {
                onError(error);
            } catch (thrown) {
                console.error(error.message, thrown);
            }

            return;
        }
        console.error(error.message);
        try {
            log?.warn?.({ message: error.message, error });
        } catch {
            // Already said on stderr, which is the report that counts.
        }
    };

    const modelsOf = (batch: Batch): string =>
        [...new Set(batch.entries.map(entry => entry.model))].join(', ');

    const write = async (batch: Batch): Promise<void> => {
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
                    const reason =
                        error instanceof Error ? error.message : String(error);

                    report(
                        new Error(
                            `audit trail: ${batch.entries.length} write(s) ` +
                                `to ${modelsOf(batch)} not recorded in ` +
                                `"${table}": ${reason}`,
                            { cause: error },
                        ),
                        batch.log,
                    );
                },
            );
    };

    const bind = <Client extends object>(client: Client): Client => {
        const transaction: unknown = Reflect.get(client, 'transaction');

        if (typeof transaction !== 'function') {
            return client;
        }

        // Rows are held for the transaction they were written in, and
        // written only once it has committed. A rejection — the callback
        // threw, or COMMIT itself failed — means the database kept none of
        // them, so neither does the trail.
        const transactionally = async (
            ...args: unknown[]
        ): Promise<unknown> => {
            const held: Batch[] = [];
            const result: unknown = await open.run(held, () =>
                Reflect.apply(transaction, client, args),
            );

            for (const batch of held) {
                await write(batch);
            }

            return result;
        };

        bound = true;

        return new Proxy(client, {
            get: (target, key, receiver) =>
                key === 'transaction'
                    ? transactionally
                    : Reflect.get(target, key, receiver),
        });
    };

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
        bind,
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
            ctx: { readonly scope?: string; readonly log?: RuntimeLog },
        ): Promise<void> {
            const batch = pending.get(plan);
            pending.delete(plan);
            if (batch) {
                batch.log = ctx?.log;
            }
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
            // So would recording a statement that completed in a transaction
            // rolled back after it, which is why one there waits for COMMIT.
            if (ctx?.scope === 'transaction') {
                const held = open.getStore();

                if (held) {
                    held.push(batch);

                    return;
                }
                // Which transaction this is cannot be told from here, so the
                // report is about the configuration, not about this write.
                if (!bound && !unboundReported) {
                    unboundReported = true;
                    report(
                        new Error(
                            `audit trail: a write to ${modelsOf(batch)} ran ` +
                                'in a transaction, and no client has been ' +
                                'passed through bind(): a write inside ' +
                                'db.transaction() is recorded before it ' +
                                'commits, and stays recorded if it rolls back',
                        ),
                        batch.log,
                    );
                }
            }
            await write(batch);
        },
    };
}
