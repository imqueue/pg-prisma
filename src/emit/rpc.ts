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
import {
    type EmitContract,
    type EmitModelsOptions,
    type Model,
    hasDatabaseDefault,
    namespaceOf,
    quoted,
    typeOf,
} from './models.js';
import { type DeriveFields, deriveDataLayer } from '../derive.js';

/** Zod suffixes per model per field, as the schema's `@validate` declared. */
export type ValidationRules = Record<string, Record<string, string>>;

/** Everything {@link emitRpcTypes} needs. */
export interface EmitRpcOptions extends Omit<EmitModelsOptions, 'imports'> {
    /**
     * Validation rules per model per field, as Zod suffixes.
     *
     * @remarks
     * Prisma Next's contract does not carry them — the `/// @validate` doc
     * comment the Prisma 7 generator read has no equivalent — so the rules are
     * declared by the service and passed in. Omitted, the inputs are emitted
     * with no `@validate` at all, which validates nothing: an argument class
     * carrying `@validatable()` and no rules passes everything.
     */
    validation?: ValidationRules;
    /** Where the generated file imports its runtime from. */
    imports?: ImportMap;
    /**
     * Stamp field names, where a service overrides the defaults.
     *
     * @remarks
     * The same value `dataLayer` is given. A stamped column is filled in below
     * the caller, so demanding it on a create would ask for something the
     * caller cannot know.
     */
    fields?: DeriveFields;
}

const SHARED = `@classType()
export class PageOptions {
    @property('number', true)
    skip?: number;

    @property('number', true)
    take?: number;

    @property('boolean', true)
    withTotal?: boolean;
}

@classType()
export class BulkCount {
    @property('number')
    count!: number;
}

@classType()
export class CountOrderBy {
    @property("'asc' | 'desc'", true)
    _count?: 'asc' | 'desc';
}

@classType()
export class ValueWhere {
    @property('unknown', true)
    eq?: unknown;

    @property('unknown', true)
    not?: unknown;

    @property('Array<unknown>', true)
    in?: unknown[];

    @property('Array<unknown>', true)
    notIn?: unknown[];

    @property('unknown', true)
    lt?: unknown;

    @property('unknown', true)
    lte?: unknown;

    @property('unknown', true)
    gt?: unknown;

    @property('unknown', true)
    gte?: unknown;

    @property('string', true)
    contains?: string;

    @property('string', true)
    startsWith?: string;

    @property('string', true)
    endsWith?: string;
}
`;

/** `@property(...)` plus the field line, at one indent. */
/**
 * The Zod type a rule is appended to.
 *
 * @remarks
 * A rule says what is allowed about a value, not what the value is — the
 * field's own type says that. `.int().min(1)` on `z.string()` is not a
 * narrower string, it is a type error, and it is what a `String` base gives
 * every validated number in the contract.
 *
 * @param ts - The field's TypeScript type.
 * @returns The Zod constructor, as source.
 */
function zodBase(ts: string | undefined): string {
    if (ts?.startsWith('number')) {
        return 'z.number()';
    }

    if (ts?.startsWith('boolean')) {
        return 'z.boolean()';
    }

    return 'z.string()';
}

function member(
    wire: string,
    name: string,
    ts: string,
    optional = true,
): string {
    return (
        `    @property(${quoted(wire)}${optional ? ', true' : ''})\n` +
        `    ${name}${optional ? '?' : '!'}: ${ts};\n`
    );
}

function whereClass(
    name: string,
    model: Model,
    fields: Record<string, { ts: string; wire: string }>,
): string {
    const logical = ['AND', 'OR', 'NOT']
        .map(key =>
            member(
                `${name}Where | Array<${name}Where>`,
                key,
                `${name}Where | ${name}Where[]`,
            ),
        )
        .join('\n');
    const scalars = Object.keys(model.fields ?? {})
        .map(field =>
            member(
                `${fields[field]?.wire} | ValueWhere`,
                field,
                `${fields[field]?.ts} | ValueWhere`,
            ),
        )
        .join('\n');
    const relations = Object.entries(model.relations ?? {})
        .map(([field, relation]) =>
            member(
                `${relation.to?.model}Where`,
                field,
                `${relation.to?.model}Where`,
            ),
        )
        .join('\n');

    return `@classType()\nexport class ${name}Where {\n${[
        logical,
        scalars,
        relations,
    ]
        .filter(Boolean)
        .join('\n')}}\n`;
}

