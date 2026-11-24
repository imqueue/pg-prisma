/*!
 * @imqueue/pg-prisma — the real client over a pool that records statements
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
 * The real Prisma Next client and the real data-layer middleware, over a pool
 * that records every statement it is given instead of reaching a database,
 * and an audit trail whose pool keeps what it inserts.
 */

import { readFileSync } from 'node:fs';
import postgres from '@prisma/orm-postgres/runtime';
import pg from 'pg';
import { type Repository, dataLayer, repositoriesFor } from '../../../index.js';

const contract = JSON.parse(
    readFileSync(
        new URL('../../fixture/contract.json', import.meta.url),
        'utf8',
    ),
);

export interface Note {
    id: string;
    title: string;
    ownerId: string;
    deletedAt: string | null;
}

export const NOTE: Note = {
    id: 'n-1',
    title: 'b',
    ownerId: 'u-1',
    deletedAt: null,
};

export type Answer = (text: string) => object[];

/** Rows a statement gets back: a count, the note, or the note's columns. */
export const answers =
    (rows: object[] = [NOTE]): Answer =>
    text =>
        text.startsWith('SELECT COUNT(*)') ? [{ total: 3 }] : rows;

/** One row of the audit trail, as `audit` inserted it. */
export interface Trailed {
    action: string;
    recordId: string;
    changes: Record<string, unknown>;
}

/**
 * How the harness is built. With no trail, `Note` is left out of it, as a
 * table nothing records; `hard` makes its deletes real ones.
 */
export interface How {
    trail?: boolean;
    hard?: boolean;
    audited?: Record<string, string>;
    /** Data statements the database refuses, `COMMIT` included. */
    refuse?: RegExp;
    /** What the trail's own pool rejects every insert with. */
    trailFails?: Error;
    /** Passed to the trail as its `onError`. */
    onError?: (error: Error) => void;
}

/** The part of the ORM's `Note` collection the specs write through. */
export interface Notes {
    where(filter: object): Notes;
    update(data: object): Promise<unknown>;
    create(data: object): Promise<unknown>;
}

/** The client's ORM, as far as the specs reach into it. */
export interface Orm {
    orm: { public: { Note: Notes } };
}

/** What {@link recorded} hands back. */
export interface Recorded {
    /** The client, as `postgres()` built it: not bound. */
    db: Orm & {
        transaction<Result>(run: (tx: Orm) => Promise<Result>): Promise<Result>;
    };
    layer: ReturnType<typeof dataLayer>;
    repository: Repository<Note>;
    /** Every statement the data pool was sent, in order. */
    sent: string[];
    /** The rows the trail inserted. */
    trail: Trailed[];
    /** Data statements and trail inserts (`TRAIL`), interleaved in order. */
    timeline: string[];
}

/** The real `audit`, its pool swapped for one that keeps what it inserts. */
function trailOf(
    build: () => ReturnType<typeof dataLayer>,
    timeline: string[],
    fails?: Error,
) {
    const trail: Trailed[] = [];
    const layer = withTrailPool(async (_text, values) => {
        timeline.push('TRAIL');

        if (fails) {
            throw fails;
        }

        for (let at = 0; at + 4 < values.length; at += 4) {
            trail.push({
                action: values[at] as string,
                recordId: values[at + 2] as string,
                changes: JSON.parse(values[at + 3] as string),
            });
        }
    }, build);

    return { layer, trail };
}

/**
 * Build something whose `pg.Pool` is a stand-in answering with `query`.
 *
 * @param query - What the stand-in does with each insert it is sent.
 * @param build - Builds the trail, while `pg.Pool` is swapped.
 * @returns Whatever `build` returned.
 */
export function withTrailPool<Built>(
    query: (text: string, values: unknown[]) => Promise<void>,
    build: () => Built,
): Built {
    const Pool = pg.Pool;

    pg.Pool = class {
        on(): this {
            return this;
        }
        async end(): Promise<void> {}
        async query(text: string, values: unknown[]) {
            await query(text, values);

            return { rows: [], rowCount: 0 };
        }
    } as never;

    try {
        return build();
    } finally {
        pg.Pool = Pool;
    }
}

/**
 * The client, the layer and a `Note` repository, recording what they send.
 *
 * @param answer - The rows each data statement gets back.
 * @param how - How the harness is built.
 * @returns The client, what it sent, and what the trail recorded.
 */
export function recorded(answer: Answer = answers(), how: How = {}): Recorded {
    const sent: string[] = [];
    const timeline: string[] = [];
    const query = async (input: unknown) => {
        const text =
            typeof input === 'string'
                ? input
                : (input as { text: string }).text;
        sent.push(text);
        timeline.push(text);

        if (how.refuse?.test(text)) {
            throw new Error(`refused: ${text.split(' ')[0]}`);
        }

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
    const { layer, trail } = trailOf(
        () =>
            dataLayer({
                contract,
                scope: { Note: { owner: ['ownerId'] } },
                resolvers: { owner: () => 'u-1' },
                getActorId: () => null,
                ...(how.hard ? { fields: { deletedAt: 'removedAt' } } : {}),
                ...(how.trail
                    ? {
                          audit: {
                              connectionString:
                                  'postgresql://trail@localhost/none',
                              getPrincipal: () => ({ id: 'u-1' }),
                              ...(how.onError ? { onError: how.onError } : {}),
                          },
                      }
                    : { auditExclude: ['Note'] }),
            }),
        timeline,
        how.trailFails,
    );
    const db = postgres({
        contractJson: contract,
        pg: pool,
        verifyMarker: false,
        middleware: layer.middleware,
    } as never) as unknown as Recorded['db'];
    const repository = repositoriesFor<{ note: Repository<Note> }>(
        db as never,
        {
            relations: layer.derived.relations,
            ...(how.audited ? { audited: how.audited } : {}),
        },
    );

    return {
        db,
        layer,
        repository: repository.note,
        sent,
        trail,
        timeline,
    };
}
