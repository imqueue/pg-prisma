/*!
 * Row-archiving installer for Postgres (aged rows → mirror schema)
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

/**
 * Archiving installer — moves aged rows out of watched tables into a mirror
 * `archive` schema on a schedule, keeping the hot tables small.
 *
 * Idempotent DB setup (safe to run on every start):
 *  1. create the archive schema (default `archive`, configurable);
 *  2. create its settings table (default `_settings`) — one row per watched
 *     table: the source schema, the watch column (default `deletedAt`), the
 *     retention period in seconds (default 30 days), an `enabled` flag, and a
 *     `hash` of the code-desired config (source schema + watch column + period);
 *  3. reconcile each supplied table: insert if new, and if the code-desired
 *     `hash` differs from the stored one, rewrite the code-owned columns (source
 *     schema, watch column, period). When the hash is unchanged, operator edits
 *     to those columns are preserved; the `enabled` toggle is always preserved;
 *  4. create the `run()` sweep function — for each enabled setting, if any row
 *     is older than its period it lazily creates `archive.<table>` (only when
 *     rows actually appear) and moves the aged rows there;
 *  5. best-effort schedule `run()` via pg_cron — try to create the extension; if
 *     it isn't available, skip scheduling (no error). The schedule is
 *     reconciled: any stale cron job pointing at `run()` (a changed job name or
 *     schedule) is unscheduled and the desired job (re)created. `run()` can also
 *     be called manually or wired to any external scheduler.
 *
 * Library-clean: every input is a parameter and it touches no globals.
 */

import { createHash } from 'node:crypto';
import { silently } from './sql-log.js';

/** The raw-SQL surface this installer needs (a Prisma client or its `tx`). */
export interface ArchiveClient {
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
}

/** One watched table to seed into the archive settings table. */
export interface ArchivableModel {
    /** Table name (as created in `sourceSchema`). */
    name: string;
    /** Column whose age gates archiving (default `defaultColumn`). */
    watchColumn?: string;
    /** Retention period in seconds (default `defaultPeriodSeconds`). */
    periodSeconds?: number;
    /** Schema the table lives in (default `sourceSchema`). */
    sourceSchema?: string;
}

export interface InstallArchiveOptions {
    client: ArchiveClient;
    /** Archive schema name (default `archive`). */
    archiveSchema?: string;
    /** Settings table name within the archive schema (default `_settings`). */
    settingsTable?: string;
    /** Default schema of the watched tables (default `public`). */
    sourceSchema?: string;
    /** Tables to register by default (idempotent seed). */
    models?: readonly ArchivableModel[];
    /** Default watch column (default `deletedAt`). */
    defaultColumn?: string;
    /** Default retention in seconds (default 30 days). */
    defaultPeriodSeconds?: number;
    /** pg_cron schedule for the sweep (default daily at midnight, `0 0 * * *`). */
    schedule?: string;
    /** pg_cron job name (default `archive-run`). */
    jobName?: string;
    /** Suppress SQL logging for the install DDL (default `true`). */
    silent?: boolean;
}

const MONTH_SECONDS = 30 * 24 * 60 * 60;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(value: string, what: string): void {
    if (!IDENT.test(value)) {
        throw new Error(`archive: invalid ${what} "${value}"`);
    }
}

