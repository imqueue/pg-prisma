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

import type { SqlExecutor, SqlPool } from './sql-client.js';
import { withTransaction } from './sql-client.js';
import { silently } from './sql-log.js';

/** Default Postgres NOTIFY channel the change triggers emit on. */
export const CHANGE_NOTIFY_CHANNEL = 'record_change_notify';
/** Default name of the per-table change trigger. */
export const CHANGE_NOTIFY_TRIGGER_NAME = 'record_change_notify';
/** Default name of the trigger's plpgsql notify function. */
export const CHANGE_NOTIFY_FUNCTION_NAME = 'record_change_notify_fn';
/**
 * Setting the trigger reads to decide whether to stay quiet.
 *
 * @remarks
 * Named after the trigger it silences, like the channel, trigger and function
 * above it — a reader meeting it in a `SET LOCAL` can tell what it belongs to
 * without knowing this package.
 *
 * A setting of our own rather than `session_replication_role`, which would also
 * switch off foreign-key enforcement — a bulk load run that way can leave orphan
 * rows behind. This suppresses nothing but these notifications.
 */
export const CHANGE_NOTIFY_SUPPRESS_SETTING = 'record_change_notify.suppressed';

/** Which tables notify, and under which Postgres object names. */
export interface ChangeTriggerConfig {
    /** NOTIFY channel to publish on (default {@link CHANGE_NOTIFY_CHANNEL}). */
    channel?: string;
    /** Trigger name to create on each table (default {@link CHANGE_NOTIFY_TRIGGER_NAME}). */
    triggerName?: string;
    /** Name of the shared plpgsql function (default {@link CHANGE_NOTIFY_FUNCTION_NAME}). */
    functionName?: string;
    /**
     * Setting that silences the trigger (default
     * {@link CHANGE_NOTIFY_SUPPRESS_SETTING}).
     */
    suppressSetting?: string;
    /**
     * Default schema of the listed tables (default `public`).
     *
     * @remarks
     * A model may name its own schema as `schema.Table`, which wins over this.
     * That is what lets a service reconcile tables it creates at run time —
     * a tenant schema, say — without naming the default one.
     */
    schema?: string;
    /**
     * Tables that should notify — the complete desired set, not an addition.
     *
     * @remarks
     * Reconciliation is two-way: a table listed here without the trigger gets it,
     * and a table that HAS the trigger but is not listed here has it dropped.
     *
     * It is confined to the schemas these names mention, so a call listing only
     * public tables leaves triggers in other schemas alone — otherwise a service
     * that installs per-schema would tear down its own work on the next start.
     * Within those schemas it is absolute: omitting `models` entirely removes the
     * trigger from every table in the default schema.
     */
    models?: readonly string[];
    /** Suppress SQL logging for the install DDL (default `true`). */
    silent?: boolean;
}

/** The raw-SQL surface used to install triggers. A `pg.Pool` satisfies it. */
export type RawExecutor = SqlExecutor;

/**
 * A {@link RawExecutor} that can also open a transaction.
 *
 * @remarks
 * {@link installChangeTriggers} needs one so the whole reconciliation — the
 * function, the added triggers and the dropped ones — either lands or does not.
 */
export type RawClient = SqlPool;

/** A model name as `schema` and `table`, taking `fallback` when unqualified. */
function split(
    model: string,
    fallback: string,
): { schema: string; table: string } {
    const dot = model.indexOf('.');

    return dot === -1
        ? { schema: fallback, table: model }
        : { schema: model.slice(0, dot), table: model.slice(dot + 1) };
}

const qualify = (schema: string, table: string): string => `${schema}.${table}`;

/**
 * Install Postgres triggers that `NOTIFY` on every row change in the given tables.
 *
 * @remarks
 * Creates one shared plpgsql function and attaches a row-level trigger to each
 * table in `models`, firing after every insert, update and delete. Each
 * notification is a JSON payload with four keys — `schema`, `table`, `op`
 * (`INSERT`, `UPDATE` or `DELETE`) and `row` — where `row` is the new row, or the
 * OLD row for a delete. `schema` is what makes a listener able to tell two tables
 * of the same name apart, which is the ordinary case once a service creates
 * schemas of its own. Listen for them with `@imqueue/pg-pubsub`, or any `LISTEN` client.
 *
 * The whole thing runs in one transaction and is idempotent, so it is safe on every
 * start. It also reconciles in both directions: `models` is the complete desired
 * set, read against `information_schema.triggers`, so a table that carries the
 * trigger but is not listed has it dropped. Calling this with an empty or omitted
 * `models` therefore REMOVES every trigger of that name — it is not a no-op.
 *
 * Reconciliation is confined to the schemas `models` mentions, plus `schema`
 * itself. A service that installs triggers per tenant schema can therefore
 * reconcile one of them without tearing down the others.
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
 * await installChangeTriggers(pool, { models: ['User', 'Order'] });
 * ```
 */
