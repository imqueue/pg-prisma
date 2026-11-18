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
import {
    type Repository,
    dataLayer,
    deriveDataLayer,
    repositoriesFor,
} from '../../index.js';

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

function recorded(answer: Answer = answers()) {
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
    const layer = dataLayer({
        contract,
        scope: { Note: { owner: ['ownerId'] } },
        resolvers: { owner: () => 'u-1' },
        getActorId: () => null,
    });
    const db = postgres({
        contractJson: contract,
        pg: pool,
        verifyMarker: false,
        middleware: layer.middleware,
    } as never);
    const { relations } = deriveDataLayer({ contract });
    const repository = repositoriesFor<{ note: Repository<Note> }>(
        db as never,
        { relations },
    );

    return { repository: repository.note, sent };
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
