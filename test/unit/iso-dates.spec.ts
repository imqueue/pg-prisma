/*!
 * @imqueue/pg-prisma — ISO date conversion tests
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoDates } from '../../index.js';

const middleware = isoDates({ columns: new Set(['createdAt', 'expiresAt']) });
const convert = async (row: object): Promise<object> => {
    await middleware.onRow?.(
        row as Record<string, unknown>,
        undefined as never,
        undefined as never,
    );

    return row;
};

test('an offset timestamp becomes a canonical UTC instant', async () => {
    assert.deepEqual(
        await convert({ createdAt: '2026-08-14 09:30:00.123+00' }),
        {
            createdAt: '2026-08-14T09:30:00.123Z',
        },
    );
});

// Postgres prints `09:30:00.500` as `09:30:00.5` and a whole second with no
// fraction at all, so the width varies with the value. Every boundary
// downstream wants three digits, and a lexicographic comparison of two such
// strings wants them too.
test('a trimmed fraction is padded back to milliseconds', async () => {
    assert.deepEqual(
        await convert({
            createdAt: '2026-08-14 09:30:00.5+00',
            expiresAt: '2026-08-14 09:30:00+00',
        }),
        {
            createdAt: '2026-08-14T09:30:00.500Z',
            expiresAt: '2026-08-14T09:30:00.000Z',
        },
    );
});

// The value is the same instant whichever zone the server prints it in, so
// the conversion has to do the arithmetic rather than swap the suffix.
test('a non-UTC offset is normalised to UTC', async () => {
    assert.deepEqual(
        await convert({ createdAt: '2026-08-14 11:30:00.123+02' }),
        {
            createdAt: '2026-08-14T09:30:00.123Z',
        },
    );
});

// The column type this fallback exists for: without the `Z`, `new Date` reads
// the value as local time and every instant shifts by the host's offset.
test('a timestamp with no zone is read as UTC, not as local time', async () => {
    assert.deepEqual(await convert({ createdAt: '2026-08-14 09:30:00.123' }), {
        createdAt: '2026-08-14T09:30:00.123Z',
    });
});

test('an included relation is converted too', async () => {
    assert.deepEqual(
        await convert({
            createdAt: '2026-08-14 09:30:00+00',
            sessions: [{ expiresAt: '2026-08-14 10:00:00+00' }],
        }),
        {
            createdAt: '2026-08-14T09:30:00.000Z',
            sessions: [{ expiresAt: '2026-08-14T10:00:00.000Z' }],
        },
    );
});

test('a column that is not a date column is left alone', async () => {
    assert.deepEqual(await convert({ note: '2026-08-14 09:30:00+00' }), {
        note: '2026-08-14 09:30:00+00',
    });
});

// The name matching alone is not enough: a text column named like a date one
// holds whatever a caller put in it.
test('a date column holding something else is left alone', async () => {
    assert.deepEqual(await convert({ createdAt: 'yesterday' }), {
        createdAt: 'yesterday',
    });
});

test('a null date is left alone', async () => {
    assert.deepEqual(await convert({ createdAt: null }), { createdAt: null });
});
