/*!
 * @imqueue/pg-prisma — a pool that can read JSON columns
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
import type { Pool, PoolConfig } from 'pg';

/**
 * Keep a pool's lost idle connection from ending the process.
 *
 * @remarks
 * When the server closes a connection the pool is holding idle — a
 * `pg_terminate_backend`, a failover, a maintenance restart — `pg` emits
 * `error` on the pool itself. With no listener, that is an unhandled `error`
 * event and Node exits. The pool has already discarded the client by then and
 * the next checkout opens a fresh one, so the only thing left to do is say so.
 *
 * @param pool - The pool to guard.
 * @returns The same pool.
 */
export function survivesLostConnections<P extends Pool>(pool: P): P {
    pool.on('error', error => {
        console.error(`pg pool: idle connection lost: ${error.message}`);
    });

    return pool;
}

/**
 * `json` and `jsonb`.
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
 * parse it means to do. Their array forms, `json[]` and `jsonb[]`, are not
 * here: the runtime reads every built-in array as raw text itself and never
 * asks this registry about them.
 */
const JSON_TYPES = [114, 3802];

/** What `pg-types` offers, of which only this one is wanted. */
export interface TypeParsers {
    setTypeParser: (oid: number, parser: unknown) => void;
}

/**
 * A connection pool whose JSON columns can be read.
 *
 * @remarks
 * Registers the parsers {@link JSON_TYPES} explains, and guards the pool with
 * {@link survivesLostConnections}.
 *
 * **Arrays of enums are the runtime's own.** An enum's array type is numbered
 * when the enum is created, so `node-postgres` cannot know it and hands the
 * literal text `{EMAIL,SMS}` back. Prisma Next up to 8.0.0-rc.11 could not
 * read that, and this pool used to parse it into an array first. From
 * 8.0.0-rc.12 the runtime decodes that text itself and refuses anything
 * already parsed — `RUNTIME.DECODE_FAILED`, "expected raw text for a Postgres
 * array" — so the text is now left exactly as the driver gives it.
 *
 * The registry is the one the *runtime* reads, not the one a pool carries:
 * the ORM passes its own `types` to every query, and that object falls
 * through to `pg-types` for anything it does not handle itself. A parser set
 * on the pool is therefore never consulted. It follows that the registry is
 * global, and a raw `pg` query in the same process reads a JSON column as
 * text and has to parse it itself — the trade for the ORM reading it
 * correctly.
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
    const asIs = (value: string): string => value;

    for (const oid of JSON_TYPES) {
        parsers.setTypeParser(oid, asIs);
    }

    return survivesLostConnections(new pg.Pool(config));
}
