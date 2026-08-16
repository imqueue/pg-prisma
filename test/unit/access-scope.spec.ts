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
import { accessWhere, type AccessScopeResolver } from '../../index.js';

/** Build a resolvers map from plain values (a value → a `() => value` getter). */
const resolvers = (
    map: Record<string, ReturnType<AccessScopeResolver>>,
): Record<string, AccessScopeResolver> =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, () => v]));

test('an unscoped model passes its where through untouched', () => {
    const where = { name: 'x' };
    assert.equal(accessWhere(where, undefined, resolvers({})), where);
});

test('a single scalar column becomes an OR-of-one equals, AND-ed on', () => {
    const out = accessWhere(
        undefined,
        { user: ['createdBy'] },
        resolvers({ user: 'u1' }),
    );
    assert.deepEqual(out, { AND: [{ OR: [{ createdBy: 'u1' }] }] });
});

test('several columns for one level are OR-ed (union)', () => {
    const out = accessWhere(
        undefined,
        { user: ['createdBy', 'id'] },
        resolvers({ user: 'u1' }),
    );
    assert.deepEqual(out, {
        AND: [{ OR: [{ createdBy: 'u1' }, { id: 'u1' }] }],
    });
});

test('an array value becomes an IN filter', () => {
    const out = accessWhere(
        undefined,
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: ['p1', 'p2'] }),
    );
    assert.deepEqual(out, {
        AND: [{ OR: [{ portfolioId: { in: ['p1', 'p2'] } }] }],
    });
});

test('active levels are AND-ed together; each is its own OR group', () => {
    const out = accessWhere(
        undefined,
        { user: ['createdBy', 'id'], portfolio: ['portfolioId'] },
        resolvers({ user: 'u1', portfolio: ['p1'] }),
    );
    assert.deepEqual(out, {
        AND: [
            { OR: [{ createdBy: 'u1' }, { id: 'u1' }] },
            { OR: [{ portfolioId: { in: ['p1'] } }] },
        ],
    });
});

test('an undefined resolver value leaves that level inactive', () => {
    const out = accessWhere(
        undefined,
        { user: ['createdBy'], portfolio: ['portfolioId'] },
        resolvers({ user: 'u1', portfolio: undefined }),
    );
    // Only the user level constrains; portfolio is skipped entirely.
    assert.deepEqual(out, { AND: [{ OR: [{ createdBy: 'u1' }] }] });
});

test('all levels inactive returns the where unchanged', () => {
    const where = { active: true };
    const out = accessWhere(
        where,
        { user: ['createdBy'] },
        resolvers({ user: undefined }),
    );
    assert.equal(out, where);
});

test('a null value denies via an impossible IN ()', () => {
    const out = accessWhere(
        undefined,
        { user: ['createdBy', 'id'] },
        resolvers({ user: null }),
    );
    assert.deepEqual(out, {
        AND: [{ OR: [{ createdBy: { in: [] } }, { id: { in: [] } }] }],
    });
});

test('an empty array also denies (IN of nothing)', () => {
    const out = accessWhere(
        undefined,
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: [] }),
    );
    assert.deepEqual(out, {
        AND: [{ OR: [{ portfolioId: { in: [] } }] }],
    });
});

test('the caller where is preserved and AND-ed, never replaced', () => {
    const out = accessWhere(
        { active: true },
        { user: ['createdBy'] },
        resolvers({ user: 'u1' }),
    );
    assert.deepEqual(out, {
        active: true,
        AND: [{ OR: [{ createdBy: 'u1' }] }],
    });
});

test('a missing resolver for a configured level is skipped', () => {
    const out = accessWhere(
        undefined,
        { user: ['createdBy'], portfolio: ['portfolioId'] },
        resolvers({ user: 'u1' }), // no `portfolio` resolver at all
    );
    assert.deepEqual(out, { AND: [{ OR: [{ createdBy: 'u1' }] }] });
});

/*
 * The regression the rest of this file exists for.
 *
 * `update`, `delete` and `findUnique` take a `WhereUniqueInput`, and Prisma
 * requires a unique field at its *top level*. Nesting the caller's `where`
 * inside `AND` — which this did — left the argument with no unique field, so
 * Prisma refused the call instead of scoping it, and every scoped update in
 * every service using this extension failed.
 */
test('a unique field stays at the top level, where update needs it', () => {
    const out = accessWhere(
        { id: 'r1' },
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: ['p1'] }),
    );
    assert.deepEqual(out, {
        id: 'r1',
        AND: [{ OR: [{ portfolioId: { in: ['p1'] } }] }],
    });
});

test("the caller's own AND is conjoined rather than overwritten", () => {
    const out = accessWhere(
        { id: 'r1', AND: [{ active: true }] },
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: ['p1'] }),
    );
    assert.deepEqual(out, {
        id: 'r1',
        AND: [{ active: true }, { OR: [{ portfolioId: { in: ['p1'] } }] }],
    });
});

test('a single-object AND from the caller is conjoined too', () => {
    const out = accessWhere(
        { id: 'r1', AND: { active: true } },
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: ['p1'] }),
    );
    assert.deepEqual(out, {
        id: 'r1',
        AND: [{ active: true }, { OR: [{ portfolioId: { in: ['p1'] } }] }],
    });
});

test('a caller condition on a scope column is kept, so it cannot widen', () => {
    const out = accessWhere(
        { portfolioId: 'p9' },
        { portfolio: ['portfolioId'] },
        resolvers({ portfolio: ['p1'] }),
    );
    // Both conditions apply: asking for p9 under a p1 scope matches nothing.
    assert.deepEqual(out, {
        portfolioId: 'p9',
        AND: [{ OR: [{ portfolioId: { in: ['p1'] } }] }],
    });
});
