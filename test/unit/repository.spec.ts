/*!
 * @imqueue/pg-prisma — Prisma/Postgres toolkit for @imqueue services
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

/**
 * What the repositories send to Postgres: the real Prisma Next client and the
 * real data-layer middleware, over a pool that records every statement it is
 * given instead of reaching a database.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from '@prisma/orm-postgres/runtime';
import pg from 'pg';
import { type Repository, dataLayer, repositoriesFor } from '../../index.js';

const contract = JSON.parse(
    readFileSync(new URL('../fixture/contract.json', import.meta.url), 'utf8'),
);

interface Note {
    id: string;
    title: string;
    ownerId: string;
    deletedAt: string | null;
}

const NOTE: Note = { id: 'n-1', title: 'b', ownerId: 'u-1', deletedAt: null };

type Answer = (text: string) => object[];

/** Rows a statement gets back: a count, the note, or the note's columns. */
const answers =
    (rows: object[] = [NOTE]): Answer =>
    text =>
        text.startsWith('SELECT COUNT(*)') ? [{ total: 3 }] : rows;

/** One row of the audit trail, as `audit` inserted it. */
interface Trailed {
    action: string;
    recordId: string;
    changes: Record<string, unknown>;
}

/**
 * How the harness is built. With no trail, `Note` is left out of it, as a
 * table nothing records; `hard` makes its deletes real ones.
 */
interface How {
    trail?: boolean;
    hard?: boolean;
    audited?: Record<string, string>;
}

/** The real `audit`, its pool swapped for one that keeps what it inserts. */
function trailOf(build: () => ReturnType<typeof dataLayer>) {
    const trail: Trailed[] = [];
    const Pool = pg.Pool;

    pg.Pool = class {
        on(): this {
            return this;
        }
        async end(): Promise<void> {}
        async query(_text: string, values: unknown[]) {
            for (let at = 0; at + 4 < values.length; at += 4) {
                trail.push({
                    action: values[at] as string,
                    recordId: values[at + 2] as string,
                    changes: JSON.parse(values[at + 3] as string),
                });
            }

            return { rows: [], rowCount: 0 };
        }
    } as never;

    try {
        return { layer: build(), trail };
    } finally {
        pg.Pool = Pool;
    }
}

function recorded(answer: Answer = answers(), how: How = {}) {
    const sent: string[] = [];
    const query = async (input: unknown) => {
        const text =
            typeof input === 'string'
                ? input
                : (input as { text: string }).text;
        sent.push(text);
        const rows = /^(BEGIN|COMMIT|ROLLBACK)/.test(text) ? [] : answer(text);

        return { rows, rowCount: rows.length };
    };
    const client = {
        query,
        release: () => undefined,
        on: () => client,
        off: () => client,
        removeListener: () => client,
    };
    // Read as a `pg.Pool` by the counters it carries.
    const pool = {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        connect: async () => client,
        query,
        on: () => pool,
        end: async () => undefined,
    };
    const { layer, trail } = trailOf(() =>
        dataLayer({
            contract,
            scope: { Note: { owner: ['ownerId'] } },
            resolvers: { owner: () => 'u-1' },
            getActorId: () => null,
            ...(how.hard ? { fields: { deletedAt: 'removedAt' } } : {}),
            ...(how.trail
                ? {
                      audit: {
                          connectionString: 'postgresql://trail@localhost/none',
                          getPrincipal: () => ({ id: 'u-1' }),
                      },
                  }
                : { auditExclude: ['Note'] }),
        }),
    );
    const db = postgres({
        contractJson: contract,
        pg: pool,
        verifyMarker: false,
        middleware: layer.middleware,
    } as never);
    const repository = repositoriesFor<{ note: Repository<Note> }>(
        db as never,
        {
            relations: layer.derived.relations,
            ...(how.audited ? { audited: how.audited } : {}),
        },
    );

    return { repository: repository.note, sent, trail };
}

