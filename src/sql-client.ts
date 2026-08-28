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

/**
 * The minimum this package needs of a Postgres connection.
 *
 * @remarks
 * Deliberately not an ORM client. These installers write DDL — trigger
 * functions, archive schemas, pg_cron jobs — which is startup work, orthogonal
 * to how the application queries afterwards. Prisma Next's client offers
 * `db.raw.sql` as a tagged template with a declared row schema, which is the
 * wrong shape for arbitrary DDL, and tying the installers to it would make
 * them unusable from a migration or a standalone script.
 *
 * A `pg.Pool` satisfies this as it is, so a consumer passes one directly.
 */
export interface SqlExecutor {
    /**
     * Run a statement.
     *
     * @param sql - The statement. DDL cannot take bind parameters, so most
     *   callers here interpolate a checked identifier rather than binding.
     * @param values - Bound parameters, where the statement takes them.
     * @returns The result rows.
     */
    query(
        sql: string,
        values?: readonly unknown[],
    ): Promise<{ rows: unknown[] }>;
}

/** A connection held for the length of a transaction. */
export interface SqlConnection extends SqlExecutor {
    /** Returns the connection to its pool. */
    release(): void;
}

/** An executor that can hand out a dedicated connection. */
export interface SqlPool extends SqlExecutor {
    /** Take a connection out of the pool. */
    connect(): Promise<SqlConnection>;
}

/**
 * Run `fn` inside a transaction on one connection.
 *
 * @remarks
 * A transaction has to be one connection: issuing `BEGIN` on a pool and the
 * statements after it on whatever connection the pool hands out next is the
 * classic way to commit nothing and report success. The connection is released
 * whatever happens, and a failure rolls back before rethrowing.
 *
 * @param pool - The pool to take a connection from.
 * @param fn - The work to run inside the transaction.
 * @returns Whatever `fn` returns.
 * @example
 * ```typescript
 * await withTransaction(pool, async tx => {
 *     await tx.query('CREATE TABLE ...');
 * });
 * ```
 */
export async function withTransaction<T>(
    pool: SqlPool,
    fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
    const connection = await pool.connect();

    try {
        await connection.query('BEGIN');
        const result = await fn(connection);

        await connection.query('COMMIT');

        return result;
    } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);

        throw error;
    } finally {
        connection.release();
    }
}
