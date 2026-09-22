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

import { type Decorations, decorations } from './decorations.js';
import { type ImportMap, emitImports } from './imports.js';
import {
    type EmitContract,
    type EmitModelsOptions,
    type Model,
    hasDatabaseDefault,
    namespaceOf,
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

/** The classes every model's shapes lean on, emitted once per file. */
function shared(d: Decorations): string {
    return [
        `${d.classType()}export class PageOptions {\n` +
            member(d, 'number', 'skip', 'number') +
            '\n' +
            member(d, 'number', 'take', 'number') +
            '\n' +
            member(d, 'boolean', 'withTotal', 'boolean') +
            '}\n',
        `${d.classType()}export class BulkCount {\n` +
            member(d, 'number', 'count', 'number', false) +
            '}\n',
        `${d.classType()}export class CountOrderBy {\n` +
            member(d, "'asc' | 'desc'", '_count', "'asc' | 'desc'") +
            '}\n',
        `${d.classType()}export class ValueWhere {\n` +
            [
                member(d, 'unknown', 'eq', 'unknown'),
                member(d, 'unknown', 'not', 'unknown'),
                member(d, 'Array<unknown>', 'in', 'unknown[]'),
                member(d, 'Array<unknown>', 'notIn', 'unknown[]'),
                member(d, 'unknown', 'lt', 'unknown'),
                member(d, 'unknown', 'lte', 'unknown'),
                member(d, 'unknown', 'gt', 'unknown'),
                member(d, 'unknown', 'gte', 'unknown'),
                member(d, 'string', 'contains', 'string'),
                member(d, 'string', 'startsWith', 'string'),
                member(d, 'string', 'endsWith', 'string'),
            ].join('\n') +
            '}\n',
    ].join('\n');
}

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
    d: Decorations,
    wire: string,
    name: string,
    ts: string,
    optional = true,
): string {
    return (
        d.property(wire, optional) +
        `    ${name}${optional ? '?' : '!'}: ${ts};\n`
    );
}

function whereClass(
    d: Decorations,
    name: string,
    model: Model,
    fields: Record<string, { ts: string; wire: string }>,
): string {
    const logical = ['AND', 'OR', 'NOT']
        .map(key =>
            member(
                d,
                `${name}Where | Array<${name}Where>`,
                key,
                `${name}Where | ${name}Where[]`,
            ),
        )
        .join('\n');
    const scalars = Object.keys(model.fields ?? {})
        .map(field =>
            member(
                d,
                `${fields[field]?.wire} | ValueWhere`,
                field,
                `${fields[field]?.ts} | ValueWhere`,
            ),
        )
        .join('\n');
    const relations = Object.entries(model.relations ?? {})
        .map(([field, relation]) =>
            member(
                d,
                `${relation.to?.model}Where`,
                field,
                `${relation.to?.model}Where`,
            ),
        )
        .join('\n');

    return `${d.classType()}export class ${name}Where {\n${[
        logical,
        scalars,
        relations,
    ]
        .filter(Boolean)
        .join('\n')}}\n`;
}

function selectClass(d: Decorations, name: string, model: Model): string {
    const scalars = Object.keys(model.fields ?? {})
        .map(field => member(d, 'boolean', field, 'boolean'))
        .join('\n');
    const relations = Object.entries(model.relations ?? {})
        .map(([field, relation]) =>
            member(
                d,
                `boolean | ${relation.to?.model}Select`,
                field,
                `boolean | ${relation.to?.model}Select`,
            ),
        )
        .join('\n');

    return `${d.classType()}export class ${name}Select {\n${[scalars, relations]
        .filter(Boolean)
        .join('\n')}}\n`;
}

