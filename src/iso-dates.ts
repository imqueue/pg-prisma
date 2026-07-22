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

/** Recursively replace every `Date` with its ISO-8601 string, structure intact. */
function toIsoDates(value: unknown): unknown {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        return value.map(toIsoDates);
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
 * Query extension serializing every `Date` in a query result to an ISO string,
 * so wire values match the generated models (which type `DateTime` as `string`,
 * per the codegen `scalars` config).
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
