/*!
 * @imqueue/pg-prisma — SQL fragment composition tests
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY, join, raw, sql, toQuery } from '../../index.js';

test('an interpolated value is bound, not written in', () => {
    const query = sql`SELECT * FROM "User" WHERE id = ${'abc'}`;

    assert.equal(query.text, 'SELECT * FROM "User" WHERE id = $1');
    assert.deepEqual(query.values, ['abc']);
});

// The whole point of composing: a fragment binds `$1` on its own, and has to
// bind whatever comes next once it is spliced into something else.
test('a spliced fragment has its placeholders renumbered', () => {
    const filter = sql`"key" = ${'k'}`;
    const query = sql`SELECT ${1} FROM t WHERE ${filter} AND "id" = ${'i'}`;

    assert.equal(query.text, 'SELECT $1 FROM t WHERE "key" = $2 AND "id" = $3');
    assert.deepEqual(query.values, [1, 'k', 'i']);
});

test('join renumbers each part in turn', () => {
    const query = sql`WHERE ${join(
        [sql`a = ${1}`, sql`b = ${2}`, sql`c = ${3}`],
        ' OR ',
    )}`;

    assert.equal(query.text, 'WHERE a = $1 OR b = $2 OR c = $3');
    assert.deepEqual(query.values, [1, 2, 3]);
});

test('join of nothing is empty', () => {
    assert.deepEqual(join([]), EMPTY);
});

test('raw text binds nothing', () => {
    const query = sql`ORDER BY ${raw('"key" DESC')}, id = ${7}`;

    assert.equal(query.text, 'ORDER BY "key" DESC, id = $1');
    assert.deepEqual(query.values, [7]);
});

// A null is a value like any other; it must not become the text `null`.
test('null and undefined are bound', () => {
    const query = sql`a = ${null} AND b = ${undefined}`;

    assert.equal(query.text, 'a = $1 AND b = $2');
    assert.deepEqual(query.values, [null, undefined]);
});

test('toQuery gives the pair a driver takes', () => {
    const [text, values] = toQuery(sql`SELECT ${1}`);

    assert.equal(text, 'SELECT $1');
    assert.deepEqual(values, [1]);
});
