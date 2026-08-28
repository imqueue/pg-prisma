import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
/*!
 * @imqueue/pg-prisma — Prisma/Postgres toolkit for @imqueue services
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

import { prettifySql } from './pretty-sql.js';
import { isSqlLogSuppressed } from './sql-log.js';

/** Where a query log line goes. */
export interface QueryLogger {
    /** Write one line. */
    log(message: string): void;
}

/** Everything {@link queryLog} needs. */
export interface QueryLogOptions {
    /** Whether to log at all. */
    log: boolean;
    /**
     * Whether to log bound parameters as well.
     *
     * @remarks
     * Off by default and worth keeping that way outside local debugging: the
     * statement text and its timing are logged either way, while the bound
     * parameters carry whatever the caller passed — stored values, user ids —
     * and a log file is the least protected place that data can land.
     */
    logParams?: boolean;
    /** Where the line goes. */
    logger: QueryLogger;
}

/**
 * Build the middleware that logs each statement and how long it took.
 *
 * @remarks
 * Prisma 7 emitted a `query` event and this was a `$on` subscription. Prisma
 * Next has no such event and ships no query logger, so it is a middleware —
 * which is strictly better placed: `afterQuery` sees the statement as it was
 * finally lowered, after every rewrite, rather than as it was written.
 *
 * `silently()` still suppresses it, so startup DDL stays out of the log.
 *
 * @param options - Whether to log, whether to include parameters, and where.
 * @returns Middleware for the `middleware` array of the `postgres()` factory.
 */
export function queryLog({
    log,
    logParams,
    logger,
}: QueryLogOptions): SqlMiddleware {
    return {
        name: 'query-log',
        familyId: 'sql' as const,
        async afterQuery(
            plan: { readonly sql?: string; readonly params?: unknown },
            result: { readonly latencyMs?: number },
        ): Promise<void> {
            if (!log || isSqlLogSuppressed() || !plan?.sql) {
                return;
            }
            const params = logParams
                ? `\n-- params: ${JSON.stringify(plan.params)}`
                : '';

            logger.log(
                `${prettifySql(plan.sql)}${params} (${result?.latencyMs ?? 0}ms)`,
            );
        },
    };
}
