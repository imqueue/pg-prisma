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

/**
 * The three kinds of write recorded in the audit trail.
 *
 * @remarks
 * These are the literal strings written to the audit table's action column, so
 * they are part of the stored data, not just an internal enum — a reader querying
 * the trail matches on `'INSERT'`, `'UPDATE'` or `'DELETE'`.
 *
 * The mapping from Prisma operations is not one-to-one: `create` records `INSERT`,
 * `update` and `updateMany` record `UPDATE`, `delete` and `deleteMany` record
 * `DELETE`. A soft delete is recorded as `DELETE`, since it is the caller's
 * `delete` that is seen — but only when {@link audit} is added before
 * {@link softDelete}, because the reroute goes to the unextended client and
 * otherwise never reaches the audit extension at all.
 *
 * The value and the type share a name and a page, as the const-plus-derived-union
 * idiom requires.
 */
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

/**
 * Column names in the audit target table.
 *
 * @remarks
 * Every name is required, because the rows are written with raw SQL that quotes
 * these identifiers directly — there is no Prisma model to fall back on. The code
 * generator emits this as `AUDIT_CONFIG`, so it normally comes from your schema
 * rather than being written by hand.
 */
export interface AuditColumns {
    /** Column holding the JSON actor, as returned by `getPrincipal`. */
    principal: string;
    /**
     * Column holding the action string.
     *
     * @remarks
     * One of the three {@link (AuditAction:variable) | AuditAction} values. The member
     * selector is required because the const and the type share the name, and an
     * ambiguous `{@link}` renders as nothing at all rather than as an error.
     */
    action: string;
    /** Column holding the name of the model that was written. */
    model: string;
    /** Column holding the affected record's `id`, or `'many'` for a bulk write. */
    recordId: string;
    /** Column holding the JSON payload: the record, or the args plus a count. */
    changes: string;
    /** Column stamped with the database's `now()` at insert time. */
    createdAt: string;
}

/** Where the audit trail is written, and under which column names. */
export interface AuditConfig {
    /**
     * Table the trail is inserted into.
     *
     * @remarks
     * Named `model` for symmetry with the rest of the config, but it is used as a
     * raw table name — it need not be a Prisma model at all, which is the point of
     * writing the trail with raw SQL.
     */
    model: string;
    /** Column names within that table. */
    columns: AuditColumns;
}

/** Everything {@link audit} needs to build its extension. */
export interface AuditOptions {
    /**
     * The UNEXTENDED Prisma client, used to write the audit rows.
     *
     * @remarks
     * Deliberately unextended: audit rows written through the extended client
     * would themselves be audited.
     */
    client: PrismaClient;
    /** Where the trail goes and what its columns are called. */
    config: AuditConfig;
    /** Models whose writes are recorded to the audit log. */
    models: ReadonlySet<string>;
    /**
     * Resolves the actor to record, or a falsy value to record none.
     *
     * @remarks
     * Called per write and serialized with `JSON.stringify`, so it can return any
     * shape you want stored. Resolving it lazily is what keeps this extension
     * ignorant of where the actor comes from — a request context, an auth token,
     * or nothing at all.
     */
    getPrincipal: () => unknown;
}

/**
 * Build the query extension that records every write to an audited model.
 *
 * @remarks
 * Rows are inserted into `config.model` under the names in `config.columns`,
 * using raw SQL rather than a Prisma model — which is what lets the trail live in
 * a table Prisma knows nothing about. The row id is generated by Postgres
 * (`gen_random_uuid()`) because a Prisma-level `@default(uuid())` on the target is
 * client-side and never applies to a raw insert.
 *
 * What gets captured depends on the operation. `create`, `update` and `delete`
 * record the affected record itself, keyed by its `id`. `updateMany` and
 * `deleteMany` cannot identify rows, so they record the query args and the
 * affected count under the literal `recordId` of `'many'`. A model absent from
 * `models` is not recorded, and neither is a single-row write whose result has no
 * `id` — every audited model is assumed to carry a surrogate `id`.
 *
 * Auditing is fire-and-forget by design: the insert is not awaited, and a failure
 * is swallowed rather than thrown or logged. A write therefore never fails
 * because its audit row could not be stored — and equally, a broken audit
 * configuration is silent. Verify it once against a real table rather than
 * trusting that no error means it is working.
 *
 * Ordering matters when this is combined with an extension that reroutes an
 * operation to another client — {@link softDelete} turning a delete into an
 * update is exactly that. Prisma runs the first-added query hook outermost, so
 * `audit` must be added FIRST or the rerouted operation never reaches it and
 * vanishes from the trail.
 *
 * @param input - The unextended client, the target config, the audited model
 *   names, and the actor resolver.
 * @returns A Prisma extension to pass to `client.$extends()`.
 * @example
 * ```typescript
 * const base = new PrismaClient();
 * const client = base
 *     .$extends(audit({
 *         client: base,
 *         config: AUDIT_CONFIG,
 *         models: new Set(['User']),
 *         getPrincipal: () => context.get()?.user ?? null,
 *     }))
 *     .$extends(softDelete({ client: base, models: SOFT_DELETE_MODELS }));
 * ```
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
