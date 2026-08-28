/*!
 * @imqueue/pg-prisma — Prisma/Postgres toolkit for @imqueue services
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

import { type ImportMap, emitImports } from './imports.js';

/** How a Postgres codec is spelled in TypeScript. */
const TS_TYPE: Record<string, string> = {
    'pg/bool@1': 'boolean',
    'pg/bytea@1': 'string',
    'pg/date-string@1': 'string',
    'pg/float4@1': 'number',
    'pg/float8@1': 'number',
    'pg/int2@1': 'number',
    'pg/int4@1': 'number',
    'pg/int8@1': 'string',
    'pg/json@1': 'Record<string, unknown>',
    'pg/jsonb@1': 'Record<string, unknown>',
    'pg/numeric@1': 'string',
    'pg/text@1': 'string',
    'pg/timestamp-string@1': 'string',
    'pg/timestamptz-string@1': 'string',
    'pg/uuid@1': 'string',
};

interface FieldType {
    readonly codecId?: string;
    /** A native enum names its type here rather than through a value set. */
    readonly typeParams?: { readonly typeName?: string };
}

export interface Field {
    readonly nullable?: boolean;
    readonly many?: boolean;
    readonly type?: FieldType;
    readonly valueSet?: { readonly entityName?: string };
}

export interface Relation {
    readonly cardinality?: string;
    readonly to?: { readonly model?: string };
    readonly on?: {
        readonly localFields?: readonly string[];
        readonly targetFields?: readonly string[];
    };
}

export interface Model {
    readonly fields?: Record<string, Field>;
    readonly relations?: Record<string, Relation>;
    readonly storage?: {
        readonly table?: string;
        readonly fields?: Record<string, { readonly column?: string }>;
    };
}

/** Member names per enum, where the label is not the name. */
export type EnumNames = Readonly<
    Record<string, Readonly<Record<string, string>>>
>;

export interface EnumDef {
    readonly members?: readonly { readonly value?: string }[];
}

/** The slice of an emitted `contract.json` the emitter reads. */
export interface EmitContract {
    readonly domain?: {
        readonly namespaces?: Record<
            string,
            {
                readonly enum?: Record<string, EnumDef>;
                readonly models?: Record<string, Model>;
            }
        >;
    };
    readonly storage?: {
        readonly namespaces?: Record<
            string,
            {
                readonly entries?: {
                    readonly native_enum?: Record<
                        string,
                        { readonly members?: readonly string[] }
                    >;
                    readonly table?: Record<
                        string,
                        {
                            readonly columns?: Record<
                                string,
                                {
                                    readonly valueSet?: {
                                        readonly entityName?: string;
                                    };
                                    readonly default?: unknown;
                                }
                            >;
                        }
                    >;
                };
            }
        >;
    };
}

/** Everything {@link emitModels} needs. */
export interface EmitModelsOptions {
    /** The emitted contract, read from `contract.json`. */
    contract: EmitContract;
    /** Namespace to emit. Defaults to the only one, or `public`. */
    namespace?: string;
    /**
     * Where the generated file imports its runtime from.
     *
     * @remarks
     * Redirect `@imqueue/rpc` and the rest at one package that re-exports them
     * and every service takes a single copy of each — which is what the
     * decorators require. See `parseImportMap`.
     */
    imports?: ImportMap;
    /**
     * Names for enum members whose database label is not the name.
     *
     * @remarks
     * `{ AttributeType: { STRING: 'string' } }` emits `STRING: 'string'`
     * rather than `string: 'string'`. Prisma 7 spelled this `STRING
     * @map("string")` in the schema; the contract records the labels alone,
     * so the names are declared by the service and passed in. A member with
     * no name here keeps its label, which is the usual case.
     */
    enums?: EnumNames;
    /**
     * Fields kept off the generated surface, as `Model.field`.
     *
     * @remarks
     * The column stays in the contract and in the database — this is about
     * what crosses the RPC boundary. A raw upstream payload is stored because
     * a failure has to be explainable, and published to nobody.
     */
    omit?: readonly string[];
}

