/*!
 * Prisma Next (8.x) data layer: one call, correctly composed
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

import { isoDates } from './iso-dates.js';
import { type AccessScopeResolver, accessScope } from './access-scope.js';
import { type AuditConfig, audit } from './audit.js';
import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
import {
    type DerivedDataLayer,
    type DeriveOptions,
    deriveDataLayer,
} from './derive.js';
import { type QueryLogOptions, queryLog } from './query-log.js';
import { stamp } from './stamp.js';

/** The audit half of {@link DataLayerOptions}, omitted to record nothing. */
export interface DataLayerAudit {
    /** Connection string for the trail's own pool. */
    connectionString: string;
    /** Where the trail goes. Omitted, the conventional table and columns. */
    config?: AuditConfig;
    /** Resolves the actor to record, or a falsy value to record none. */
    getPrincipal: () => unknown;
}

/** Everything {@link dataLayer} needs. */
export interface DataLayerOptions extends DeriveOptions {
    /** Resolves the id of the actor performing the current write. */
    getActorId: () => string | null;
    /** One resolver per access level named in `scope`. */
    resolvers?: Record<string, AccessScopeResolver>;
    /** Where to record writes. Omitted, nothing is recorded. */
    audit?: DataLayerAudit;
    /** Statement logging. Omitted, nothing is logged. */
    log?: QueryLogOptions;
}

/** What {@link dataLayer} hands back. */
export interface DataLayer {
    /** Pass straight to the `middleware` option of `postgres()`. */
    middleware: readonly SqlMiddleware[];
    /**
     * The config this was built from.
     *
     * @remarks
     * Exposed so a caller that also needs it — `repositoriesFor` wants the
     * relation map — reads it here rather than deriving the contract twice.
     */
    derived: DerivedDataLayer;
    /** Releases the audit pool. A no-op when nothing is recorded. */
    close(): Promise<void>;
}

/**
 * Build the whole data layer from an emitted contract, in one call.
 *
 * @remarks
 * The middlewares are returned already composed, which is the point: a caller
 * never orders them and so cannot order them wrongly. Under Prisma 7 this was
 * five `$extends` calls whose sequence every service repeated and any service
 * could get wrong, with a soft delete losing its `deletedBy` and nothing
 * reporting it. Here the two halves that were order-dependent are one
 * middleware, and what remains genuinely commutes.
 *
 * Reach for the individual factories only to compose something this does not
 * cover; for the ordinary case this is the entry point.
 *
 * @param options - The contract, what cannot be derived, and the resolvers.
 * @returns The middleware array and a teardown hook.
 * @throws When `scope` names a model the contract does not define.
 * @example
 * ```typescript
 * const layer = dataLayer({
 *     contract: contractJson,
 *     scope: { Portfolio: { portfolio: ['id'] } },
 *     resolvers: { portfolio: () => currentPortfolioIds() },
 *     getActorId: currentActorId,
 * });
 *
 * export const db = postgres<Contract>({
 *     contractJson,
 *     url: config.db.url,
 *     middleware: layer.middleware,
 * });
 * ```
 */
export function dataLayer(options: DataLayerOptions): DataLayer {
    const derived = deriveDataLayer(options);
    const recorded = options.audit
        ? audit({
              connectionString: options.audit.connectionString,
              ...(options.audit.config ? { config: options.audit.config } : {}),
              getPrincipal: options.audit.getPrincipal,
              stamps: derived.stamps,
              tables: derived.audit,
          })
        : undefined;

    return {
        derived,
        middleware: [
            // Logging outermost, so a line is written whatever the rewrites
            // below it did — and so a failure in one of them is still timed.
            ...(options.log ? [queryLog(options.log)] : []),
            // Innermost of the read-side rewrites: it converts what the
            // database returned, so it must not see values another hook has
            // already reshaped.
            isoDates({ columns: derived.dates }),
            ...(recorded ? [recorded] : []),
            stamp({ tables: derived.stamps, getActorId: options.getActorId }),
            accessScope({
                tables: derived.scope,
                resolvers: options.resolvers ?? {},
            }),
        ],
        close: (): Promise<void> => recorded?.close() ?? Promise.resolve(),
    };
}
