/*!
 * @imqueue/pg-prisma — audit trail and transactions
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
 * The trail is written through its own pool, so a row inserted as soon as a
 * statement completed stayed there when the transaction around it rolled
 * back: the trail held an update the database never kept.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Repository, transactionFor } from '../../index.js';
import { type Note, answers, recorded } from './support/recorded-client.js';

const declined = new Error('payment provider said no');

test('a write in a transaction that rolls back is not in the trail', async () => {
    const { db, layer, sent, trail } = recorded(answers(), { trail: true });
    const bound = layer.bind(db);

    await assert.rejects(
        bound.transaction(async tx => {
            await tx.orm.public.Note.where({ id: 'n-1' }).update({
                title: 'c',
            });
            throw declined;
        }),
        declined,
    );

    assert.ok(sent.includes('ROLLBACK'), sent.join('\n'));
    assert.deepEqual(trail, []);
});

test('a write in a transaction is recorded once it has committed', async () => {
    const { db, layer, timeline, trail } = recorded(answers(), {
        trail: true,
    });
    const bound = layer.bind(db);

    const result = await bound.transaction(async tx => {
        await tx.orm.public.Note.where({ id: 'n-1' }).update({ title: 'c' });

        return 'done';
    });

    assert.equal(result, 'done');
    assert.deepEqual(
        trail.map(row => [row.action, row.recordId]),
        [['UPDATE', 'n-1']],
    );
    assert.ok(
        timeline.indexOf('COMMIT') < timeline.indexOf('TRAIL'),
        timeline.join('\n'),
    );
});

test('every write of a committed transaction is recorded', async () => {
    const { db, layer, trail } = recorded(answers(), { trail: true });
    const bound = layer.bind(db);

    await bound.transaction(async tx => {
        await tx.orm.public.Note.where({ id: 'n-1' }).update({ title: 'c' });
        await tx.orm.public.Note.where({ id: 'n-1' }).update({ title: 'd' });
    });

    assert.deepEqual(
        trail.map(row => row.action),
        ['UPDATE', 'UPDATE'],
    );
});

test('a transaction whose COMMIT fails leaves nothing in the trail', async () => {
    const { db, layer, trail } = recorded(answers(), {
        trail: true,
        refuse: /^COMMIT/,
    });
    const bound = layer.bind(db);

    await assert.rejects(
        bound.transaction(async tx => {
            await tx.orm.public.Note.where({ id: 'n-1' }).update({
                title: 'c',
            });
        }),
    );

    assert.deepEqual(trail, []);
});

// `transactionFor` opens its transaction through the client it is given, so
// a bound client is all it takes for repository work to be held as well.
test('repository work in a transaction that rolls back is not in the trail', async () => {
    const { db, layer, trail } = recorded(answers(), { trail: true });
    const transaction = transactionFor<{ note: Repository<Note> }>(
        layer.bind(db) as never,
        { relations: layer.derived.relations },
    );

    await assert.rejects(
        transaction(async repository => {
            await repository.note.update({ input: { id: 'n-1', title: 'c' } });
            throw declined;
        }),
        declined,
    );

    assert.deepEqual(trail, []);
});

test('a write outside a transaction is recorded as its statement completes', async () => {
    const { db, layer, timeline, trail } = recorded(answers(), {
        trail: true,
    });
    const bound = layer.bind(db);

    await bound.orm.public.Note.create({
        id: 'n-1',
        title: 'b',
        ownerId: 'u-1',
    });

    assert.deepEqual(
        trail.map(row => [row.action, row.recordId]),
        [['INSERT', 'n-1']],
    );
    assert.deepEqual(
        timeline.map(text => text.split(' ')[0]),
        ['INSERT', 'TRAIL'],
    );
});

// The middleware cannot tell whose transaction a statement is in, so with no
// client bound it records at once, as it always did — and says so, once.
test('without a bound client a write is recorded at once, and that is reported once', async () => {
    const reported: Error[] = [];
    const { db, trail } = recorded(answers(), {
        trail: true,
        onError: error => reported.push(error),
    });

    for (let i = 0; i < 2; i++) {
        await assert.rejects(
            db.transaction(async tx => {
                await tx.orm.public.Note.where({ id: 'n-1' }).update({
                    title: 'c',
                });
                throw declined;
            }),
            declined,
        );
    }

    assert.equal(trail.length, 2);
    assert.equal(reported.length, 1);
    assert.match(reported[0]?.message ?? '', /bind\(\)/);
});

// A top-level `update()` runs in a transaction the ORM opens for itself. Once
// a client is bound, that is no reason to warn.
test("the ORM's own transaction is recorded without a report once bound", async () => {
    const reported: Error[] = [];
    const { db, layer, trail } = recorded(answers(), {
        trail: true,
        onError: error => reported.push(error),
    });
    const bound = layer.bind(db);

    await bound.orm.public.Note.where({ id: 'n-1' }).update({ title: 'c' });

    assert.deepEqual(
        trail.map(row => row.action),
        ['UPDATE'],
    );
    assert.deepEqual(reported, []);
});

test('a client already inside a transaction is bound as it is', () => {
    const { layer } = recorded(answers(), { trail: true });
    const tx = { orm: {} };

    assert.equal(layer.bind(tx), tx);
});

test('with no trail the client is bound as it is', () => {
    const { db, layer } = recorded();

    assert.equal(layer.bind(db), db);
});
