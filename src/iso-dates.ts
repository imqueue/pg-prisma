/*!
 * @imqueue/pg-prisma — database timestamps as ISO 8601 instants
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

import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';

/**
 * Codecs whose values arrive as Postgres' own timestamp text.
 *
 * @remarks
 * Both are pass-through — `decode` hands back the wire string untouched — so
 * what a column yields is whatever `SELECT col::text` would print.
 */
export const TIMESTAMP_CODECS: ReadonlySet<string> = new Set([
    'pg/timestamptz-string@1',
    'pg/timestamp-string@1',
]);

/**
 * `2026-08-14 09:30:00.123+00`, and every shape Postgres prints around it:
 * a space for the `T`, the fraction trimmed of trailing zeros or absent
 * altogether, and an offset only when the column carries a zone.
 */
const PG_TIMESTAMP =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?)?$/;

/** The zone the value ends in, if it states one at all. */
const OFFSET = /([+-])(\d{2}):?(\d{2})?$/;

/** Everything {@link isoDates} needs. */
export interface IsoDateOptions {
    /** Columns stored under one of {@link TIMESTAMP_CODECS}. */
    columns: ReadonlySet<string>;
}

/**
 * Read database timestamps back as canonical ISO 8601 instants.
 *
 * @remarks
 * Postgres prints a timestamp as `2026-08-14 09:30:00.123+00` — a space where
 * ISO 8601 puts a `T`, `+00` where it puts `Z`, and a fraction stripped of its
 * trailing zeros, so `09:30:00.500` comes back as `09:30:00.5` and a whole
 * second as no fraction at all. Nothing downstream accepts that: the GraphQL
 * `DateTime` scalar rejects it outright, and so does `z.iso.datetime()`. This
 * restores the one spelling every boundary agrees on, which is what Prisma 7's
 * `scalars = "DateTime:string"` used to produce.
 *
 * A column that carries no zone is read as UTC rather than as a wall clock.
 * Left to `new Date`, such a value is parsed as **local** time, so on a host
 * that is not UTC every instant read from the database is silently shifted and
 * an expiry compares against the wrong moment — which is why the columns are
 * `timestamptz` and this is only the fallback for one that is not.
 *
 * Sub-millisecond precision does not survive, because a JavaScript instant has
 * none to survive into.
 *
 * Writes need nothing: Postgres parses an ISO 8601 string on its own, so a
 * value handed back unchanged can be sent straight back.
 *
 * Both the column name and the value's shape have to match, so a text column
 * that happens to hold something timestamp-like is left alone.
 *
 * @param options - The columns to convert.
 * @returns Middleware converting those columns on every row read.
 * @example
 * ```typescript
 * const middleware = [isoDates({ columns: derived.dates })];
 * ```
 */
export function isoDates({ columns }: IsoDateOptions): SqlMiddleware {
    // Postgres writes the offset as `+00`, which the ISO parser does not
    // accept — only the legacy one does, and what that accepts is not
    // specified. So the value is spelled out in full before it is parsed.
    const iso = (value: string): string => {
        const offset = OFFSET.exec(value);

        if (!offset) {
            return `${value.replace(' ', 'T')}Z`;
        }

        return (
            value.slice(0, offset.index).replace(' ', 'T') +
            `${offset[1]}${offset[2]}:${offset[3] ?? '00'}`
        );
    };

    const convert = (value: unknown): unknown => {
        if (typeof value !== 'string' || !PG_TIMESTAMP.test(value)) {
            return value;
        }

        const parsed = new Date(iso(value));

        // A shape this matches but a calendar rejects — `2026-02-30`, say.
        // Handing back the original loses nothing; throwing would fail the
        // whole read over one column.
        return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    };

    // Included relations arrive nested, so the walk goes all the way down
    // rather than over the top-level columns only.
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk);

            return;
        }

        if (!node || typeof node !== 'object') {
            return;
        }

        for (const [key, value] of Object.entries(node)) {
            if (value && typeof value === 'object') {
                walk(value);

                continue;
            }

            if (columns.has(key)) {
                (node as Record<string, unknown>)[key] = convert(value);
            }
        }
    };

    return {
        name: 'iso-dates',
        familyId: 'sql' as const,
        onRow(row: Record<string, unknown>): Promise<void> {
            walk(row);

            return Promise.resolve();
        },
    };
}
