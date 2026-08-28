/*!
 * @imqueue/pg-prisma — package barrel regression tests
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
import {
    ColumnRef,
    DeleteAst,
    DerivedTableSource,
    InsertAst,
    SelectAst,
    TableSource,
    UpdateAst,
} from '@prisma/orm-postgres/relational-core/ast';
import { stamp } from '../../index.js';

/** A rewritten node, read structurally: these tests assert on shape. */
type Node = Record<string, any>; // oxlint-disable-line typescript/no-explicit-any

const TABLES = {
    Session: {
        deletedAt: 'deletedAt',
        createdBy: 'createdBy',
        updatedBy: 'updatedBy',
        deletedBy: 'deletedBy',
    },
};

const middleware = stamp({ tables: TABLES, getActorId: () => 'u-1' });

const run = async (ast: unknown): Promise<Node | undefined> =>
    (await middleware.beforeCompile?.({ ast } as never, {} as never))?.ast as
        | Node
        | undefined;

/** Column names a predicate tree touches, in order. */
const columns = (node: Node | undefined): string[] => {
    if (!node) {
        return [];
    }
    if (node.kind === 'and' || node.kind === 'or') {
        return (node.exprs ?? []).flatMap(columns);
    }
    if (node.kind === 'binary') {
        return columns(node.left);
    }
    if (node.kind === 'null-check') {
        return columns(node.expr);
    }

    return node.column ? [node.column] : [];
};

const projection = [
    {
        kind: 'projection-item',
        alias: 'id',
        expr: ColumnRef.of('Session', 'id'),
    },
] as never;

const selectFrom = (source: unknown): unknown =>
    SelectAst.from(source as never).withProjection(projection);

test('a plain select gains the soft-delete filter', async () => {
    const out = await run(selectFrom(TableSource.named('Session')));
    assert.deepEqual(columns(out?.where), ['deletedAt']);
});

test('a select over an unlisted table is untouched', async () => {
    assert.equal(
        await run(selectFrom(TableSource.named('Portfolio'))),
        undefined,
    );
});

// The filter has to reach every select in the statement, not only the root.
// Prisma Next compiles a relation read into one statement whose related rows
// come from a nested select, so filtering the root alone returned soft-deleted
// rows through any include, silently and with nothing logged.
test('a select nested inside a derived source is filtered too', async () => {
    const inner = selectFrom(TableSource.named('Session'));
    const out = await run(
        selectFrom(DerivedTableSource.as('t', inner as never)),
    );
    assert.deepEqual(columns(out?.from.query.where), ['deletedAt']);
});

// Qualifying by the table name when the source carries an alias produces SQL
// Postgres rejects outright.
test('the predicate is qualified by the alias, not the table name', async () => {
    const out = await run(selectFrom(TableSource.named('Session', 's')));
    assert.equal(out?.where.expr.table, 's');
});

test('a delete becomes an update that stamps, keeping its returning', async () => {
    const out = await run(
        DeleteAst.from(TableSource.named('Session'))
            .withWhere(ColumnRef.of('Session', 'id') as never)
            .withReturning(projection),
    );
    assert.equal(out?.kind, 'update');
    assert.deepEqual(Object.keys(out?.set).sort(), [
        'deletedAt',
        'deletedBy',
        'updatedBy',
    ]);
    assert.ok(out?.returning, 'the returning clause must survive the rewrite');
    assert.deepEqual(columns(out?.where), ['id', 'deletedAt']);
});

test('an insert is stamped with the actor', async () => {
    const out = await run(
        InsertAst.into(TableSource.named('Session')).withRows([
            { id: ColumnRef.of('Session', 'id') } as never,
        ]),
    );
    assert.deepEqual(Object.keys(out?.rows[0]).sort(), [
        'createdBy',
        'id',
        'updatedBy',
    ]);
});

// Setting the soft-delete column to null restores a row; stamping `deletedBy`
// there would record whoever brought it back as the one who deleted it.
test('restoring a row does not stamp deletedBy', async () => {
    const out = await run(
        UpdateAst.table(TableSource.named('Session')).withSet({
            deletedAt: { kind: 'param-ref', value: null } as never,
        }),
    );
    assert.deepEqual(Object.keys(out?.set).sort(), ['deletedAt', 'updatedBy']);
});

test('soft-deleting through an update does stamp deletedBy', async () => {
    const out = await run(
        UpdateAst.table(TableSource.named('Session')).withSet({
            deletedAt: { kind: 'param-ref', value: '2026-01-01' } as never,
        }),
    );
    assert.deepEqual(Object.keys(out?.set).sort(), [
        'deletedAt',
        'deletedBy',
        'updatedBy',
    ]);
});
