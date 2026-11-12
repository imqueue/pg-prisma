/*!
 * @imqueue/pg-prisma — audit trail pool tests
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
import pg from 'pg';
import { audit } from '../../index.js';

const built = (pool?: pg.PoolConfig): pg.PoolConfig => {
    const seen: pg.PoolConfig[] = [];
    const Pool = pg.Pool;

    pg.Pool = class extends Pool {
        public constructor(config?: pg.PoolConfig) {
            super(config);
            seen.push(config ?? {});
        }
    } as typeof pg.Pool;

    try {
        void audit({
            connectionString: 'postgresql://trail@localhost/none',
            ...(pool ? { pool } : {}),
            tables: {},
            getPrincipal: () => null,
        }).close();
    } finally {
        pg.Pool = Pool;
    }

    return seen[0] as pg.PoolConfig;
};

test("the trail's pool is pg's own where nothing is said", () => {
    assert.deepEqual(built(), {
        connectionString: 'postgresql://trail@localhost/none',
    });
});

// Sized like the data pool it audits, rather than pg's ten beside a pool of
// five, and given the same timeouts.
test("the trail's pool takes the settings it is given", () => {
    assert.deepEqual(built({ max: 5, min: 2, idleTimeoutMillis: 300_000 }), {
        max: 5,
        min: 2,
        idleTimeoutMillis: 300_000,
        connectionString: 'postgresql://trail@localhost/none',
    });
});