export async function installChangeTriggers(
    client: RawClient,
    {
        channel = CHANGE_NOTIFY_CHANNEL,
        triggerName = CHANGE_NOTIFY_TRIGGER_NAME,
        functionName = CHANGE_NOTIFY_FUNCTION_NAME,
        schema = 'public',
        suppressSetting = CHANGE_NOTIFY_SUPPRESS_SETTING,
        models = [],
        silent = true,
    }: ChangeTriggerConfig,
): Promise<void> {
    const install = (): Promise<unknown> =>
        withTransaction(client, async tx => {
            await tx.query(`
            CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $fn$
            DECLARE
                rec record;
            BEGIN
                IF coalesce(
                    current_setting('${suppressSetting}', true), ''
                ) = 'on' THEN
                    RETURN NULL;
                END IF;
                IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
                PERFORM pg_notify(
                    TG_ARGV[0],
                    json_build_object(
                        'schema', TG_TABLE_SCHEMA,
                        'table', TG_TABLE_NAME,
                        'op', TG_OP,
                        'row', row_to_json(rec)
                    )::text
                );
                RETURN NULL;
            END;
            $fn$ LANGUAGE plpgsql;
        `);

            const wanted = models.map(model => split(model, schema));
            const schemas = [...new Set(wanted.map(one => one.schema))];

            if (!schemas.includes(schema)) {
                schemas.push(schema);
            }

            const rows = (
                await tx.query(
                    `SELECT event_object_schema AS "schema",
                       event_object_table  AS "table"
                  FROM information_schema.triggers
                 WHERE trigger_name = $1
                   AND event_object_schema = ANY ($2)
                 GROUP BY event_object_schema, event_object_table`,
                    [triggerName, schemas],
                )
            ).rows as { schema: string; table: string }[];

            const installed = new Set(
                rows.map(row => qualify(row.schema, row.table)),
            );
            const required = new Set(
                wanted.map(one => qualify(one.schema, one.table)),
            );

            for (const one of wanted) {
                if (!installed.has(qualify(one.schema, one.table))) {
                    await tx.query(
                        `CREATE TRIGGER "${triggerName}"
                        AFTER INSERT OR UPDATE OR DELETE
                        ON "${one.schema}"."${one.table}"
                        FOR EACH ROW
                        EXECUTE PROCEDURE ${functionName}('${channel}')`,
                    );
                }
            }

            for (const row of rows) {
                if (!required.has(qualify(row.schema, row.table))) {
                    await tx.query(
                        `DROP TRIGGER IF EXISTS "${triggerName}"
                         ON "${row.schema}"."${row.table}"`,
                    );
                }
            }
        });

    await (silent ? silently(install) : install());
}

/**
 * Run `fn` in a transaction whose row changes notify nobody.
 *
 * @remarks
 * For a bulk write — an import, a backfill, a reconciliation — where the
 * trigger would otherwise emit one notification per row. Forty thousand rows
 * is forty thousand payloads through a single Postgres notification queue, to
 * tell listeners something they would rather hear once.
 *
 * The suppression is `SET LOCAL`, so it belongs to this transaction alone: it
 * reverts on commit or rollback, and no concurrent session is affected. It is
 * a setting the trigger itself reads, **not** `session_replication_role` — that
 * would silence foreign-key enforcement too, and a bulk load run under it can
 * commit orphan rows.
 *
 * Do the writes on the `tx` handed to `fn`. Writes issued on the outer client
 * go out on a different connection, where the setting was never applied, and
 * will notify as usual.
 *
 * Nothing is emitted afterwards to say what changed — a caller that suppresses
 * is telling listeners it will account for the change itself, by bumping a
 * revision, invalidating a tag, or announcing the import once when it is done.
 *
 * @param client - A client that can open a transaction.
 * @param fn - Work to run with notifications suppressed.
 * @param setting - Setting the trigger reads (default
 *   {@link CHANGE_NOTIFY_SUPPRESS_SETTING}).
 * @returns Whatever `fn` resolves to.
 * @example
 * ```typescript
 * await withoutChangeNotify(pool, async tx => {
 *     await tx.query(bulkUpsert);
 * });
 * ```
 */
export async function withoutChangeNotify<T>(
    client: RawClient,
    fn: (tx: RawExecutor) => Promise<T>,
    setting: string = CHANGE_NOTIFY_SUPPRESS_SETTING,
): Promise<T> {
    return withTransaction(client, async tx => {
        await tx.query(`SET LOCAL "${setting}" = 'on'`);

        return fn(tx);
    });
}