/**
 * Quote a `@property` type string.
 *
 * @remarks
 * An enum renders as a union of single-quoted members, so the surrounding
 * quote has to be the other one or the decorator argument does not parse.
 */
export function quoted(value: string): string {
    return value.includes("'") ? `"${value}"` : `'${value}'`;
}

/** The TypeScript spelling of a field, and the `@property` type string. */
export function typeOf(
    field: Field,
    enums: Record<string, EnumDef>,
    listEnum?: string,
): { ts: string; wire: string } {
    // Three spellings, because the contract has three. A PSL enum names its
    // value set on the field; a native `pg.enum(...)` names its type in the
    // codec's parameters; and a list of either names it only on the storage
    // column. Reading one leaves the others as bare strings.
    const named =
        field.valueSet?.entityName ??
        field.type?.typeParams?.typeName ??
        listEnum;
    const members = named ? enums[named]?.members : undefined;
    const base = members
        ? members.map(member => `'${member.value}'`).join(' | ')
        : (TS_TYPE[field.type?.codecId ?? ''] ?? 'unknown');
    // `'A' | 'B'[]` parses as `'A' | ('B'[])`; a union has to be parenthesised
    // before the array suffix.
    const listed = field.many
        ? `${base.includes('|') ? `(${base})` : base}[]`
        : base;
    const wire = field.many ? `Array<${base}>` : base;

    return {
        ts: field.nullable ? `${listed} | null` : listed,
        wire,
    };
}

/**
 * Emit the `@imqueue/rpc` model classes for a contract.
 *
 * @remarks
 * Prisma Next emits `contract.d.ts`, which carries the types but not the
 * decorated classes: `@classType`/`@property` are what the RPC client
 * generator reads, and a type alone is dropped from the generated client with
 * no error. So this is emitted here rather than by Prisma, out of the same
 * contract.
 *
 * Every property is optional and nullable-aware, because a DTO crossing the
 * queue carries whatever the caller selected rather than the whole row.
 *
 * @param options - The contract, the namespace and any import redirection.
 * @returns The file content.
 * @example
 * ```typescript
 * await writeFile(
 *     'src/generated/models.ts',
 *     emitModels({ contract, imports: parseImportMap(spec) }),
 * );
 * ```
 */
/** The models, enums and storage columns of one namespace. */
/** Storage columns per physical table. */
export type StorageTables = Record<
    string,
    {
        columns?: Record<
            string,
            { valueSet?: { entityName?: string }; default?: unknown }
        >;
    }
>;

/**
 * Whether the database fills a column in when an insert leaves it out.
 *
 * @remarks
 * A non-nullable column with a default is optional on a create, and demanding
 * it is what made `createdAt` a required input. The lookup goes through the
 * model's own storage mapping rather than assuming the table is named after
 * the model.
 */
export function hasDatabaseDefault(
    models: Record<string, Model>,
    columnsOf: StorageTables,
): (model: string, field: string) => boolean {
    return (model: string, field: string): boolean => {
        const storage = models[model]?.storage;
        const table = storage?.table ?? model;
        const column = storage?.fields?.[field]?.column ?? field;

        return columnsOf[table]?.columns?.[column]?.default !== undefined;
    };
}

export function namespaceOf(
    contract: EmitContract,
    namespace?: string,
    omit: readonly string[] = [],
): {
    models: Record<string, Model>;
    enums: Record<string, EnumDef>;
    columnsOf: StorageTables;
} {
    const namespaces = contract.domain?.namespaces ?? {};
    const chosen =
        namespace ??
        (Object.keys(namespaces).length === 1
            ? (Object.keys(namespaces)[0] as string)
            : 'public');

    const entries = contract.storage?.namespaces?.[chosen]?.entries;
    // A PSL `enum` block lands in the domain plane; a native Postgres enum
    // (`pg.enum(...)`, which `contract infer` produces) lands in the storage
    // plane instead. Reading only one leaves every native enum as a bare
    // string.
    const native = Object.fromEntries(
        Object.entries(entries?.native_enum ?? {}).map(([name, definition]) => [
            name,
            { members: (definition.members ?? []).map(value => ({ value })) },
        ]),
    );

    // Dropped here rather than in each emitter, so a field kept off the wire
    // is off every part of it — the model class, the select, the filter and
    // the create input alike.
    const hidden = new Set(omit);
    const models = Object.fromEntries(
        Object.entries(namespaces[chosen]?.models ?? {}).map(
            ([name, model]) => [
                name,
                {
                    ...model,
                    fields: Object.fromEntries(
                        Object.entries(model.fields ?? {}).filter(
                            ([field]) => !hidden.has(`${name}.${field}`),
                        ),
                    ),
                },
            ],
        ),
    );

    return {
        models,
        enums: { ...native, ...namespaces[chosen]?.enum },
        columnsOf: entries?.table ?? {},
    };
}

