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

import { createHash } from 'node:crypto';
import { silently } from './sql-log.js';

/** The raw-SQL surface this installer needs (a Prisma client or its `tx`). */
export interface ArchiveClient {
    /**
     * Execute a statement built by the installer.
     *
     * @remarks
     * Named `Unsafe` because it interpolates rather than binds, which is what DDL
     * requires — schema, table and column names cannot be parameters. Every
     * identifier the installer interpolates is validated against
     * `/^[A-Za-z_][A-Za-z0-9_]*$/` first, and it throws rather than quoting
     * anything that fails.
     */
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

/** Everything {@link installArchiving} needs. */
export interface InstallArchiveOptions {
    /** The raw-SQL surface to install through — a Prisma client or a transaction. */
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
 * Install the row-archiving machinery: a mirror `archive` schema, its settings
 * table, the sweep function, and — best effort — a pg_cron schedule to run it.
 *
 * @remarks
 * Aged rows are moved out of the watched tables into same-named tables in the
 * archive schema, which keeps the hot tables small without losing the data. Every
 * step is idempotent, so this is safe to call on every start.
 *
 * What it does, in order:
 *
 * 1. Creates the archive schema.
 * 2. Creates its settings table, one row per watched table: the source schema, the
 *    watch column, the retention period in seconds, an `enabled` flag, and a hash
 *    of the config the code asked for.
 * 3. Reconciles the supplied `models` against that table — inserting new rows, and
 *    rewriting the code-owned columns only when the hash differs.
 * 4. Creates the `run()` sweep function. For each enabled setting it checks
 *    whether any row is older than that setting's period, and only then creates
 *    `archive.<table>` and moves the aged rows across in a single
 *    `DELETE ... RETURNING` piped into an `INSERT`. So the archive table appears
 *    when there is finally something to put in it, not at install time.
 * 5. Tries to create the pg_cron extension and schedule `run()`. This step is
 *    best effort: if pg_cron is unavailable the failure is caught and scheduling
 *    is skipped without an error, which means a successful call does NOT guarantee
 *    the sweep is scheduled. `run()` is a plain function, so it can equally be
 *    called by hand or driven by any external scheduler.
 *
 * The division of ownership in step 3 is the part worth understanding. While the
 * hash is unchanged, an operator's edits to the source schema, watch column and
 * period are preserved — the code will not clobber them on the next start.
 * Changing any of those three in code changes the hash, and then the code's values
 * win. The `enabled` flag is never written after the initial insert, so turning a
 * table off in the database keeps it off regardless.
 *
 * `run()` reads the settings table at call time rather than baking them in, so
 * operator changes take effect on the next sweep without reinstalling.
 *
 * @param options - Client, naming, defaults, the tables to watch, and the schedule.
 * @returns Nothing; it resolves once the DDL has been applied.
 * @throws Error when any schema, table or column name is not a plain SQL
 *   identifier — these are interpolated into DDL, so they are validated rather
 *   than escaped.
 * @example
 * ```typescript
 * await installArchiving({
 *     client: prisma,
 *     models: [{ name: 'AuditLog', periodSeconds: 7 * 24 * 3600 }],
 * });
 * ```
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
