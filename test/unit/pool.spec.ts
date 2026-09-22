/*!
 * @imqueue/pg-prisma — pool tests
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
import { mock, test } from 'node:test';
import pg from 'pg';
import { dataPool, survivesLostConnections } from '../../index.js';

const terminated = new Error(
    'terminating connection due to administrator command',
);

test('an unguarded pool throws on a lost idle connection', async () => {
    const pool = new pg.Pool();

    assert.throws(() => pool.emit('error', terminated), terminated);
    await pool.end();
});

test('a guarded pool reports a lost idle connection and carries on', async t => {
    const report = mock.method(console, 'error', () => undefined);
    const pool = survivesLostConnections(new pg.Pool());

    t.after(() => report.mock.restore());

    assert.equal(pool.emit('error', terminated), true);
    assert.match(
        String(report.mock.calls[0]?.arguments[0]),
        /administrator command/,
    );
    await pool.end();
});

test('dataPool is guarded', async t => {
    const report = mock.method(console, 'error', () => undefined);
    const pool = dataPool({});

    t.after(() => report.mock.restore());

    assert.doesNotThrow(() => pool.emit('error', terminated));
    await pool.end();
});
