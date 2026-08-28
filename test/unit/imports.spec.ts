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
import { emitImports, parseImportMap } from '../../src/emit/imports.js';

const BASE = '@my-org/runtime';
const ALL = parseImportMap(
    `zod=${BASE}, @imqueue/rpc=${BASE}, @imqueue/validation=${BASE}`,
);

test('with no map, each runtime keeps its own specifier', () => {
    assert.equal(
        emitImports(['rpc', 'zod']),
        "import { classType, property } from '@imqueue/rpc';\n" +
            "import { z } from 'zod';\n",
    );
});

// Redirecting several runtimes at one package is the point of the option;
// emitting one import per original specifier would put three imports of the
// same module in a file, which lints as a duplicate.
test('runtimes redirected to one package become one import', () => {
    assert.equal(
        emitImports(['rpc', 'validation', 'zod'], ALL),
        `import { classType, property, validatable, validate, z } from '${BASE}';\n`,
    );
});

test('a partial map merges only what it redirects', () => {
    assert.equal(
        emitImports(['rpc', 'zod'], parseImportMap(`zod=${BASE}`)),
        "import { classType, property } from '@imqueue/rpc';\n" +
            `import { z } from '${BASE}';\n`,
    );
});

test('symbols and specifiers are sorted, so output is stable', () => {
    assert.equal(
        emitImports(['zod', 'validation', 'rpc'], ALL),
        emitImports(['rpc', 'validation', 'zod'], ALL),
    );
});

test('naming a runtime twice does not duplicate its symbols', () => {
    assert.equal(
        emitImports(['rpc', 'rpc']),
        "import { classType, property } from '@imqueue/rpc';\n",
    );
});

test('no runtimes emits nothing', () => {
    assert.equal(emitImports([]), '');
});

test('an empty or absent spec is no redirection', () => {
    assert.deepEqual(parseImportMap(), {});
    assert.deepEqual(parseImportMap('  '), {});
});

// A typo here would otherwise leave the generated files pointing at the
// original package while the consumer believes they were redirected — and the
// symptom is a second decorator registry that silently validates nothing.
test('redirecting a module this generator never emits throws', () => {
    assert.throws(
        () => parseImportMap(`@imqueue/core=${BASE}`),
        /@imqueue\/core/,
    );
});

test('a malformed entry throws', () => {
    assert.throws(() => parseImportMap('zod'), /not "<from>=<to>"/);
});
