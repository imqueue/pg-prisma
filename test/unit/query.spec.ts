/*!
 * @imqueue/pg-prisma — query translation tests
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
import { toPredicate, toProjection } from '../../index.js';

const relations = {
    UserPermission: {
        permission: {
            target: 'Permission',
            isList: false,
            localFields: ['permissionId'],
            targetFields: ['id'],
        },
        portfolios: {
            target: 'UserPermissionPortfolio',
            isList: true,
            localFields: ['id'],
            targetFields: ['userPermissionId'],
        },
    },
    UserPermissionPortfolio: {},
    Permission: {},
};

test('toProjection keeps scalars apart from relations', () => {
    assert.deepEqual(
        toProjection(relations, 'UserPermission', {
            id: true,
            userId: true,
        }),
        { fields: ['id', 'userId'], includes: [] },
    );
});

test('toProjection treats a relation named true as a whole include', () => {
    assert.deepEqual(
        toProjection(relations, 'UserPermission', { permission: true }),
        {
            fields: [],
            includes: [{ name: 'permission', projection: undefined }],
        },
    );
});

test('toProjection projects within an included relation', () => {
    assert.deepEqual(
        toProjection(relations, 'UserPermission', {
            portfolios: { portfolioId: true },
        }),
        {
            fields: [],
            includes: [
                {
                    name: 'portfolios',
                    projection: { fields: ['portfolioId'], includes: [] },
                },
            ],
        },
    );
});

test('toProjection mixes scalars and relations in one select', () => {
    assert.deepEqual(
        toProjection(relations, 'UserPermission', {
            id: true,
            permission: true,
            portfolios: { portfolioId: true },
        }),
        {
            fields: ['id'],
            includes: [
                { name: 'permission', projection: undefined },
                {
                    name: 'portfolios',
                    projection: { fields: ['portfolioId'], includes: [] },
                },
            ],
        },
    );
});

test('toProjection is undefined when nothing is selected', () => {
    assert.equal(
        toProjection(relations, 'UserPermission', undefined),
        undefined,
    );
    assert.equal(toProjection(relations, 'UserPermission', {}), undefined);
});

// Prisma 7 spelled it the same way, and dropping it turns a search that finds
// `Kyiv` for `kyiv` into one that answers "no such thing".
test('mode: insensitive reaches for ILIKE, and mode is not an operator', () => {
    const asked: string[] = [];
    const field = {
        like: () => asked.push('like'),
        ilike: () => asked.push('ilike'),
    };

    toPredicate({}, 'User', {
        email: { contains: 'Example', mode: 'insensitive' },
    })?.({ email: field } as never);

    assert.deepEqual(asked, ['ilike']);
});
