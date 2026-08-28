/*!
 * Postgres row-change NOTIFY trigger installer — tests
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
import { describe, it } from 'node:test';
import {
    CHANGE_NOTIFY_SUPPRESS_SETTING,
    installChangeTriggers,
    withoutChangeNotify,
} from '../../src/change-notify.js';

interface Installed {
    schema: string;
    table: string;
}

/** A fake pool of the shape a `pg.Pool` presents, recording what it is given. */
function client(installed: Installed[] = []) {
    const statements: string[] = [];
    const queries: { sql: string; values: unknown[] }[] = [];

    const executor = {
        query: async (sql: string, values: readonly unknown[] = []) => {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            // Only the parameterised reads are of interest to the assertions;
            // recording the DDL here too would renumber every index.
            if (values.length > 0) {
                queries.push({ sql, values: [...values] });
            }

            const schemas = (values[1] ?? []) as string[];

            return {
                rows: installed.filter(one => schemas.includes(one.schema)),
            };
        },
    };

    return {
        statements,
        queries,
        ...executor,
        connect: async () => ({ ...executor, release: () => undefined }),
    };
}

describe('installChangeTriggers()', () => {
    it('notifies the schema alongside the table', async () => {
        const db = client();

        await installChangeTriggers(db, { models: ['User'] });

        const fn = db.statements.find(one => one.includes('pg_notify'));

        assert.ok(fn, 'the notify function is created');
        assert.match(fn, /'schema', TG_TABLE_SCHEMA/);
        assert.match(fn, /'table', TG_TABLE_NAME/);
    });

    it('creates the trigger in the default schema', async () => {
        const db = client();

        await installChangeTriggers(db, { models: ['User'] });

        assert.ok(
            db.statements.some(one => one.includes('ON "public"."User"')),
            'the table is schema-qualified',
        );
    });

    it('takes a schema named on the model itself', async () => {
        const db = client();

        await installChangeTriggers(db, { models: ['tenant_a.Loan'] });

        assert.ok(
            db.statements.some(one => one.includes('ON "tenant_a"."Loan"')),
        );
    });

    it('drops a trigger the desired set no longer names', async () => {
        const db = client([
            { schema: 'public', table: 'User' },
            { schema: 'public', table: 'Gone' },
        ]);

        await installChangeTriggers(db, { models: ['User'] });

        assert.ok(
            db.statements.some(one =>
                one.includes(
                    'DROP TRIGGER IF EXISTS "record_change_notify" ON "public"."Gone"',
                ),
            ),
            'the unlisted table is reconciled away',
        );
        assert.ok(
            !db.statements.some(
                one =>
                    one.includes('"public"."User"') && one.startsWith('DROP'),
            ),
            'the listed one is left alone',
        );
    });

    /**
     * The whole point of confining it: a service that installs per tenant
     * schema reconciles one without tearing down the rest.
     */
    it('leaves schemas the desired set never mentions alone', async () => {
        const db = client([
            { schema: 'public', table: 'User' },
            { schema: 'tenant_b', table: 'Loan' },
        ]);

        await installChangeTriggers(db, { models: ['User'] });

        assert.deepEqual(db.queries[0]?.values[1], ['public']);
        assert.ok(
            !db.statements.some(one => one.includes('tenant_b')),
            'another schema is not touched',
        );
    });

    it('reads back only the schemas it is about to reconcile', async () => {
        const db = client();

        await installChangeTriggers(db, {
            models: ['User', 'tenant_a.Loan'],
        });

        assert.deepEqual(db.queries[0]?.values[1], ['public', 'tenant_a']);
    });
});

describe('withoutChangeNotify()', () => {
    it('sets the suppression only for its own transaction', async () => {
        const db = client();

        await withoutChangeNotify(db, async tx => {
            await tx.query('INSERT INTO "Term" VALUES (1)');
        });

        assert.deepEqual(
            db.statements.slice(0, 3),
            [
                'BEGIN',
                `SET LOCAL "${CHANGE_NOTIFY_SUPPRESS_SETTING}" = 'on'`,
                'INSERT INTO "Term" VALUES (1)',
            ],
            'the setting is LOCAL, so it reverts with the transaction',
        );
        assert.equal(db.statements.at(-1), 'COMMIT');
    });

    it('hands the transaction to the caller, not the outer client', async () => {
        const db = client();
        let handed: unknown;

        await withoutChangeNotify(db, async tx => {
            handed = tx;
        });

        assert.ok(handed, 'writes issued elsewhere would notify as usual');
    });

    it('returns what the work returns', async () => {
        const db = client();

        assert.equal(await withoutChangeNotify(db, async () => 42), 42);
    });

    it('takes a different setting when the trigger was given one', async () => {
        const db = client();

        await withoutChangeNotify(db, async () => undefined, 'app.quiet');

        assert.equal(db.statements[1], `SET LOCAL "app.quiet" = 'on'`);
    });
});

describe('the trigger body', () => {
    it('returns early while the suppression is set', async () => {
        const db = client();

        await installChangeTriggers(db, { models: ['User'] });

        const fn = db.statements.find(one => one.includes('pg_notify')) ?? '';

        assert.match(
            fn,
            new RegExp(
                `current_setting\\('${CHANGE_NOTIFY_SUPPRESS_SETTING}', true\\)`,
            ),
        );
        assert.ok(
            fn.indexOf('RETURN NULL') < fn.indexOf('pg_notify'),
            'it gives up before building a payload, not after',
        );
    });
});
