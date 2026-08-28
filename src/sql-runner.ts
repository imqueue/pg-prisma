/*!
 * @imqueue/pg-prisma — a connection that knows when it is in a transaction
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
import type { SqlExecutor, SqlPool } from './sql-client.js';
import { withTransaction } from './sql-client.js';
import type { SqlFragment } from './sql-template.js';

/** What {@link sqlRunner} returns. */
export interface SqlRunner {
    /**
     * Run a statement, on the open transaction if there is one.
     *
     * @remarks
     * The rows, not the driver's envelope: a raw read is asked for its rows,
     * and every call site would otherwise reach through `.rows` to get them.
     *
     * A fragment carries its own values, so it is passed on its own; text
     * takes them as a second argument, the way the driver does.
     *
     * @param sql - The statement, as text or as a fragment.
     * @param values - Bound parameters, where the statement is text.
     * @returns The result rows.
     */
    query<Row = unknown>(
        sql: string | SqlFragment,
        values?: readonly unknown[],
    ): Promise<Row[]>;
    /**
     * Run `fn` inside a transaction, with every `query` it reaches joining it.
     *
     * @param fn - Work to run in the transaction.
     * @returns Whatever `fn` resolves to.
     */
    transaction<Result>(fn: () => Promise<Result>): Promise<Result>;
}

/**
 * A `query` and a `transaction` that agree about which connection to use.
 *
 * @remarks
 * A transaction is one connection, so a statement run on the pool while one is
 * open is not in it — it commits on its own, and the rollback the caller is
 * relying on leaves it behind. Prisma 7 solved this by handing a `tx` client
 * to the callback and asking every write to take it as an argument, which
 * meant threading it through everything the callback reaches.
 *
 * Here the connection travels in `AsyncLocalStorage` instead: `query` uses the
 * open transaction when there is one and the pool otherwise, so the call sites
 * do not change and cannot get it wrong. Nesting joins the outer transaction
 * rather than opening a second one, which is what a caller composing two
 * operations means by it.
 *
 * @param pool - The pool to take connections from.
 * @returns The pair.
 * @example
 * ```typescript
 * const { query, transaction } = sqlRunner(pool);
 *
 * await transaction(async () => {
 *     await query('SET LOCAL lock_timeout = $1', ['5s']);
 *     await write();
 * });
 * ```
 */
export function sqlRunner(pool: SqlPool): SqlRunner {
    const open = new AsyncLocalStorage<SqlExecutor>();

    return {
        async query<Row = unknown>(
            sql: string | SqlFragment,
            values?: readonly unknown[],
        ): Promise<Row[]> {
            const executor = open.getStore() ?? pool;
            const text = typeof sql === 'string' ? sql : sql.text;
            const bound = typeof sql === 'string' ? values : sql.values;
            const { rows } =
                bound === undefined
                    ? await executor.query(text)
                    : await executor.query(text, bound);

            return rows as Row[];
        },
        transaction<Result>(fn: () => Promise<Result>): Promise<Result> {
            const already = open.getStore();

            if (already) {
                return fn();
            }

            return withTransaction(pool, tx => open.run(tx, fn));
        },
    };
}
