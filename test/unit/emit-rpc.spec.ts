/*!
 * @imqueue/pg-prisma — RPC emitter tests
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitRpcTypes } from '../../index.js';

const contract = {
    domain: {
        namespaces: {
            public: {
                models: {
                    User: {
                        fields: {
                            id: { type: { codecId: 'pg/text@1' } },
                            age: { type: { codecId: 'pg/int4@1' } },
                        },
                    },
                },
            },
        },
    },
    storage: {
        namespaces: {
            public: { entries: { table: { User: { columns: {} } } } },
        },
    },
};

// A rule says what is allowed about a value, not what the value is. `.int()`
// on `z.string()` is a type error, and a `String` base gave it to every
// validated number in the contract.
test('a validated number is validated as a number', () => {
    const out = emitRpcTypes({
        contract: contract as never,
        validation: { User: { age: '.int().min(0)' } },
    });

    assert.match(out, /@validate\(z\.number\(\)\.int\(\)\.min\(0\)/);
});

test('a validated string is still a string', () => {
    const out = emitRpcTypes({
        contract: contract as never,
        validation: { User: { id: '.min(1)' } },
    });

    assert.match(out, /@validate\(z\.string\(\)\.min\(1\)/);
});