/** Escape a single-quoted SQL string literal. */
const lit = (value: string): string => value.replace(/'/g, "''");

/**
 * Install (idempotently) the archive schema, settings table, sweep function, and
 * — best-effort — the pg_cron schedule. See the module docs for the model.
 */
export async function installArchiving(
    options: InstallArchiveOptions,
): Promise<void> {
    const {
        client,
        archiveSchema = 'archive',
        settingsTable = '_settings',
        sourceSchema = 'public',
        models = [],
        defaultColumn = 'deletedAt',
        defaultPeriodSeconds = MONTH_SECONDS,
        schedule = '0 0 * * *',
        jobName = 'archive-run',
        silent = true,
    } = options;

    const run = async (): Promise<void> => {
        assertIdent(archiveSchema, 'archive schema');
        assertIdent(settingsTable, 'settings table');
        assertIdent(sourceSchema, 'source schema');

        // 1. archive schema
        await client.$executeRawUnsafe(
            `CREATE SCHEMA IF NOT EXISTS "${archiveSchema}"`,
        );

        // 2. settings table (+ `hash` column migration for pre-existing tables)
        await client.$executeRawUnsafe(
            `CREATE TABLE IF NOT EXISTS "${archiveSchema}"."${settingsTable}" (
            "table"         text PRIMARY KEY,
            "sourceSchema"  text NOT NULL DEFAULT 'public',
            "watchColumn"   text NOT NULL DEFAULT 'deletedAt',
            "periodSeconds" integer NOT NULL DEFAULT ${defaultPeriodSeconds},
            "enabled"       boolean NOT NULL DEFAULT true,
            "hash"          text NOT NULL DEFAULT ''
        )`,
        );
        await client.$executeRawUnsafe(
            `ALTER TABLE "${archiveSchema}"."${settingsTable}"
                ADD COLUMN IF NOT EXISTS "hash" text NOT NULL DEFAULT ''`,
        );

        // 3. reconcile settings: insert new rows, and rewrite the code-owned
        // columns whenever the code-desired hash changed. Unchanged hash → keep
        // operator edits; `enabled` is never overwritten here.
        for (const t of models) {
            assertIdent(t.name, 'table');
            const watchColumn = t.watchColumn ?? defaultColumn;
            const src = t.sourceSchema ?? sourceSchema;
            const periodSeconds = t.periodSeconds ?? defaultPeriodSeconds;
            assertIdent(watchColumn, 'watch column');
            assertIdent(src, 'source schema');
            const hash = createHash('sha1')
                .update([src, watchColumn, String(periodSeconds)].join('\0'))
                .digest('hex');
            await client.$executeRawUnsafe(
                `INSERT INTO "${archiveSchema}"."${settingsTable}" AS cfg
                ("table", "sourceSchema", "watchColumn", "periodSeconds", "hash")
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT ("table") DO UPDATE SET
                "sourceSchema"  = EXCLUDED."sourceSchema",
                "watchColumn"   = EXCLUDED."watchColumn",
                "periodSeconds" = EXCLUDED."periodSeconds",
                "hash"          = EXCLUDED."hash"
             WHERE cfg."hash" IS DISTINCT FROM EXCLUDED."hash"`,
                t.name,
                src,
                watchColumn,
                periodSeconds,
                hash,
            );
        }

        // 4. sweep function — reads settings at call time, so operator edits take
        // effect without reinstalling. Aged rows are moved atomically per table via
        // DELETE ... RETURNING piped into the lazily-created archive copy.
        await client.$executeRawUnsafe(
            `CREATE OR REPLACE FUNCTION "${archiveSchema}"."run"() RETURNS void AS $fn$
        DECLARE
            s record;
            has_rows boolean;
        BEGIN
            FOR s IN
                SELECT "table", "sourceSchema", "watchColumn", "periodSeconds"
                FROM "${archiveSchema}"."${settingsTable}"
                WHERE "enabled"
            LOOP
                EXECUTE format(
                    'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I IS NOT NULL '
                        || 'AND %I < now() - make_interval(secs => %s))',
                    s."sourceSchema", s."table", s."watchColumn",
                    s."watchColumn", s."periodSeconds"
                ) INTO has_rows;

                IF has_rows THEN
                    EXECUTE format(
                        'CREATE TABLE IF NOT EXISTS %I.%I '
                            || '(LIKE %I.%I INCLUDING DEFAULTS)',
                        '${lit(archiveSchema)}', s."table",
                        s."sourceSchema", s."table"
                    );
                    EXECUTE format(
                        'WITH moved AS ('
                            || 'DELETE FROM %I.%I WHERE %I IS NOT NULL '
                            || 'AND %I < now() - make_interval(secs => %s) '
                            || 'RETURNING *'
                            || ') INSERT INTO %I.%I SELECT * FROM moved',
                        s."sourceSchema", s."table", s."watchColumn",
                        s."watchColumn", s."periodSeconds",
                        '${lit(archiveSchema)}', s."table"
                    );
                END IF;
            END LOOP;
        END;
        $fn$ LANGUAGE plpgsql`,
        );

        // 5. pg_cron (best-effort): create the extension if possible, then schedule.
        await client.$executeRawUnsafe(
            `DO $do$
        BEGIN
            CREATE EXTENSION IF NOT EXISTS pg_cron;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'archive: pg_cron unavailable, skipping (%)', SQLERRM;
        END
        $do$`,
        );
        // Reconcile the schedule against pg_cron's own catalog: unschedule any
        // stale job that points at our run() (changed name or schedule), then
        // (re)create the desired one only if it isn't already present.
        await client.$executeRawUnsafe(
            `DO $do$
        DECLARE
            j record;
            want_command text := 'SELECT "${lit(archiveSchema)}"."run"()';
            want_name text := '${lit(jobName)}';
            want_schedule text := '${lit(schedule)}';
            found boolean := false;
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
                RETURN;
            END IF;

            FOR j IN
                SELECT jobid, jobname, schedule
                FROM cron.job
                WHERE command = want_command
            LOOP
                IF j.jobname = want_name AND j.schedule = want_schedule THEN
                    found := true;
                ELSE
                    PERFORM cron.unschedule(j.jobid);
                END IF;
            END LOOP;

            IF NOT found THEN
                PERFORM cron.schedule(want_name, want_schedule, want_command);
            END IF;
        END
        $do$`,
        );
    };

    await (silent ? silently(run) : run());
}
