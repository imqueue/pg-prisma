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

export interface ChangeTriggerConfig {
    channel?: string;
    triggerName?: string;
    functionName?: string;
    models?: readonly string[];
    /** Suppress SQL logging for the install DDL (default `true`). */
    silent?: boolean;
}

/** The raw-SQL surface used to install triggers (a Prisma client or its `tx`). */
export interface RawExecutor {
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
}

export interface RawClient extends RawExecutor {
    $transaction<T>(fn: (tx: RawExecutor) => Promise<T>): Promise<T>;
}

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