test('an update by id is one statement', async () => {
    const { repository, sent } = recorded();

    const updated = await repository.update({
        input: { id: 'n-1', title: 'b' },
    });

    assert.deepEqual(updated, NOTE);
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /^UPDATE "public"\."Note" SET/);
    assert.match(sent[0] as string, / RETURNING /);
});

test('the one update is narrowed as the read before it was', async () => {
    const { repository, sent } = recorded();

    await repository.update({ input: { id: 'n-1', title: 'b' } });

    assert.match(sent[0] as string, /"Note"\."id" = \$\d/);
    assert.match(sent[0] as string, /"Note"\."deletedAt" IS NULL/);
    assert.match(sent[0] as string, /"Note"\."ownerId" = \$\d/);
});

test('an update matching no row answers null', async () => {
    const { repository, sent } = recorded(answers([]));

    const updated = await repository.update({
        input: { id: 'n-2', title: 'b' },
    });

    assert.equal(updated, null);
    assert.equal(sent.length, 1, sent.join('\n'));
});

test('an update returns only the columns it selects', async () => {
    const { repository, sent } = recorded(answers([{ title: 'b' }]));

    const updated = await repository.update<
        { title: string },
        { id: string; title: string }
    >({
        input: { id: 'n-1', title: 'b' },
        select: { title: true },
    });

    assert.deepEqual(updated, { title: 'b' });
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.doesNotMatch(sent[0] as string, /RETURNING .*"ownerId"/);
});

// With no id the filter is empty, and one UPDATE would write every row. The
// ORM's own `update` writes the first row only, as it always did.
test('an update with no id still writes one row at most', async () => {
    const { repository, sent } = recorded();

    await repository.update({ input: { title: 'b' } as never });

    assert.deepEqual(
        sent.map(text => text.split(' ')[0]),
        ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT'],
    );
    assert.match(sent[1] as string, / LIMIT 1$/);
});

test('a count is one statement', async () => {
    const { repository, sent } = recorded();

    assert.equal(await repository.count({ where: { title: { eq: 'b' } } }), 3);
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /^SELECT COUNT\(\*\)/);
    assert.match(sent[0] as string, /"Note"\."title" = \$\d/);
    assert.match(sent[0] as string, /"Note"\."deletedAt" IS NULL/);
    assert.match(sent[0] as string, /"Note"\."ownerId" = \$\d/);
});

test('a page with its total is the page and the count', async () => {
    const { repository, sent } = recorded();

    const page = await repository.list({
        options: { take: 10, withTotal: true },
    });

    assert.deepEqual(page, { items: [NOTE], total: 3 });
    assert.equal(sent.length, 2, sent.join('\n'));
});

const NOTES: Note[] = [NOTE, { ...NOTE, id: 'n-2', title: 'c' }];

// A trail records what a statement returns, and a bare count returns nothing:
// a bulk delete or update left no row in the trail at all.
test('a bulk delete of a recorded table is in the trail, row by row', async () => {
    const { repository, sent, trail } = recorded(answers(NOTES), {
        trail: true,
        hard: true,
    });

    const removed = await repository.removeBulk({
        where: { title: { eq: 'b' } },
    });

    assert.deepEqual(removed, { count: 2 });
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /^DELETE FROM "public"\."Note"/);
    assert.match(sent[0] as string, / RETURNING /);
    assert.deepEqual(
        trail.map(row => [row.action, row.recordId]),
        [
            ['DELETE', 'n-1'],
            ['DELETE', 'n-2'],
        ],
    );
    assert.deepEqual(trail[0]?.changes, { ...NOTE });
});

test('a soft bulk delete is in the trail as a delete, row by row', async () => {
    const { repository, sent, trail } = recorded(answers(NOTES), {
        trail: true,
    });

    const removed = await repository.removeBulk({
        where: { title: { eq: 'b' } },
    });

    assert.deepEqual(removed, { count: 2 });
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /^UPDATE "public"\."Note" SET "deletedAt"/);
    assert.match(sent[0] as string, / RETURNING /);
    assert.deepEqual(
        trail.map(row => [row.action, row.recordId]),
        [
            ['DELETE', 'n-1'],
            ['DELETE', 'n-2'],
        ],
    );
});

