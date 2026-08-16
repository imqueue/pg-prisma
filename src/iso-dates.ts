/*!
 * Prisma result extension: Date → ISO-8601 strings
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

import { Prisma } from '@prisma/client/extension';

/**
 * Recursively replace every `Date` with its ISO-8601 string, structure intact.
 *
 * Exported so it can be tested without a database, like `accessWhere`: what it
 * does to a shape is the whole of this extension, and the interesting cases —
 * a buffer, a nested date, an array of rows — are all reachable from here.
 */
export function toIsoDates(value: unknown): unknown {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        return value.map(toIsoDates);
    }
    /*
     * Binary is returned as it came, and this is not an optimisation.
     *
     * The branch below rebuilds any object by walking `Object.entries`, and a
     * `Buffer` walked that way becomes `{ "0": 137, "1": 80, … }` — a plain
     * object with one key per byte, which is no longer a buffer, is roughly
     * fifty times the size, and fails every `Buffer.isBuffer` check downstream.
     * A `Bytes` column read through this extension arrived unusable and the
     * failure looked like the row not existing.
     *
     * `ArrayBuffer.isView` covers `Buffer`, every typed array and `DataView`;
     * the buffer itself is checked beside it. None of them can contain a
     * `Date`, so there is nothing here to walk for.
     */
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return value;
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) {
            out[key] = toIsoDates(nested);
        }

        return out;
    }

    return value;
}

/**
 * Build the query extension that serializes every `Date` in a query result to an
 * ISO-8601 string.
 *
 * @remarks
 * The generated `@imqueue/rpc` models type Prisma's `DateTime` as `string` (the
 * codegen `scalars` config decides this), so a service that returned Prisma's own
 * `Date` objects would be handing callers a shape its own types disagree with.
 * This extension closes that gap at the boundary rather than at every call site.
 *
 * Conversion walks the whole result recursively — arrays, nested objects and
 * relations included — and leaves structure and every non-`Date` value untouched.
 * It applies to results only: `Date` values you pass IN as query arguments are
 * still handed to Prisma as `Date`.
 *
 * @returns A Prisma extension to pass to `client.$extends()`.
 * @example
 * ```typescript
 * const client = new PrismaClient().$extends(isoDates());
 * ```
 */
export function isoDates() {
    return Prisma.defineExtension({
        name: 'iso-dates',
        query: {
            $allModels: {
                async $allOperations({ args, query }) {
                    return toIsoDates(await query(args));
                },
            },
        },
    });
}