function selectClass(name: string, model: Model): string {
    const scalars = Object.keys(model.fields ?? {})
        .map(field => member('boolean', field, 'boolean'))
        .join('\n');
    const relations = Object.entries(model.relations ?? {})
        .map(([field, relation]) =>
            member(
                `boolean | ${relation.to?.model}Select`,
                field,
                `boolean | ${relation.to?.model}Select`,
            ),
        )
        .join('\n');

    return `@classType()\nexport class ${name}Select {\n${[scalars, relations]
        .filter(Boolean)
        .join('\n')}}\n`;
}

function orderByClass(name: string, model: Model): string {
    const scalars = Object.keys(model.fields ?? {})
        .map(field => member("'asc' | 'desc'", field, "'asc' | 'desc'"))
        .join('\n');
    const relations = Object.entries(model.relations ?? {})
        .map(([field, relation]) =>
            relation.cardinality?.endsWith(':N')
                ? member('CountOrderBy', field, 'CountOrderBy')
                : member(
                      `${relation.to?.model}OrderBy`,
                      field,
                      `${relation.to?.model}OrderBy`,
                  ),
        )
        .join('\n');

    return `@classType()\nexport class ${name}OrderBy {\n${[scalars, relations]
        .filter(Boolean)
        .join('\n')}}\n`;
}

/**
 * The rows a create may carry against a to-many relation.
 *
 * @remarks
 * Emitted once per child model rather than per relation, because the shape
 * depends only on what is being inserted. `create` is the only form: Prisma
 * Next has no nested writes at all, so the repository performs these as
 * separate inserts in one transaction, and connecting an existing row is a
 * plain foreign-key update instead.
 */
function nestedClass(child: string): string {
    return (
        `@classType()\nexport class ${child}CreateNestedMany {\n` +
        member(
            `Array<${child}CreateInput>`,
            'create',
            `${child}CreateInput[]`,
        ) +
        '}\n'
    );
}

function inputClass(
    name: string,
    kind: 'Create' | 'Update',
    model: Model,
    fields: Record<string, { ts: string; wire: string }>,
    rules: Record<string, string>,
    supplied: (model: string, field: string) => boolean,
): string {
    const body = Object.entries(model.fields ?? {})
        .map(([field, definition]) => {
            // An update names the row it changes, so `id` is the one required
            // field there and optional on a create, where the database makes it.
            const required =
                kind === 'Update'
                    ? field === 'id'
                    : !definition.nullable &&
                      field !== 'id' &&
                      !supplied(name, field);
            const rule = rules[field];
            const zod = rule
                ? `    @validate(${zodBase(fields[field]?.ts)}${rule}` +
                  `${required ? '' : '.optional()'})\n`
                : '';

            return (
                zod +
                member(
                    fields[field]?.wire ?? 'unknown',
                    field,
                    fields[field]?.ts ?? 'unknown',
                    !required,
                )
            );
        })
        .join('\n');

    const nested =
        kind === 'Create'
            ? Object.entries(model.relations ?? {})
                  .filter(([, relation]) =>
                      relation.cardinality?.endsWith(':N'),
                  )
                  .map(([field, relation]) =>
                      member(
                          `${relation.to?.model}CreateNestedMany`,
                          field,
                          `${relation.to?.model}CreateNestedMany`,
                      ),
                  )
                  .join('\n')
            : '';

    return (
        `@classType()\n@validatable()\nexport class ${name}${kind}Input {\n` +
        `${[body, nested].filter(Boolean).join('\n')}}\n`
    );
}

function argClasses(name: string): string {
    return [
        `@classType()\n@validatable()\nexport class ${name}CreateArgs {\n` +
            `    @validate(${name}CreateInput)\n` +
            member(`${name}CreateInput`, 'input', `${name}CreateInput`, false) +
            '\n' +
            member(`${name}Select`, 'select', `${name}Select`) +
            '}\n',
        `@classType()\n@validatable()\nexport class ${name}UpdateArgs {\n` +
            `    @validate(${name}UpdateInput)\n` +
            member(`${name}UpdateInput`, 'input', `${name}UpdateInput`, false) +
            '\n' +
            member(`${name}Select`, 'select', `${name}Select`) +
            '}\n',
        `@classType()\nexport class ${name}SingleArgs {\n` +
            member(`${name}Where`, 'where', `${name}Where`, false) +
            '\n' +
            member(`${name}Select`, 'select', `${name}Select`) +
            '}\n',
        `@classType()\nexport class ${name}ListArgs {\n` +
            member(`${name}Where`, 'where', `${name}Where`) +
            '\n' +
            member(`${name}Select`, 'select', `${name}Select`) +
            '\n' +
            member(`${name}OrderBy`, 'orderBy', `${name}OrderBy`) +
            '\n' +
            member('PageOptions', 'options', 'PageOptions') +
            '}\n',
        `@classType()\nexport class ${name}RemoveBulkArgs {\n` +
            member(`${name}Where`, 'where', `${name}Where`, false) +
            '}\n',
        `@classType()\nexport class ${name}Page {\n` +
            member(`Array<${name}>`, 'items', `${name}[]`, false) +
            '\n' +
            member('number', 'total', 'number | null') +
            '}\n',
    ].join('\n');
}

