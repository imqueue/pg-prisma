/*!
 * Prisma Next (8.x) data-layer config derived from the emitted contract
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

import { TIMESTAMP_CODECS } from './iso-dates.js';

/** The slice of an emitted `contract.json` this derivation reads. */
export interface ContractJson {
    readonly domain?: {
        readonly namespaces?: Record<
            string,
            {
                readonly models?: Record<
                    string,
                    {
                        readonly fields?: Record<string, unknown>;
                        readonly relations?: Record<
                            string,
                            {
                                readonly cardinality?: string;
                                readonly to?: { readonly model?: string };
                                readonly on?: {
                                    readonly localFields?: readonly string[];
                                    readonly targetFields?: readonly string[];
                                };
                            }
                        >;
                        readonly storage?: {
                            readonly table?: string;
                            readonly fields?: Record<
                                string,
                                { readonly column?: string }
                            >;
                        };
                    }
                >;
            }
        >;
    };
}

/** One relation, as the query translator needs it. */
export interface RelationInfo {
    /** The model on the other end. */
    target: string;
    /** Whether the other end is many. */
    isList: boolean;
    /** Fields on this side the relation joins on. */
    localFields: string[];
    /** Fields on the other side they join to. */
    targetFields: string[];
}

/** Relations per model, by field name. */
export type RelationMap = Record<string, Record<string, RelationInfo>>;

/** Columns a model is stamped with, by physical column name. */
export interface StampColumns {
    /** Column marking the row deleted, when the model is soft-deleted. */
    deletedAt?: string;
    /** Column stamped with the time of every write. */
    updatedAt?: string;
    /**
     * Codec the timestamp columns are stored under.
     *
     * @remarks
     * Read from the contract rather than assumed: a table may be `timestamp`
     * or `timestamptz`, and binding a value under the wrong one is rejected by
     * the driver.
     */
    timestampCodec?: string;
    /** Column stamped once, when the row is created. */
    createdBy?: string;
    /** Column stamped on create and on every update. */
    updatedBy?: string;
    /** Column stamped when a delete is rewritten into a stamp. */
    deletedBy?: string;
}

/** Stamp columns per physical table. */
export type StampTables = Record<string, StampColumns>;

/**
 * Scope columns per physical table, per access level.
 *
 * @remarks
 * A row is in scope for a level when ANY of that level's columns matches (OR);
 * a row is in scope when EVERY active level matches (AND).
 */
export type ScopeTables = Record<string, Record<string, string[]>>;

/** Field names to look for, where they are not the defaults. */
export interface DeriveFields {
    /** Field marking a row soft-deleted. Default `deletedAt`. */
    deletedAt?: string;
    /** Field holding the time of the last write. Default `updatedAt`. */
    updatedAt?: string;
    /** Field holding the creating actor. Default `createdBy`. */
    createdBy?: string;
    /** Field holding the last updating actor. Default `updatedBy`. */
    updatedBy?: string;
    /** Field holding the deleting actor. Default `deletedBy`. */
    deletedBy?: string;
}

/** Everything {@link deriveDataLayer} needs. */
export interface DeriveOptions {
    /** The emitted contract, imported from `contract.json`. */
    contract: ContractJson;
    /** Field names, where they differ from the defaults. */
    fields?: DeriveFields;
    /**
     * Access levels and the fields each is scoped by, keyed by MODEL name.
     *
     * @remarks
     * Declared here rather than in the schema because Prisma Next has no
     * schema-level annotation to carry it — the `/// @scope(...)` doc comment
     * the Prisma 7 generator read does not survive into the contract. A model
     * named here that the contract does not define is a throw rather than a
     * silent no-op: a typo would otherwise leave that model unscoped, which is
     * the failure direction that leaks rows.
     */
    scope?: Record<string, Record<string, string[]>>;
    /** Models to leave out of the audit trail, by MODEL name. */
    auditExclude?: readonly string[];
}

/** The config the middlewares consume, keyed by physical table. */
export interface DerivedDataLayer {
    /** Soft-delete and authorship columns per table. */
    stamps: StampTables;
    /** Tables whose writes are recorded, and the model name to record. */
    audit: Record<string, string>;
    /** Scope columns per table per level. */
    scope: ScopeTables;
    /**
     * Columns stored under a timestamp codec, by column name.
     *
     * @remarks
     * By name rather than by table: a row carrying included relations holds
     * columns from several tables at once, and the conversion is driven by
     * what a value is, not by where the statement started.
     */
    dates: Set<string>;
    /**
     * Relations per MODEL, for the query translator.
     *
     * @remarks
     * Keyed by model rather than table, because the query surface a caller
     * sends over the wire names models and fields — the physical table only
     * matters below it.
     */
    relations: RelationMap;
}

const DEFAULTS = {
    deletedAt: 'deletedAt',
    updatedAt: 'updatedAt',
    createdBy: 'createdBy',
    updatedBy: 'updatedBy',
    deletedBy: 'deletedBy',
} as const;

