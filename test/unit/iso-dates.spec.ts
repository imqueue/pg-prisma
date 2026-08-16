/*!
 * toIsoDates() unit tests
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
import { toIsoDates } from '../../index.js';

test('a date becomes its ISO string', () => {
    assert.equal(
        toIsoDates(new Date('2026-08-16T11:35:59.323Z')),
        '2026-08-16T11:35:59.323Z',
    );
});

test('a date nested in a row is replaced where it sits', () => {
    assert.deepEqual(
        toIsoDates({ id: 'a', at: new Date('2026-01-02T03:04:05.000Z') }),
        { id: 'a', at: '2026-01-02T03:04:05.000Z' },
    );
});

test('an array of rows keeps its order and its shape', () => {
    assert.deepEqual(
        toIsoDates([{ at: new Date(0) }, { at: new Date(1000) }]),
        [
            { at: '1970-01-01T00:00:00.000Z' },
            { at: '1970-01-01T00:00:01.000Z' },
        ],
    );
});

/*
 * The regression. Walking an object with `Object.entries` turns a buffer into
 * `{ "0": 137, "1": 80, … }` — one key per byte, roughly fifty times the size,
 * and no longer something `Buffer.isBuffer` recognises. A `Bytes` column read
 * through this extension arrived unusable, and the failure looked like the row
 * not existing at all.
 */
test('a buffer comes back as the same buffer', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const out = toIsoDates(bytes);

    assert.equal(out, bytes);
    assert.ok(Buffer.isBuffer(out));
});

test('a buffer inside a row survives the walk', () => {
    const bytes = Buffer.from('a logo, more or less');
    const row = toIsoDates({
        name: 'mark.svg',
        data: bytes,
        at: new Date('2026-08-16T00:00:00.000Z'),
    }) as { name: string; data: unknown; at: string };

    assert.ok(Buffer.isBuffer(row.data));
    assert.equal(row.data, bytes);
    assert.equal(row.at, '2026-08-16T00:00:00.000Z');
});

test('every typed array is left alone, not only Buffer', () => {
    for (const view of [
        new Uint8Array([1, 2]),
        new Int16Array([3]),
        new Float64Array([4.5]),
        new DataView(new ArrayBuffer(2)),
    ]) {
        assert.equal(toIsoDates(view), view, view.constructor.name);
    }
});

test('a bare ArrayBuffer is left alone too', () => {
    const buffer = new ArrayBuffer(4);

    assert.equal(toIsoDates(buffer), buffer);
});
