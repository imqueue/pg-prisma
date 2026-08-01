/*!
 * Postgres row-change NOTIFY trigger installer
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

import { silently } from './sql-log.js';

/** Default Postgres NOTIFY channel the change triggers emit on. */
export const CHANGE_NOTIFY_CHANNEL = 'record_change_notify';
/** Default name of the per-table change trigger. */
export const CHANGE_NOTIFY_TRIGGER_NAME = 'record_change_notify';
/** Default name of the trigger's plpgsql notify function. */
export const CHANGE_NOTIFY_FUNCTION_NAME = 'record_change_notify_fn';

/** Which tables notify, and under which Postgres object names. */
export interface ChangeTriggerConfig {
    /** NOTIFY channel to publish on (default {@link CHANGE_NOTIFY_CHANNEL}). */
    channel?: string;
    /** Trigger name to create on each table (default {@link CHANGE_NOTIFY_TRIGGER_NAME}). */
    triggerName?: string;
    /** Name of the shared plpgsql function (default {@link CHANGE_NOTIFY_FUNCTION_NAME}). */
    functionName?: string;
    /**
     * Tables that should notify — the complete desired set, not an addition.
     *
     * @remarks
     * Reconciliation is two-way: a table listed here without the trigger gets it,
     * and a table that HAS the trigger but is not listed here has it dropped. So
     * omitting `models` entirely (the default empty array) removes the trigger from
     * every table it is currently on.
     */
    models?: readonly string[];
    /** Suppress SQL logging for the install DDL (default `true`). */
    silent?: boolean;
}

/** The raw-SQL surface used to install triggers (a Prisma client or its `tx`). */
export interface RawExecutor {
    /** Execute a statement — used for the DDL, which cannot use bind parameters. */
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
    /** Run a query — used to read the currently installed triggers back. */
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
}

/** A {@link RawExecutor} that can also open a transaction. */
export interface RawClient extends RawExecutor {
    /**
     * Run `fn` inside a transaction.
     *
     * @remarks
     * {@link installChangeTriggers} needs this so the whole reconciliation — the
     * function, the added triggers and the dropped ones — either lands or does not.
     */
    $transaction<T>(fn: (tx: RawExecutor) => Promise<T>): Promise<T>;
}

/**
 * Install Postgres triggers that `NOTIFY` on every row change in the given tables.
 *
 * @remarks
 * Creates one shared plpgsql function and attaches a row-level trigger to each
 * table in `models`, firing after every insert, update and delete. Each
 * notification is a JSON payload with three keys — `table`, `op` (`INSERT`,
 * `UPDATE` or `DELETE`) and `row` — where `row` is the new row, or the OLD row for
 * a delete. Listen for them with `@imqueue/pg-pubsub`, or any `LISTEN` client.
 *
 * The whole thing runs in one transaction and is idempotent, so it is safe on every
 * start. It also reconciles in both directions: `models` is the complete desired
 * set, read against `information_schema.triggers`, so a table that carries the
 * trigger but is not listed has it dropped. Calling this with an empty or omitted
 * `models` therefore REMOVES every trigger of that name — it is not a no-op.
 *
 * Two limits worth knowing. Postgres caps a notification payload at 8000 bytes and
 * raises an error beyond it, so a table with large rows can make its own writes
 * fail — this is unsuitable for wide or blob-bearing tables. And the trigger fires
 * per row inside the writing transaction, so a bulk write produces one
 * notification per row, delivered only if that transaction commits.
 *
 * @param client - A client that can execute raw SQL and open a transaction.
 * @param config - Channel and object names, the tables to reconcile, and whether
 *   to suppress SQL logging for the DDL.
 * @returns Nothing; it resolves once the triggers match `models`.
 * @example
 * ```typescript
 * await installChangeTriggers(prisma, { models: ['User', 'Order'] });
 * ```
 */
export async function installChangeTriggers(
    client: RawClient,
    {
        channel = CHANGE_NOTIFY_CHANNEL,
        triggerName = CHANGE_NOTIFY_TRIGGER_NAME,
        functionName = CHANGE_NOTIFY_FUNCTION_NAME,
        models = [],
        silent = true,
    }: ChangeTriggerConfig,
): Promise<void> {
    const install = (): Promise<unknown> =>
        client.$transaction(async tx => {
            await tx.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $fn$
            DECLARE
                rec record;
            BEGIN
                IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
                PERFORM pg_notify(
                    TG_ARGV[0],
                    json_build_object(
                        'table', TG_TABLE_NAME,
                        'op', TG_OP,
                        'row', row_to_json(rec)
                    )::text
                );
                RETURN NULL;
            END;
            $fn$ LANGUAGE plpgsql;
        `);

            const rows = await tx.$queryRawUnsafe<{ table: string }[]>(
                `SELECT event_object_table AS "table"
               FROM information_schema.triggers
              WHERE trigger_name = $1
              GROUP BY event_object_table`,
                triggerName,
            );
            const installed = new Set(rows.map(row => row.table));
            const required = new Set(models);

            for (const model of models) {
                if (!installed.has(model)) {
                    await tx.$executeRawUnsafe(
                        `CREATE TRIGGER "${triggerName}"
                        AFTER INSERT OR UPDATE OR DELETE ON "${model}"
                        FOR EACH ROW
                        EXECUTE PROCEDURE ${functionName}('${channel}')`,
                    );
                }
            }

            for (const model of installed) {
                if (!required.has(model)) {
                    await tx.$executeRawUnsafe(
                        `DROP TRIGGER IF EXISTS "${triggerName}" ON "${model}"`,
                    );
                }
            }
        });

    await (silent ? silently(install) : install());
}