/**
 * Emit the RPC query, input and argument classes for a contract.
 *
 * @remarks
 * These are the shapes a caller sends over the queue, and they have to be
 * decorated classes rather than types: `@classType`/`@property` are what the
 * client generator reads, and an undecorated type is dropped from the client
 * with no error at generation time.
 *
 * Validation is the one thing not derivable from the contract — see
 * `validation`.
 *
 * @param options - The contract, the validation rules and any redirection.
 * @returns The file content.
 */
export function emitRpcTypes({
    contract,
    namespace,
    validation = {},
    imports = {},
    fields: stampFields = {},
    omit = [],
}: EmitRpcOptions): string {
    const { models, enums, columnsOf } = namespaceOf(
        contract as EmitContract,
        namespace,
        omit,
    );
    const defaulted = hasDatabaseDefault(models, columnsOf);
    const { stamps } = deriveDataLayer({ contract, fields: stampFields });

    // A foreign key may arrive with the row or come from the parent of a
    // nested create, so it is optional either way — which is what lets one
    // input type serve both, as it did under Prisma 7.
    const foreignKeys = (model: string): Set<string> =>
        new Set(
            Object.values(models[model]?.relations ?? {})
                .filter(relation => relation.cardinality?.endsWith(':1'))
                .flatMap(relation => [...(relation.on?.localFields ?? [])]),
        );

    // A create need not carry what something below it writes: a column the
    // database defaults, or one the stamp middleware fills in.
    const supplied = (model: string, field: string): boolean => {
        const storage = models[model]?.storage;
        const column = storage?.fields?.[field]?.column ?? field;
        const stamped = stamps[storage?.table ?? model] ?? {};

        return (
            defaulted(model, field) ||
            foreignKeys(model).has(field) ||
            column === stamped.updatedAt ||
            column === stamped.updatedBy ||
            column === stamped.createdBy
        );
    };

    const body = Object.entries(models).map(([name, model]) => {
        const columns = columnsOf[model.storage?.table ?? name]?.columns ?? {};
        const fields = Object.fromEntries(
            Object.entries(model.fields ?? {}).map(([field, definition]) => [
                field,
                typeOf(definition, enums, columns[field]?.valueSet?.entityName),
            ]),
        );

        return [
            whereClass(name, model, fields),
            selectClass(name, model),
            orderByClass(name, model),
            inputClass(
                name,
                'Create',
                model,
                fields,
                validation[name] ?? {},
                supplied,
            ),
            inputClass(
                name,
                'Update',
                model,
                fields,
                validation[name] ?? {},
                supplied,
            ),
            argClasses(name),
        ].join('\n');
    });

    const nestedClasses = [
        ...new Set(
            Object.values(models).flatMap(model =>
                Object.values(model.relations ?? {})
                    .filter(relation => relation.cardinality?.endsWith(':N'))
                    .map(relation => relation.to?.model as string),
            ),
        ),
    ]
        .sort()
        .map(nestedClass);

    const repositories =
        "/** Every model's repository, so an access is total rather than " +
        'possibly undefined. */\nexport interface Repositories {\n' +
        Object.keys(models)
            .map(
                name =>
                    `    ${name.charAt(0).toLowerCase()}${name.slice(1)}: ` +
                    `Repository<${name}>;`,
            )
            .join('\n') +
        '\n}\n';

    const emitted =
        `${SHARED}\n${repositories}\n${nestedClasses.join('\n')}\n` +
        `${body.join('\n')}`;
    /* `JsonValue` is declared beside the classes, so this file takes it from
       there rather than restating a type two files would then have to agree
       on. Named only where something uses it, like every other import here. */
    const named = [
        ...Object.keys(models),
        ...(emitted.includes('JsonValue') ? ['JsonValue'] : []),
    ].sort();

    return (
        `${emitImports(['rpc', 'validation', 'zod', 'repository'], imports)}` +
        `import type {\n${named
            .map(name => `    ${name},`)
            .join('\n')}\n} from './models.js';\n\n` +
        emitted
    );
}
