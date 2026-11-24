/*!
 * @imqueue/pg-prisma — an audit trail that cannot be written says so
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

/**
 * A failed trail insert was reported through the runtime's `ctx.log`, which
 * `postgres()` never wires to anything: the write succeeded, the trail row
 * was missing, and nothing anywhere said so.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audit } from '../../index.js';
import {
    NOTE,
    answers,
    recorded,
    withTrailPool,
} from './support/recorded-client.js';

const missing = new Error('relation "AuditLog" does not exist');

/**
 * One insert into `Note` through the bare middleware, with the context a
 * runtime built by hand passes: one that carries a `log`.
 */
async function insertWithLog(onError?: (error: Error) => void) {
    const warned: unknown[] = [];
    const ctx = {
        scope: 'runtime',
        log: { warn: (event: unknown) => warned.push(event) },
    };
    const plan = { ast: { kind: 'insert', table: { name: 'Note' } } };
    const trail = withTrailPool(
        async () => {
            throw missing;
        },
        () =>
            audit({
                connectionString: 'postgresql://trail@localhost/none',
                tables: { Note: 'Note' },
                getPrincipal: () => null,
                ...(onError ? { onError } : {}),
            }),
    );

    await trail.onRow?.({ id: 'n-1' }, plan as never, ctx as never);
    await trail.afterQuery?.(
        plan as never,
        { completed: true, rowCount: 1, latencyMs: 0, source: 'driver' },
        ctx as never,
    );

    return warned;
}

// `postgres()` gives the runtime no log, but a runtime built by hand can.
test("with no onError, a runtime's own log hears the failure too", async t => {
    const error = t.mock.method(console, 'error', () => undefined);

    const warned = await insertWithLog();

    assert.equal(error.mock.callCount(), 1);
    assert.equal(warned.length, 1);
    assert.match(
        (warned[0] as { message: string }).message,
        /not recorded .*does not exist/,
    );
    assert.equal((warned[0] as { error: Error }).error.cause, missing);
});

test("an onError replaces both console.error and the runtime's log", async t => {
    const error = t.mock.method(console, 'error', () => undefined);
    const reported: Error[] = [];

    const warned = await insertWithLog(failure => reported.push(failure));

    assert.equal(reported.length, 1);
    assert.equal(warned.length, 0);
    assert.equal(error.mock.callCount(), 0);
});

test('a trail that cannot be written is reported, and the write succeeds', async () => {
    const reported: Error[] = [];
    const { repository } = recorded(answers(), {
        trail: true,
        trailFails: missing,
        onError: error => reported.push(error),
    });

    const updated = await repository.update({
        input: { id: 'n-1', title: 'b' },
    });

    assert.deepEqual(updated, NOTE);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.cause, missing);
    assert.match(
        reported[0]?.message ?? '',
        /1 write\(s\) to Note not recorded/,
    );
    assert.match(reported[0]?.message ?? '', /does not exist/);
});

test('with no onError, a trail that cannot be written goes to console.error', async t => {
    const error = t.mock.method(console, 'error', () => undefined);
    const { repository } = recorded(answers(), {
        trail: true,
        trailFails: missing,
    });

    await repository.update({ input: { id: 'n-1', title: 'b' } });

    assert.equal(error.mock.callCount(), 1);
    assert.match(
        String(error.mock.calls[0]?.arguments[0]),
        /not recorded .*does not exist/,
    );
});

test('a reporter that throws does not fail the write either', async t => {
    const error = t.mock.method(console, 'error', () => undefined);
    const { repository } = recorded(answers(), {
        trail: true,
        trailFails: missing,
        onError: () => {
            throw new Error('reporter down');
        },
    });

    const updated = await repository.update({
        input: { id: 'n-1', title: 'b' },
    });

    assert.deepEqual(updated, NOTE);
    assert.equal(error.mock.callCount(), 1);
});

test('a trail that cannot be written after COMMIT does not fail the transaction', async () => {
    const reported: Error[] = [];
    const { db, layer } = recorded(answers(), {
        trail: true,
        trailFails: missing,
        onError: error => reported.push(error),
    });

    const result = await layer.bind(db).transaction(async tx => {
        await tx.orm.public.Note.where({ id: 'n-1' }).update({ title: 'c' });

        return 'committed';
    });

    assert.equal(result, 'committed');
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.cause, missing);
});
