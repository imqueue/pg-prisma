/*!
 * prettifySql() unit tests
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
import { prettifySql } from '../../index.js';

test('breaks before major clauses onto their own lines', () => {
    const out = prettifySql(
        'SELECT id FROM "User" WHERE active = $1 ORDER BY id LIMIT $2',
    );
    assert.deepEqual(out.split('\n'), [
        'SELECT id',
        'FROM "User"',
        'WHERE active = $1',
        'ORDER BY id',
        'LIMIT $2',
    ]);
});

test('collapses runs of whitespace before formatting', () => {
    const out = prettifySql('SELECT   1\n\t  FROM   "User"');
    assert.deepEqual(out.split('\n'), ['SELECT 1', 'FROM "User"']);
});

test('upper-cases the matched keywords', () => {
    const out = prettifySql('select 1 from "User" where id = $1');
    assert.deepEqual(out.split('\n'), [
        'SELECT 1',
        'FROM "User"',
        'WHERE id = $1',
    ]);
});

test('indents AND/OR and JOIN continuations one level', () => {
    const out = prettifySql(
        'SELECT 1 FROM a LEFT JOIN b ON b.a = a.id WHERE x = $1 AND y = $2 OR z = $3',
    );
    assert.deepEqual(out.split('\n'), [
        'SELECT 1',
        'FROM a',
        '  LEFT JOIN b ON b.a = a.id',
        'WHERE x = $1',
        '  AND y = $2',
        '  OR z = $3',
    ]);
});

test('prefers the longer keyword (WITH RECURSIVE stays intact)', () => {
    const out = prettifySql('WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r');
    assert.ok(out.includes('WITH RECURSIVE'));
    assert.ok(!out.includes('WITH\nRECURSIVE'));
});

test('a keyword substring inside an identifier is not broken', () => {
    // "order_id" / "android" must not match ORDER / AND as whole words.
    const out = prettifySql('SELECT order_id, android FROM t');
    assert.deepEqual(out.split('\n'), ['SELECT order_id, android', 'FROM t']);
});