export function emitModels({
    contract,
    namespace,
    imports = {},
    omit = [],
}: EmitModelsOptions): string {
    const { models, enums, columnsOf } = namespaceOf(contract, namespace, omit);

    const classes = Object.entries(models).map(([name, model]) => {
        const columns = columnsOf[name]?.columns ?? {};
        const fields = Object.entries(model.fields ?? {}).map(
            ([field, definition]) => {
                const { ts, wire } = typeOf(
                    definition,
                    enums,
                    columns[field]?.valueSet?.entityName,
                );

                return (
                    `    @property(${quoted(wire)}, true)\n` +
                    `    ${field}?: ${ts};\n`
                );
            },
        );
        const relations = Object.entries(model.relations ?? {}).map(
            ([field, relation]) => {
                const target = relation.to?.model ?? 'unknown';
                const many = relation.cardinality?.endsWith(':N') ?? false;
                const wire = many ? `Array<${target}>` : target;
                const ts = many ? `${target}[]` : `${target} | null`;

                return `    @property('${wire}', true)\n    ${field}?: ${ts};\n`;
            },
        );

        return (
            `@classType()\nexport class ${name} {\n` +
            [...fields, ...relations].join('\n') +
            '}\n'
        );
    });

    return `${emitImports(['rpc'], imports)}\n${classes.join('\n')}`;
}

/**
 * Emit the enum constants for a contract.
 *
 * @remarks
 * Prisma 7 exposed each enum as an `as const` object on the generated client,
 * and `conventions.md`'s no-bare-strings rule leans on it: a member is written
 * as `CredentialType.PASSWORD`, never as `'PASSWORD'`. Prisma Next carries the
 * members in the contract but publishes no such object, so it is emitted here
 * — otherwise every call site that named a member would have to restate the
 * literal, which is the drift that rule exists to prevent.
 *
 * @param options - The contract and the namespace to emit.
 * @returns The file content.
 */
export function emitEnums({
    contract,
    namespace,
    enums: names = {},
}: Omit<EmitModelsOptions, 'imports'>): string {
    const { models: modelMap, enums } = namespaceOf(contract, namespace);
    const models = Object.keys(modelMap);

    // `ModelName` is what a call site names a model by. Prisma 7 published it
    // on the client; without it every such site would write the model as a
    // bare literal, which is the drift the no-bare-strings rule prevents.
    const modelName =
        `export const ModelName = {\n${models
            .map(name => `    ${name}: '${name}',`)
            .join('\n')}\n} as const;\n\n` +
        'export type ModelName = (typeof ModelName)[keyof typeof ModelName];\n';

    return [
        modelName,
        ...Object.entries(enums).map(([name, definition]) => {
            const named = Object.entries(names[name] ?? {});
            const nameOf = (label: string): string =>
                named.find(([, value]) => value === label)?.[0] ?? label;
            const members = (definition.members ?? [])
                .map(
                    member =>
                        `    ${nameOf(member.value ?? '')}: '${member.value}',`,
                )
                .join('\n');

            return (
                `export const ${name} = {\n${members}\n} as const;\n\n` +
                `export type ${name} = (typeof ${name})[keyof typeof ${name}];\n`
            );
        }),
    ].join('\n');
}
