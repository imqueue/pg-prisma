/*!
 * accessWhere() unit tests
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
import { type AccessScopeResolver, scopePredicate } from '../../index.js';

/** Build a resolvers map from plain values (a value → a `() => value` getter). */
const resolvers = (
    map: Record<string, ReturnType<AccessScopeResolver>>,
): Record<string, AccessScopeResolver> =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, () => v]));

/**
 * Reduce a predicate to the shape these tests are about.
 *
 * @remarks
 * Comparing the AST nodes directly would assert the runtime's internals rather
 * than this package's composition, and would break on any upstream field it
 * adds. What matters here is the operator tree and the columns it touches.
 */
const shape = (node: unknown): unknown => {
    const n = node as {
        kind?: string;
        exprs?: unknown[];
        op?: string;
        left?: { column?: string };
        right?: {
            kind?: string;
            values?: { value?: unknown }[];
            value?: unknown;
        };
    };
    if (n?.kind === 'and' || n?.kind === 'or') {
        return { [n.kind]: (n.exprs ?? []).map(shape) };
    }
    if (n?.kind === 'binary') {
        const right =
            n.right?.kind === 'list'
                ? (n.right.values ?? []).map(v => v.value)
                : n.right?.value;

        return { [`${n.left?.column} ${n.op}`]: right };
    }

    return n?.kind ?? n;
};

test('an unscoped model yields no predicate', () => {
    assert.equal(scopePredicate('t', undefined, resolvers({})), null);
});

test('a single scalar column becomes an OR-of-one equality', () => {
    const out = scopePredicate(
        't',
        { user: ['createdBy'] },
        resolvers({ user: 'u1' }),
    );
    assert.deepEqual(shape(out), { or: [{ 'createdBy eq': 'u1' }] });
});

test('several columns for one level are OR-ed (union)', () => {
    const out = scopePredicate(
        't',
        { user: ['createdBy', 'id'] },
        resolvers({ user: 'u1' }),
    );
    assert.deepEqual(shape(out), {
        or: [{ 'createdBy eq': 'u1' }, { 'id eq': 'u1' }],
    });
});

test('an array value becomes an IN filter', () => {
    const out = scopePredicate(
        't',
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: ['p1', 'p2'] }),
    );
    assert.deepEqual(shape(out), { or: [{ 'portfolioId in': ['p1', 'p2'] }] });
});

test('active levels are AND-ed together; each is its own OR group', () => {
    const out = scopePredicate(
        't',
        { user: ['createdBy', 'id'], portfolio: ['portfolioId'] },
        resolvers({ user: 'u1', portfolio: ['p1'] }),
    );
    assert.deepEqual(shape(out), {
        and: [
            { or: [{ 'createdBy eq': 'u1' }, { 'id eq': 'u1' }] },
            { or: [{ 'portfolioId in': ['p1'] }] },
        ],
    });
});

test('an undefined resolver value leaves that level inactive', () => {
    const out = scopePredicate(
        't',
        { user: ['createdBy'], portfolio: ['portfolioId'] },
        resolvers({ user: 'u1', portfolio: undefined }),
    );
    assert.deepEqual(shape(out), { or: [{ 'createdBy eq': 'u1' }] });
});

test('all levels inactive yields no predicate', () => {
    const out = scopePredicate(
        't',
        { user: ['createdBy'] },
        resolvers({ user: undefined }),
    );
    assert.equal(out, null);
});

test('a null value denies via an impossible IN ()', () => {
    const out = scopePredicate(
        't',
        { user: ['createdBy', 'id'] },
        resolvers({ user: null }),
    );
    assert.deepEqual(shape(out), {
        or: [{ 'createdBy in': [] }, { 'id in': [] }],
    });
});

test('a level named in the config but with no resolver is skipped', () => {
    const out = scopePredicate('t', { user: ['createdBy'] }, resolvers({}));
    assert.equal(out, null);
});
