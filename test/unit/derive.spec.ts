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
import { deriveDataLayer } from '../../index.js';

const contract = {
    domain: {
        namespaces: {
            tenant: {
                models: {
                    Note: {
                        fields: {
                            id: {},
                            deletedAt: {},
                            createdBy: {},
                            updatedBy: {},
                            deletedBy: {},
                        },
                        storage: {
                            table: 'notes',
                            fields: {
                                deletedAt: { column: 'deleted_at' },
                                createdBy: { column: 'created_by' },
                            },
                        },
                    },
                    Ledger: {
                        fields: { id: {} },
                        storage: { table: 'ledger', fields: {} },
                    },
                },
            },
        },
    },
};

test('config is keyed by physical table, not by model', () => {
    const layer = deriveDataLayer({ contract });
    assert.deepEqual(Object.keys(layer.stamps), ['notes']);
});

// The namespace is read from the contract rather than assumed to be `public`.
// Guessing it would leave every map empty, disabling every middleware with no
// error at all.
test('a namespace other than public is still read', () => {
    const layer = deriveDataLayer({ contract });
    assert.equal(layer.audit.notes, 'Note');
    assert.equal(layer.audit.ledger, 'Ledger');
});

test('mapped columns are followed, not assumed', () => {
    const layer = deriveDataLayer({ contract });
    assert.deepEqual(layer.stamps.notes, {
        deletedAt: 'deleted_at',
        createdBy: 'created_by',
        updatedBy: 'updatedBy',
        deletedBy: 'deletedBy',
    });
});

test('a model with no stamp columns is absent rather than empty', () => {
    const layer = deriveDataLayer({ contract });
    assert.equal('ledger' in layer.stamps, false);
});

test('audit excludes by model name and keys by table', () => {
    const layer = deriveDataLayer({ contract, auditExclude: ['Ledger'] });
    assert.deepEqual(layer.audit, { notes: 'Note' });
});

test('scope is translated from model and field to table and column', () => {
    const layer = deriveDataLayer({
        contract,
        scope: { Note: { tenant: ['createdBy'] } },
    });
    assert.deepEqual(layer.scope, { notes: { tenant: ['created_by'] } });
});

// A mistyped model name would otherwise leave that model unscoped, which is
// the direction that leaks rows rather than the one that denies them.
test('a scope naming an unknown model throws', () => {
    assert.throws(
        () =>
            deriveDataLayer({ contract, scope: { Notes: { tenant: ['id'] } } }),
        /Notes/,
    );
});