interface Entry {
    model: string;
    table: string;
    fields: Record<string, unknown>;
    codecOf: (field: string) => string | undefined;
    relations: Record<string, RelationInfo>;
    column: (field: string) => string;
}

function entriesOf(contract: ContractJson): Entry[] {
    return Object.values(contract.domain?.namespaces ?? {}).flatMap(namespace =>
        Object.entries(namespace.models ?? {}).map(([model, definition]) => ({
            model,
            table: definition.storage?.table ?? model,
            fields: definition.fields ?? {},
            codecOf: (field: string): string | undefined =>
                (
                    definition.fields?.[field] as
                        | { type?: { codecId?: string } }
                        | undefined
                )?.type?.codecId,
            relations: Object.fromEntries(
                Object.entries(definition.relations ?? {}).map(
                    ([field, relation]) => [
                        field,
                        {
                            target: relation.to?.model ?? field,
                            isList:
                                relation.cardinality?.endsWith(':N') ?? false,
                            localFields: [...(relation.on?.localFields ?? [])],
                            targetFields: [
                                ...(relation.on?.targetFields ?? []),
                            ],
                        },
                    ],
                ),
            ),
            column: (field: string): string =>
                definition.storage?.fields?.[field]?.column ?? field,
        })),
    );
}

/**
 * Derive the data-layer config from an emitted contract.
 *
 * @remarks
 * This replaces the Prisma 7 generator that wrote `SOFT_DELETE_MODELS`,
 * `AUTHORSHIP_MODELS` and the rest into `src/generated`. Prisma Next has no
 * custom-generator protocol and does not need one: the contract already names
 * every model, field and physical column, so the same config is a lookup
 * rather than a build step, and nothing can go stale against the schema.
 *
 * Membership is by convention, which is what `softDelete = "auto"` and
 * `authorship = "auto"` meant. Everything is keyed by **physical table**,
 * because that is what a statement names — resolving a table back to a model
 * at query time would have to go through the contract's `roots`, which is
 * keyed by bare table name only while that name is unique across namespaces.
 *
 * @param options - The contract and the declarations that cannot be inferred.
 * @returns Config for {@link dataLayer} and the individual middlewares.
 * @throws When `scope` names a model the contract does not define.
 * @example
 * ```typescript
 * const layer = deriveDataLayer({
 *     contract: contractJson,
 *     scope: { Portfolio: { portfolio: ['id'] } },
 * });
 * ```
 */
export function deriveDataLayer({
    contract,
    fields,
    scope = {},
    auditExclude = [],
}: DeriveOptions): DerivedDataLayer {
    const names = { ...DEFAULTS, ...fields };
    const entries = entriesOf(contract);
    const byModel = new Map(entries.map(entry => [entry.model, entry]));
    const excluded = new Set(auditExclude);

    const unknown = Object.keys(scope).filter(model => !byModel.has(model));
    if (unknown.length > 0) {
        throw new Error(
            `deriveDataLayer: scope names ${unknown.join(', ')}, which the ` +
                'contract does not define',
        );
    }

    const stamped = (entry: Entry): StampColumns => {
        const codec = entry.codecOf(names.updatedAt);

        return {
            ...(entry.fields[names.deletedAt]
                ? { deletedAt: entry.column(names.deletedAt) }
                : {}),
            ...(entry.fields[names.updatedAt]
                ? { updatedAt: entry.column(names.updatedAt) }
                : {}),
            ...(entry.fields[names.updatedAt] && codec
                ? { timestampCodec: codec }
                : {}),
            ...(entry.fields[names.createdBy]
                ? { createdBy: entry.column(names.createdBy) }
                : {}),
            ...(entry.fields[names.updatedBy]
                ? { updatedBy: entry.column(names.updatedBy) }
                : {}),
            ...(entry.fields[names.deletedBy]
                ? { deletedBy: entry.column(names.deletedBy) }
                : {}),
        };
    };

    return {
        dates: new Set(
            entries.flatMap(entry =>
                Object.keys(entry.fields)
                    .filter(field =>
                        TIMESTAMP_CODECS.has(entry.codecOf(field) ?? ''),
                    )
                    .map(field => entry.column(field)),
            ),
        ),
        stamps: Object.fromEntries(
            entries
                .map(entry => [entry.table, stamped(entry)] as const)
                .filter(([, columns]) => Object.keys(columns).length > 0),
        ),
        audit: Object.fromEntries(
            entries
                .filter(entry => !excluded.has(entry.model))
                .map(entry => [entry.table, entry.model]),
        ),
        scope: Object.fromEntries(
            Object.entries(scope).map(([model, levels]) => [
                byModel.get(model)?.table ?? model,
                Object.fromEntries(
                    Object.entries(levels).map(([level, columns]) => [
                        level,
                        columns.map(
                            field => byModel.get(model)?.column(field) ?? field,
                        ),
                    ]),
                ),
            ]),
        ),
        relations: Object.fromEntries(
            entries
                .filter(entry => Object.keys(entry.relations).length > 0)
                .map(entry => [entry.model, entry.relations]),
        ),
    };
}