test('a bulk update of a recorded table is in the trail, row by row', async () => {
    const { repository, sent, trail } = recorded(answers(NOTES), {
        trail: true,
    });

    const updated = await repository.updateBulk({
        where: { ownerId: { eq: 'u-1' } },
        input: { title: 'b' },
    });

    assert.deepEqual(updated, { count: 2 });
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /^UPDATE "public"\."Note" SET "title"/);
    assert.match(sent[0] as string, / RETURNING /);
    assert.deepEqual(
        trail.map(row => [row.action, row.recordId]),
        [
            ['UPDATE', 'n-1'],
            ['UPDATE', 'n-2'],
        ],
    );
});

test('a table the trail leaves out keeps the bare count', async () => {
    const { repository, sent } = recorded(answers(NOTES), { hard: true });

    assert.deepEqual(await repository.removeBulk({}), { count: 2 });
    assert.deepEqual(await repository.updateBulk({ input: { title: 'b' } }), {
        count: 2,
    });
    assert.equal(sent.length, 2, sent.join('\n'));
    assert.match(sent[0] as string, /^DELETE FROM "public"\."Note"/);
    assert.match(sent[1] as string, /^UPDATE "public"\."Note" SET/);

    for (const text of sent) {
        assert.doesNotMatch(text, /RETURNING/);
    }
});

test('a layer told nothing is recorded keeps the bare count', async () => {
    const { repository, sent } = recorded(answers(NOTES), {
        trail: true,
        audited: {},
    });

    await repository.removeBulk({});
    await repository.updateBulk({ input: { title: 'b' } });

    for (const text of sent) {
        assert.doesNotMatch(text, /RETURNING/);
    }
});

// A select narrowed the RETURNING, so a select without the id left the trail
// nothing to key a row on, and one with it left the trail part of the row.
test('a bulk create with a select still hands the trail every row whole', async () => {
    const { repository, sent, trail } = recorded(answers(NOTES), {
        trail: true,
    });

    const created = await repository.createBulk<{ title: string }>({
        input: NOTES.map(({ id, title, ownerId }) => ({ id, title, ownerId })),
        select: { title: true },
    });

    assert.deepEqual(created, [{ title: 'b' }, { title: 'c' }]);
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /RETURNING .*"id".*"ownerId"/);
    assert.deepEqual(
        trail.map(row => [row.action, row.recordId]),
        [
            ['INSERT', 'n-1'],
            ['INSERT', 'n-2'],
        ],
    );
    assert.deepEqual(trail[0]?.changes, { ...NOTE });
});

test('an upsert with a select still hands the trail the row whole', async () => {
    const { repository, sent, trail } = recorded(answers(), { trail: true });

    const upserted = await repository.upsert<{ title: string }>({
        input: { id: 'n-1', title: 'b', ownerId: 'u-1' },
        select: { title: true },
    });

    assert.deepEqual(upserted, { title: 'b' });
    assert.match(sent[0] as string, /RETURNING .*"id".*"ownerId"/);
    assert.deepEqual(
        trail.map(row => [row.recordId, row.changes]),
        [['n-1', { ...NOTE }]],
    );
});

test('an update with a select still hands the trail the row whole', async () => {
    const { repository, sent, trail } = recorded(answers(), { trail: true });

    const updated = await repository.update<
        { title: string },
        { id: string; title: string }
    >({
        input: { id: 'n-1', title: 'b' },
        select: { title: true },
    });

    assert.deepEqual(updated, { title: 'b' });
    assert.match(sent[0] as string, /RETURNING .*"id".*"ownerId"/);
    assert.deepEqual(
        trail.map(row => [row.action, row.recordId, row.changes]),
        [['UPDATE', 'n-1', { ...NOTE }]],
    );
});
