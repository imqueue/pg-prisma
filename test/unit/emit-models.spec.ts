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
import { emitEnums, emitModels } from '../../src/emit/models.js';
import { parseImportMap } from '../../src/emit/imports.js';

const contract = {
    domain: {
        namespaces: {
            public: {
                enum: {
                    Method: { members: [{ value: 'EMAIL' }, { value: 'SMS' }] },
                },
                models: {
                    User: {
                        fields: {
                            id: { type: { codecId: 'pg/text@1' } },
                            age: {
                                nullable: true,
                                type: { codecId: 'pg/int4@1' },
                            },
                            kind: {
                                type: { codecId: 'pg/text@1' },
                                valueSet: { entityName: 'Method' },
                            },
                            methods: {
                                many: true,
                                type: { codecId: 'pg/text@1' },
                            },
                            settings: {
                                nullable: true,
                                type: { codecId: 'pg/jsonb@1' },
                            },
                        },
                        relations: {
                            posts: {
                                cardinality: '1:N',
                                to: { model: 'Post' },
                            },
                            owner: { cardinality: 'N:1', to: { model: 'Org' } },
                        },
                    },
                },
            },
        },
    },
    storage: {
        namespaces: {
            public: {
                entries: {
                    table: {
                        User: {
                            columns: {
                                methods: { valueSet: { entityName: 'Method' } },
                            },
                        },
                    },
                },
            },
        },
    },
};

const emitted = emitModels({ contract });
const line = (field: string): string =>
    emitted
        .split('\n\n')
        .find(block => block.includes(`${field}?:`))
        ?.trim() ?? '';

test('a scalar maps to its TypeScript spelling', () => {
    assert.match(line('id'), /@property\('string', true\)\n {4}id\?: string;/);
});

test('a nullable field carries the null', () => {
    assert.match(line('age'), /age\?: number \| null;/);
});

// The union members are single-quoted, so the decorator argument has to be
// double-quoted or it does not parse.
test('an enum becomes a union, quoted so it parses', () => {
    assert.match(line('kind'), /@property\("'EMAIL' \| 'SMS'", true\)/);
    assert.match(line('kind'), /kind\?: 'EMAIL' \| 'SMS';/);
});

// A list names its value set only on the storage column, so both planes have
// to be read; and `'A' | 'B'[]` parses as `'A' | ('B'[])`.
test('an enum list keeps its union, parenthesised', () => {
    assert.match(
        line('methods'),
        /@property\("Array<'EMAIL' \| 'SMS'>", true\)/,
    );
    assert.match(line('methods'), /methods\?: \('EMAIL' \| 'SMS'\)\[\];/);
});

test('relations become the related class', () => {
    assert.match(
        line('posts'),
        /@property\('Array<Post>', true\)\n {4}posts\?: Post\[\];/,
    );
    assert.match(line('owner'), /owner\?: Org \| null;/);
});

test('by default the runtime import is unchanged', () => {
    assert.ok(
        emitted.startsWith(
            "import { classType, property } from '@imqueue/rpc';",
        ),
    );
});

test('the runtime import is redirected when asked', () => {
    const out = emitModels({
        contract,
        imports: parseImportMap('@imqueue/rpc=@my-org/runtime'),
    });
    assert.ok(
        out.startsWith(
            "import { classType, property } from '@my-org/runtime';",
        ),
    );
});

// A column stays in the contract and in the database; this is only about what
// crosses the RPC boundary. `lms-gate` keeps a raw upstream payload that way.
test('an omitted field is left off the emitted model', () => {
    const out = emitModels({ contract, omit: ['User.age'] });

    assert.ok(!out.includes('age?:'));
    assert.ok(out.includes('id?:'));
});

test('omitting names one model only', () => {
    const out = emitModels({ contract, omit: ['Other.age'] });

    assert.ok(out.includes('age?:'));
});

// Prisma 7 spelled this `STRING @map("string")`. The contract records the
// label alone, so the name is declared beside it and passed in.
test('an enum member takes the name it is given', () => {
    const out = emitEnums({
        contract,
        enums: { Method: { EMAIL_ADDRESS: 'EMAIL' } },
    });

    assert.match(out, /EMAIL_ADDRESS: 'EMAIL',/);
    assert.match(out, /SMS: 'SMS',/);
});

test('an enum with no names given keeps its labels', () => {
    assert.match(emitEnums({ contract }), /EMAIL: 'EMAIL',/);
});

/*
 * A JSON column holds any JSON value — a string, a number, a list — and typing
 * it as an object made every one of those an error at the call site that wrote
 * it, while working perfectly at run time.
 *
 * The published description cannot follow: `@property` carries a name the
 * client generator resolves, and a recursive alias reaches it as whatever it
 * widened to. So the two deliberately differ, and only the code that reads the
 * column is made honest.
 */
test('a json column is any json value in TypeScript', () => {
    assert.match(line('settings'), /settings\?: JsonValue \| null;/);
});

test('and stays an object on the wire, where a union cannot travel', () => {
    assert.match(
        line('settings'),
        /@property\('Record<string, unknown>', true\)/,
    );
});

test('the alias is emitted beside the classes that use it', () => {
    assert.match(emitted, /export type JsonValue =/u);
});

test('and is left out where nothing does', () => {
    const plain = emitModels({
        contract: {
            domain: {
                namespaces: {
                    public: {
                        models: {
                            Thing: {
                                fields: {
                                    id: { type: { codecId: 'pg/text@1' } },
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    assert.doesNotMatch(plain, /JsonValue/u);
});