function orderByClass(d: Decorations, name: string, model: Model): string {
    const scalars = Object.keys(model.fields ?? {})
        .map(field => member(d, "'asc' | 'desc'", field, "'asc' | 'desc'"))
        .join('\n');
    const relations = Object.entries(model.relations ?? {})
        .map(([field, relation]) =>
            relation.cardinality?.endsWith(':N')
                ? member(d, 'CountOrderBy', field, 'CountOrderBy')
                : member(
                      d,
                      `${relation.to?.model}OrderBy`,
                      field,
                      `${relation.to?.model}OrderBy`,
                  ),
        )
        .join('\n');

    return `${d.classType()}export class ${name}OrderBy {\n${[
        scalars,
        relations,
    ]
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
function nestedClass(d: Decorations, child: string): string {
    return (
        `${d.classType()}export class ${child}CreateNestedMany {\n` +
        member(
            d,
            `Array<${child}CreateInput>`,
            'create',
            `${child}CreateInput[]`,
        ) +
        '}\n'
    );
}

function inputClass(
    d: Decorations,
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
                ? d.validate(
                      `${zodBase(fields[field]?.ts)}${rule}` +
                          `${required ? '' : '.optional()'}`,
                  )
                : '';

            return (
                zod +
                member(
                    d,
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
                          d,
                          `${relation.to?.model}CreateNestedMany`,
                          field,
                          `${relation.to?.model}CreateNestedMany`,
                      ),
                  )
                  .join('\n')
            : '';

    return (
        `${d.classType()}${d.validatable()}export class ${name}${kind}Input {\n` +
        `${[body, nested].filter(Boolean).join('\n')}}\n`
    );
}

function argClasses(d: Decorations, name: string): string {
    return [
        `${d.classType()}${d.validatable()}export class ${name}CreateArgs {\n` +
            d.validate(`${name}CreateInput`) +
            member(
                d,
                `${name}CreateInput`,
                'input',
                `${name}CreateInput`,
                false,
            ) +
            '\n' +
            member(d, `${name}Select`, 'select', `${name}Select`) +
            '}\n',
        `${d.classType()}${d.validatable()}export class ${name}UpdateArgs {\n` +
            d.validate(`${name}UpdateInput`) +
            member(
                d,
                `${name}UpdateInput`,
                'input',
                `${name}UpdateInput`,
                false,
            ) +
            '\n' +
            member(d, `${name}Select`, 'select', `${name}Select`) +
            '}\n',
        `${d.classType()}export class ${name}SingleArgs {\n` +
            member(d, `${name}Where`, 'where', `${name}Where`, false) +
            '\n' +
            member(d, `${name}Select`, 'select', `${name}Select`) +
            '}\n',
        `${d.classType()}export class ${name}ListArgs {\n` +
            member(d, `${name}Where`, 'where', `${name}Where`) +
            '\n' +
            member(d, `${name}Select`, 'select', `${name}Select`) +
            '\n' +
            member(d, `${name}OrderBy`, 'orderBy', `${name}OrderBy`) +
            '\n' +
            member(d, 'PageOptions', 'options', 'PageOptions') +
            '}\n',
        `${d.classType()}export class ${name}RemoveBulkArgs {\n` +
            member(d, `${name}Where`, 'where', `${name}Where`, false) +
            '}\n',
        `${d.classType()}export class ${name}Page {\n` +
            member(d, `Array<${name}>`, 'items', `${name}[]`, false) +
            '\n' +
            member(d, 'number', 'total', 'number | null') +
            '}\n',
    ].join('\n');
}

/**
 * Emit the RPC query, input and argument classes for a contract.
 *
 * @remarks
 * These are the shapes a caller sends over the queue, and for an @imqueue
 * service they have to be decorated classes rather than types:
 * `@classType`/`@property` are what the client generator reads, and an
 * undecorated type is dropped from the client with no error at generation
 * time. With `decorators: false` they are plain classes, for a service that
 * is not an @imqueue service; validation rules are then not emitted either.
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
    decorators = true,
}: EmitRpcOptions): string {
    const d = decorations(decorators);
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
            whereClass(d, name, model, fields),
            selectClass(d, name, model),
            orderByClass(d, name, model),
            inputClass(
                d,
                name,
                'Create',
                model,
                fields,
                validation[name] ?? {},
                supplied,
            ),
            inputClass(
                d,
                name,
                'Update',
                model,
                fields,
                validation[name] ?? {},
                supplied,
            ),
            argClasses(d, name),
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
        .map(child => nestedClass(d, child));

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
        `${shared(d)}\n${repositories}\n${nestedClasses.join('\n')}\n` +
        `${body.join('\n')}`;
    /* `JsonValue` is declared beside the classes, so this file takes it from
       there rather than restating a type two files would then have to agree
       on. Named only where something uses it, like every other import here. */
    const named = [
        ...Object.keys(models),
        ...(emitted.includes('JsonValue') ? ['JsonValue'] : []),
    ].sort();

    return (
        `${emitImports(
            d.enabled
                ? ['rpc', 'validation', 'zod', 'repository']
                : ['repository'],
            imports,
        )}` +
        `import type {\n${named
            .map(name => `    ${name},`)
            .join('\n')}\n} from './models.js';\n\n` +
        emitted
    );
}
