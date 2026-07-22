/*!
 * Prisma audit-trail query extension
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

import { Prisma, type PrismaClient } from '@prisma/client/extension';

export const AuditAction = {
    INSERT: 'INSERT',
    UPDATE: 'UPDATE',
    DELETE: 'DELETE',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** A record's `id` — every audited model carries a surrogate `id` PK — or null. */
function recordKey(rec: Record<string, unknown>): string | null {
    return rec.id !== undefined && rec.id !== null ? String(rec.id) : null;
}

/** Column names of the audit target model (see the generated `AUDIT_CONFIG`). */
export interface AuditColumns {
    principal: string;
    action: string;
    model: string;
    recordId: string;
    changes: string;
    createdAt: string;
}

/** Audit config: the target model and its column names. */
export interface AuditConfig {
    model: string;
    columns: AuditColumns;
}

export interface AuditOptions {
    client: PrismaClient;
    config: AuditConfig;
    /** Models whose writes are recorded to the audit log. */
    models: ReadonlySet<string>;
    getPrincipal: () => unknown;
}

/**
 * Query extension recording every write to an audited model into the audit
 * target table (`audit.table`, columns `audit.columns`) via raw SQL — so the
 * target table and its column names are configurable and need not be a Prisma
 * model. Single-row `create`/`update`/`delete` capture the affected record
 * (keyed by `id`); `updateMany`/`deleteMany` record the args + affected count
 * under `recordId: 'many'`. Writes go through the unextended `client` so audit
 * rows are never themselves audited, and are fire-and-forget: a failed audit
 * write is swallowed, never thrown (and never logged). The actor is resolved
 * lazily via `getPrincipal` so this stays decoupled from the transport.
 *
 * Ordering: when combined with extensions that reroute operations to another
 * client (e.g. `softDelete` turning deletes into updates), this extension must
 * be added FIRST — the first-added query hook is the outermost — or those
 * operations vanish from the trail before it sees them.
 */
export function audit({ client, config, models, getPrincipal }: AuditOptions) {
    const { model: auditModel, columns: col } = config;
    // INSERT INTO "<model>" ("id","action","model","recordId","principal","changes","createdAt")
    //   VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5::jsonb, now())
    // The id is generated IN SQL: the target's Prisma-level `@default(uuid())`
    // is client-side and never applies to a raw insert.
    const sql =
        `INSERT INTO "${auditModel}" ` +
        `("id", "${col.action}", "${col.model}", "${col.recordId}", ` +
        `"${col.principal}", "${col.changes}", "${col.createdAt}") ` +
        `VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5::jsonb, now())`;

    function principalJson(): string | null {
        const principal = getPrincipal();

        return principal ? JSON.stringify(principal) : null;
    }

    async function insert(
        action: AuditAction,
        model: string,
        recordId: string,
        changes: unknown,
    ): Promise<void> {
        await client.$executeRawUnsafe(
            sql,
            action,
            model,
            recordId,
            principalJson(),
            JSON.stringify(changes),
        );
    }

    function auditAsync(
        action: AuditAction,
        model: string,
        record: unknown,
    ): void {
        if (!models.has(model)) {
            return;
        }
        const rec = record as Record<string, unknown> | null;
        const recordId = rec ? recordKey(rec) : null;
        if (!rec || recordId === null) {
            return;
        }
        void insert(action, model, recordId, rec).catch(() => {});
    }

    function auditManyAsync(
        action: AuditAction,
        model: string,
        args: unknown,
        result: unknown,
    ): void {
        if (!models.has(model)) {
            return;
        }
        const count = (result as { count?: number } | null)?.count ?? null;
        void insert(action, model, 'many', { args, count }).catch(() => {});
    }

    return Prisma.defineExtension({
        name: 'audit',
        query: {
            $allModels: {
                async create({ model, args, query }) {
                    const result = await query(args);
                    auditAsync(AuditAction.INSERT, model, result);
                    return result;
                },
                async update({ model, args, query }) {
                    const result = await query(args);
                    auditAsync(AuditAction.UPDATE, model, result);
                    return result;
                },
                async delete({ model, args, query }) {
                    const result = await query(args);
                    auditAsync(AuditAction.DELETE, model, result);
                    return result;
                },
                async updateMany({ model, args, query }) {
                    const result = await query(args);
                    auditManyAsync(AuditAction.UPDATE, model, args, result);
                    return result;
                },
                async deleteMany({ model, args, query }) {
                    const result = await query(args);
                    auditManyAsync(AuditAction.DELETE, model, args, result);
                    return result;
                },
            },
        },
    });
}
