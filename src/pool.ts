/*!
 * @imqueue/pg-prisma — a pool that can read an array of enums
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
import type { Pool, PoolConfig, PoolClient } from 'pg';

/** `text[]`, whose wire format an array of enums shares exactly. */
const TEXT_ARRAY = 1009;

/**
 * `json`, `jsonb`, and their array forms.
 *
 * @remarks
 * The ORM's codec parses what it is handed — `wire => typeof wire === 'string'
 * ? JSON.parse(wire) : wire` — but `node-postgres` has parsed it already, so
 * the two disagree about whose job it is. An object survives, because the
 * codec passes a non-string through. A JSON **string** does not: the driver
 * yields `Payment`, the codec parses it again, and `JSON.parse('Payment')`
 * throws. Worse, a column holding `"5"` comes back as the number `5` — the
 * second parse succeeds and quietly changes the type.
 *
 * So the driver is told to leave these alone and let the codec do the one
 * parse it means to do.
 */
const JSON_TYPES = [114, 3802, 199, 3807];

/** Every enum type's array companion, as this database numbers them. */
const ENUM_ARRAY_OIDS =
    "SELECT typarray FROM pg_type WHERE typtype = 'e' AND typarray <> 0";

/** What `pg-types` offers, of which only these two are wanted. */
export interface TypeParsers {
    getTypeParser: (oid: number, format?: string) => unknown;
    setTypeParser: (oid: number, parser: unknown) => void;
}

/**
 * A connection pool whose arrays of enums and JSON columns can be read.
 *
 * @remarks
 * `node-postgres` parses a value by its type's oid, and it knows only the
 * built-in ones. An enum is numbered when it is created, so its array type is
 * numbered too, and neither number can be known ahead of time — the driver
 * therefore hands back the literal text `{EMAIL,SMS}` where the ORM requires
 * an array, and every read of the column fails with `RUNTIME.DECODE_FAILED`.
 * A scalar enum is unaffected, because its text *is* its value.
 *
 * So the oids are asked for, once, and those columns are parsed the way a
 * `text[]` is — which is what an array of enums is on the wire. The JSON
 * types are corrected at the same time, for the reason on {@link JSON_TYPES}.
 *
 * The lookup is deferred to the first connection rather than done here,
 * because a pool is built where a client is built and that is not a place
 * where anything can be awaited. It runs once; a query that arrives while it
 * is in flight waits for it rather than starting a second one.
 *
 * The registry is the one the *runtime* reads, not the one a pool carries:
 * the ORM passes its own `types` to every query, and that object falls
 * through to `pg-types` for anything it does not handle itself. A parser set
 * on the pool is therefore never consulted.
 *
 * Three things follow from the registry being global. A raw `pg` query in the
 * same process reads a JSON column as text and has to parse it itself, which
 * is the trade for the ORM reading it correctly. An enum type created
 * *after* the first connection is not picked up — which is a migration
 * applied to a running process, and migrations run at start, before anything
 * connects. And a process holding pools onto two different databases would
 * have them share one numbering, which no service here does: a service owns
 * one database.
 *
 * @param config - Pool configuration, as `pg` takes it.
 * @param parsers - The registry to register in. Defaults to this package's
 * own, which is right whenever there is one copy of `pg` to have; a consumer
 * that resolves the ORM through a different copy has to say so, because a
 * parser added to the wrong registry is never read.
 * @returns The pool.
 * @example
 * ```typescript
 * const db = postgres<Contract>({
 *     contractJson,
 *     pg: dataPool({ connectionString }),
 * });
 * ```
 */
export function dataPool(
    config: PoolConfig,
    parsers: TypeParsers = pg.types as unknown as TypeParsers,
): Pool {
    const pool = new pg.Pool(config);

    // Bound before the override, so neither the lookup below nor the callback
    // form calls itself.
    const connect = pool.connect.bind(pool) as {
        (): Promise<PoolClient>;
        (callback: (error: unknown, client?: unknown) => void): void;
    };
    const once: { lookup?: Promise<void> } = {};

    const lookup = async (): Promise<void> => {
        const asTextArray = parsers.getTypeParser(TEXT_ARRAY);
        const asIs = (value: string): string => value;
        const client = await connect();

        for (const oid of JSON_TYPES) {
            parsers.setTypeParser(
                oid,
                oid === 199 || oid === 3807 ? asTextArray : asIs,
            );
        }

        try {
            const { rows } = await client.query<{ typarray: string }>(
                ENUM_ARRAY_OIDS,
            );

            for (const row of rows) {
                parsers.setTypeParser(Number(row.typarray), asTextArray);
            }
        } finally {
            client.release();
        }
    };

    // `Pool.query` calls `connect` with a callback, so both forms are served.
    pool.connect = ((callback?: unknown) => {
        once.lookup ??= lookup();

        if (typeof callback !== 'function') {
            return once.lookup.then(() => connect());
        }

        const done = callback as (error: unknown, client?: unknown) => void;

        once.lookup
            .then(() => connect(done))
            .catch((error: unknown) => {
                done(error);
            });

        return undefined;
    }) as typeof pool.connect;

    return pool;
}
