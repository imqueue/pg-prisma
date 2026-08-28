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
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');

/** Everything the package publishes at runtime, in sorted order. */
const EXPORTS = [
    'AuditAction',
    'CHANGE_NOTIFY_CHANNEL',
    'CHANGE_NOTIFY_FUNCTION_NAME',
    'CHANGE_NOTIFY_SUPPRESS_SETTING',
    'CHANGE_NOTIFY_TRIGGER_NAME',
    'EMPTY',
    'RUNTIME',
    'TIMESTAMP_CODECS',
    'accessScope',
    'audit',
    'dataLayer',
    'dataPool',
    'deriveDataLayer',
    'emitAll',
    'emitEnums',
    'emitImports',
    'emitModels',
    'emitRpcTypes',
    'hasDatabaseDefault',
    'installArchiving',
    'installChangeTriggers',
    'isSqlLogSuppressed',
    'isoDates',
    'join',
    'namespaceOf',
    'parseImportMap',
    'prettifySql',
    'queryLog',
    'quoted',
    'raw',
    'repositoriesFor',
    'scopePredicate',
    'silently',
    'sql',
    'sqlRunner',
    'stamp',
    'toOrdering',
    'toPredicate',
    'toProjection',
    'toQuery',
    'transactionFor',
    'typeOf',
    'withTransaction',
    'withoutChangeNotify',
];

// The package is ESM, but Node >= 22 lets CommonJS `require()` an ESM module —
// UNLESS some module in the graph is async (top-level await), which fails hard
// with ERR_REQUIRE_ASYNC_MODULE. Two things put an async module in this graph and
// so broke every CJS consumer of the package:
//
//   * `export * from './codegen.js'` in src/index.ts, which pulled in a
//     top-level `await import(...)`;
//   * `await cli()` at the foot of src/migrate-down.ts.
//
// Both modules are gone on Prisma Next — the contract emitter replaced the
// generator and the migration graph replaced the down-migration CLI — so
// neither cause can recur. The guard stays because the failure is invisible
// from inside ESM, and the next module to add a top-level await would
// reintroduce it silently.
test('the package barrel is require()-able from CommonJS', () => {
    const out = execFileSync(
        process.execPath,
        [
            '-e',
            'const m = require(process.argv[1]);' +
                'console.log(Object.keys(m).sort().join(","))',
            join(ROOT, 'index.js'),
        ],
        { encoding: 'utf8', cwd: ROOT },
    );

    /*
     * The names rather than a count, because a count cannot say what moved.
     * "expected 16 runtime exports" is what this said when an export was added
     * deliberately, and it sends the reader to the wrong question — whether the
     * barrel broke — when the answer is simply that the surface changed and
     * this list is where it is written down.
     *
     * Which makes the assertion do two jobs: the require() itself is the one
     * that matters, since an async module anywhere in the graph fails it
     * outright, and the list is the package's public surface, changed on
     * purpose or not at all.
     */
    assert.deepEqual(out.trim().split(','), EXPORTS);
});

test('the barrel exports the same names to ESM and CommonJS', async () => {
    const esm = Object.keys(await import('../../index.js')).sort();
    const cjs = Object.keys(
        createRequire(import.meta.url)('../../index.js'),
    ).sort();

    assert.deepEqual(cjs, esm);
});
