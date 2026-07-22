/*!
 * Prisma generator: @imqueue/rpc models & repositories
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

import type { DMMF, GeneratorOptions } from '@prisma/generator-helper';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Model = DMMF.Model;
type Field = DMMF.Field;
type Used = { enums: Set<string> };
type Hidden = (model: Model, field: Field) => boolean;
type TypePair = { rpc: string; ts: string };

interface SoftDeleteConfig {
    deletedAt: string;
}
interface AuthorshipConfig {
    createdBy: string;
    updatedBy: string;
    deletedBy: string;
    /** The soft-delete column whose being-set triggers `deletedBy` (if any). */
    deletedAt?: string;
}
const AUDIT_FIELDS = [
    'principal',
    'action',
    'model',
    'recordId',
    'changes',
    'createdAt',
] as const;
type AuditField = (typeof AUDIT_FIELDS)[number];
interface AuditConfig {
    models: string[];
    table: string;
    columns: Record<AuditField, string>;
}
type AssertColumn = (model: string, column: string, key: string) => void;
type AssertKnown = (key: string, names: Iterable<string>) => void;

/** Whether `name` is a declared model. */
const isModel = (models: readonly Model[], name: string): boolean =>
    models.some(m => m.name === name);

/**
 * Parse the `softDelete` directive list into `model → { deletedAt column }`.
 * `auto` = every model with a `deletedAt` column; `Model` = default column;
 * `Model.col` = custom column; `-Model` = exclude.
 */
function parseSoftDelete(
    directives: string[],
    models: readonly Model[],
    assertColumn: AssertColumn,
): Record<string, SoftDeleteConfig> {
    const result: Record<string, SoftDeleteConfig> = {};
    for (const token of directives) {
        if (token === 'auto') {
            for (const m of models) {
                if (m.fields.some(f => f.name === 'deletedAt')) {
                    result[m.name] = { deletedAt: 'deletedAt' };
                }
            }
            continue;
        }
        if (token.startsWith('-')) {
            delete result[token.slice(1)];
            continue;
        }
        if (token.includes('.')) {
            const [model, column] = token.split('.');
            if (!model || !column) {
                throw new Error(`codegen: invalid softDelete token "${token}"`);
            }
            assertColumn(model, column, 'softDelete');
            result[model] = { deletedAt: column };
            continue;
        }
        if (!isModel(models, token)) {
            throw new Error(
                `codegen: unknown model "${token}" in \`softDelete\``,
            );
        }
        assertColumn(token, 'deletedAt', 'softDelete');
        result[token] = { deletedAt: 'deletedAt' };
    }

    return result;
}

/**
 * Parse the `authorship` directive list into `model → { createdBy, updatedBy,
 * deletedBy }`. `auto` = every model with a `createdBy` column; custom columns
 * are `Model.created:updated:deleted` (positional; blanks keep the default).
 */
function parseAuthorship(
    directives: string[],
    models: readonly Model[],
    assertColumn: AssertColumn,
): Record<string, AuthorshipConfig> {
    const def = (): AuthorshipConfig => ({
        createdBy: 'createdBy',
        updatedBy: 'updatedBy',
        deletedBy: 'deletedBy',
    });
    const result: Record<string, AuthorshipConfig> = {};
    for (const token of directives) {
        if (token === 'auto') {
            for (const m of models) {
                if (m.fields.some(f => f.name === 'createdBy')) {
                    result[m.name] = def();
                }
            }
            continue;
        }
        if (token.startsWith('-')) {
            delete result[token.slice(1)];
            continue;
        }
        if (token.includes('.')) {
            const [model, cols] = token.split('.');
            const [created, updated, deleted] = (cols ?? '').split(':');
            if (!model) {
                throw new Error(`codegen: invalid authorship token "${token}"`);
            }
            const cfg: AuthorshipConfig = {
                createdBy: created || 'createdBy',
                updatedBy: updated || 'updatedBy',
                deletedBy: deleted || 'deletedBy',
            };
            for (const column of [
                cfg.createdBy,
                cfg.updatedBy,
                cfg.deletedBy,
            ]) {
                assertColumn(model, column, 'authorship');
            }
            result[model] = cfg;
            continue;
        }
        if (!isModel(models, token)) {
            throw new Error(
                `codegen: unknown model "${token}" in \`authorship\``,
            );
        }
        for (const column of ['createdBy', 'updatedBy', 'deletedBy']) {
            assertColumn(token, column, 'authorship');
        }
        result[token] = def();
    }

    return result;
}

/**
 * Parse the `audit` directive list: model directives (`auto` = every model
 * except the target table, `Model`, `-Model`) plus `@table=Name` and
 * `@col.<field>=<name>` audit-table column remaps.
 */
function parseAudit(
    directives: string[],
    models: readonly Model[],
    assertKnown: AssertKnown,
    ident: RegExp,
): AuditConfig {
    // Last `@table=` wins (matches the previous last-assignment-in-loop behavior).
    const tableDirective = directives.findLast(t => t.startsWith('@table='));
    const table = tableDirective
        ? tableDirective.slice('@table='.length)
        : 'AuditLog';
    if (tableDirective && !ident.test(table)) {
        throw new Error(`codegen: invalid audit table "${table}"`);
    }
    const columns: Record<AuditField, string> = {
        principal: 'principal',
        action: 'action',
        model: 'model',
        recordId: 'recordId',
        changes: 'changes',
        createdAt: 'createdAt',
    };
    const modelTokens: string[] = [];
    for (const token of directives) {
        if (token.startsWith('@table=')) {
            continue;
        }
        if (token.startsWith('@col.')) {
            const [field, name] = token.slice('@col.'.length).split('=');
            if (!field || !name) {
                throw new Error(
                    `codegen: invalid audit column mapping "${token}"`,
                );
            }
            if (!AUDIT_FIELDS.includes(field as AuditField)) {
                throw new Error(
                    `codegen: unknown audit field "${field}" in \`audit\``,
                );
            }
            if (!ident.test(name)) {
                throw new Error(`codegen: invalid audit column "${name}"`);
            }
            columns[field as AuditField] = name;
            continue;
        }
        modelTokens.push(token);
    }

    const set = new Set<string>();
    for (const token of modelTokens) {
        if (token === 'auto') {
            for (const m of models) {
                if (m.name !== table) {
                    set.add(m.name);
                }
            }
            continue;
        }
        if (token.startsWith('-')) {
            set.delete(token.slice(1));
            continue;
        }
        set.add(token);
    }
    set.delete(table);
    assertKnown('audit', set);

    return { models: [...set], table, columns };
}

/**
 * Parse the `validation` directive list into the set of models whose generated
 * inputs/args carry `@validate` decorators. Empty (the default) means validation
 * generation is OFF. `auto` = every model; `Model` = include; `-Model` = exclude.
 */
function parseValidation(
    directives: string[],
    models: readonly Model[],
    assertKnown: AssertKnown,
): Set<string> {
    const set = new Set<string>();
    for (const token of directives) {
        if (token === 'auto') {
            for (const m of models) {
                set.add(m.name);
            }
            continue;
        }
        if (token.startsWith('-')) {
            set.delete(token.slice(1));
            continue;
        }
        set.add(token);
    }
    assertKnown('validation', set);

    return set;
}

interface AccessScopeResult {
    /** Declared access levels, in option order. */
    levels: string[];
    /** model → level → scope columns (OR within a level, AND across levels). */
    models: Record<string, Record<string, string[]>>;
}

/** Every `@scope(a, b)` occurrence in a doc comment as a list of level lists. */
function scopeAnnotations(documentation: string | undefined): string[][] {
    const re = /@scope\(([^)]*)\)/g;

    return [...(documentation ?? '').matchAll(re)].map(match =>
        match[1]!
            .split(',')
            .map(name => name.trim())
            .filter(Boolean),
    );
}

/**
 * Parse the `accessScope` directive list plus `/// @scope(level)` annotations
 * into `model → level → columns`. Option tokens declare the levels: `level`
 * (default column `${level}Id`), `level=column` (custom default column), or
 * `-Model` (exclude a model from all levels). A MODEL-level `@scope(level)`
 * scopes the model by that level's default column; a FIELD-level `@scope(level)`
 * scopes by that field. A model's columns for a level are the union of both.
 */
function parseAccessScope(
    directives: string[],
    models: readonly Model[],
    assertColumn: AssertColumn,
    ident: RegExp,
): AccessScopeResult {
    const defaults = new Map<string, string>();
    const order: string[] = [];
    const excluded = new Set<string>();
    for (const token of directives) {
        if (token.startsWith('-')) {
            const name = token.slice(1);
            if (!isModel(models, name)) {
                throw new Error(
                    `codegen: unknown model "${name}" in \`accessScope\``,
                );
            }
            excluded.add(name);
            continue;
        }
        const [rawName, rawColumn] = token.split('=').map(part => part.trim());
        const name = rawName ?? '';
        if (!ident.test(name)) {
            throw new Error(`codegen: invalid accessScope level "${token}"`);
        }
        if (!defaults.has(name)) {
            order.push(name);
        }
        defaults.set(name, rawColumn?.length ? rawColumn : `${name}Id`);
    }

    const columns: Record<string, Record<string, Set<string>>> = {};
    const add = (model: string, level: string, column: string): void => {
        (columns[model] ??= {})[level] ??= new Set();
        columns[model]![level]!.add(column);
    };
    const requireLevel = (level: string, where: string): void => {
        if (!defaults.has(level)) {
            throw new Error(
                `codegen: unknown access level "${level}" in \`@scope\` on ${where}`,
            );
        }
    };

    for (const model of models) {
        if (excluded.has(model.name)) {
            continue;
        }
        for (const levels of scopeAnnotations(model.documentation)) {
            for (const level of levels) {
                requireLevel(level, model.name);
                const column = defaults.get(level)!;
                assertColumn(model.name, column, 'accessScope');
                add(model.name, level, column);
            }
        }
        for (const field of model.fields) {
            for (const levels of scopeAnnotations(field.documentation)) {
                for (const level of levels) {
                    requireLevel(level, `${model.name}.${field.name}`);
                    add(model.name, level, field.name);
                }
            }
        }
    }

    const result: Record<string, Record<string, string[]>> = {};
    for (const [model, byLevel] of Object.entries(columns)) {
        result[model] = {};
        for (const level of order) {
            if (byLevel[level]) {
                result[model]![level] = [...byLevel[level]];
            }
        }
    }

    return { levels: order, models: result };
}

/** `enum name → "'A' | 'B'"` literal-union map, filled from the DMMF on generate. */
const enumUnions: Record<string, string> = {};

/**
 * Default TypeScript type per scalar DMMF type, used verbatim for BOTH the
 * `@property()` argument and the TS annotation. Unmapped scalars fall back to
 * `unknown`. Overridable per-type via the generator's `scalars` config
 * (e.g. `scalars = "DateTime:string"`); when `DateTime` is mapped to `string`
 * the `iso-dates` extension serializes dates to ISO strings on the wire.
 */
const DEFAULT_SCALARS: Record<string, string> = {
    String: 'string',
    Boolean: 'boolean',
    Int: 'number',
    Float: 'number',
    BigInt: 'number',
    Decimal: 'number',
    DateTime: 'Date',
    Json: 'Record<string, unknown>',
};

/** Effective scalar map for the current generate (defaults + `scalars` config). */
const scalars: Record<string, string> = { ...DEFAULT_SCALARS };

const scalarType = (field: Field): string => scalars[field.type] ?? 'unknown';

const lowerFirst = (name: string): string =>
    name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Resolve a DMMF field to its `@property()` argument (a source-code
 * expression) and its TypeScript annotation, recording used enum imports on
 * the way. Enums resolve to ready literal unions (e.g. `"'EMAIL' | 'SMS'"`).
 */
function fieldTypes(field: Field, used: Used): TypePair {
    if (field.kind === 'enum') {
        used.enums.add(field.type);
        const union = enumUnions[field.type]!;
        if (field.isList) {
            return { rpc: `"Array<${union}>"`, ts: `${field.type}[]` };
        }
        return { rpc: `"${union}"`, ts: field.type };
    }
    if (field.kind === 'object') {
        return field.isList
            ? { rpc: `'Array<${field.type}>'`, ts: `${field.type}[]` }
            : { rpc: `'${field.type}'`, ts: field.type };
    }
    const ts = field.isList ? `${scalarType(field)}[]` : scalarType(field);

    return { rpc: `'${ts}'`, ts };
}

/**
 * Render one `@classType()` class from pre-built property lines. When
 * `validatable` is set the class is also sealed with `@validatable()` so its
 * `@validate` field decorators can be inferred by the `@validated` method
 * decorator.
 */
function renderClass(
    name: string,
    fieldLines: string[],
    validatable = false,
): string {
    return (
        '@classType()\n' +
        (validatable ? '@validatable()\n' : '') +
        `export class ${name} {\n` +
        `${fieldLines.join('\n\n')}\n` +
        '}'
    );
}

/** Render the generated Prisma client enum import for the enums a file uses. */
function renderUsedImports(used: Used): string {
    return used.enums.size
        ? 'import {\n' +
              [...used.enums]
                  .sort()
                  .map(name => `    ${name},`)
                  .join('\n') +
              "\n} from '#generated/prisma/client.js';\n"
        : '';
}

function isNowDefault(field: Field): boolean {
    const def = field.default;

    return (
        field.hasDefaultValue &&
        typeof def === 'object' &&
        !Array.isArray(def) &&
        'name' in def &&
        def.name === 'now'
    );
}

/** Fields usable in a single-field `connect` (id, `@unique`, 1-field `@@unique`). */
function uniqueSingleFields(model: Model): Field[] {
    const singles = new Set(
        (model.uniqueFields ?? [])
            .filter(fields => fields.length === 1)
            .map(fields => fields[0]!),
    );

    return model.fields.filter(
        f => f.isId || f.isUnique || singles.has(f.name),
    );
}

const withId = (model: Model): boolean => model.fields.some(f => f.isId);

/**
 * Emit `relations.ts`: the relation map (`model → field → { target, isList }`)
 * the query DSL converters need — the generator protocol delivers the full
 * DMMF, including `isList`, which the client's runtime DMMF strips — plus the
 * soft-delete / authorship / audit config maps the extensions consume.
 */
function renderRelations(
    models: readonly Model[],
    softDelete: Record<string, SoftDeleteConfig>,
    authorship: Record<string, AuthorshipConfig>,
    audit: AuditConfig,
    accessScope: AccessScopeResult,
): string {
    const lines: string[] = [];
    for (const model of models) {
        const relations = model.fields.filter(f => f.kind === 'object');
        if (relations.length === 0) {
            lines.push(`    ${model.name}: {},`);
            continue;
        }
        lines.push(`    ${model.name}: {`);
        for (const field of relations) {
            lines.push(
                `        ${field.name}: ` +
                    `{ target: '${field.type}', isList: ${field.isList} },`,
            );
        }
        lines.push('    },');
    }

    const softDeleteLines = Object.entries(softDelete).map(
        ([model, cfg]) => `    ${model}: { deletedAt: '${cfg.deletedAt}' },`,
    );
    const authorshipLines = Object.entries(authorship).map(([model, cfg]) => {
        const parts = [
            `createdBy: '${cfg.createdBy}'`,
            `updatedBy: '${cfg.updatedBy}'`,
            `deletedBy: '${cfg.deletedBy}'`,
        ];
        if (cfg.deletedAt) {
            parts.push(`deletedAt: '${cfg.deletedAt}'`);
        }

        return `    ${model}: { ${parts.join(', ')} },`;
    });
    const auditModelLines = audit.models.map(m => `    '${m}',`);
    const auditColumnLines = AUDIT_FIELDS.map(
        field => `        ${field}: '${audit.columns[field]}',`,
    );

    const accessLevelLines = accessScope.levels.map(level => `    '${level}',`);
    const accessLevelsBody = accessLevelLines.length
        ? `\n${accessLevelLines.join('\n')}\n`
        : '';
    const accessModelLines = Object.entries(accessScope.models).map(
        ([model, byLevel]) => {
            const parts = Object.entries(byLevel).map(
                ([level, cols]) =>
                    `${level}: [${cols.map(c => `'${c}'`).join(', ')}]`,
            );

            return `    ${model}: { ${parts.join(', ')} },`;
        },
    );
    const accessModelsBody = accessModelLines.length
        ? `\n${accessModelLines.join('\n')}\n`
        : '';

    return (
        'export interface RelationInfo {\n' +
        '    target: string;\n' +
        '    isList: boolean;\n' +
        '}\n\n' +
        'export type ModelRelations = Record<string, RelationInfo>;\n\n' +
        'export type RelationMap = Record<string, ModelRelations>;\n\n' +
        'export const RELATIONS: RelationMap = {\n' +
        `${lines.join('\n')}\n` +
        '};\n\n' +
        '/** Soft-delete config per model: the `deletedAt` column name. */\n' +
        'export interface SoftDeleteConfig {\n' +
        '    deletedAt: string;\n' +
        '}\n' +
        'export const SOFT_DELETE_MODELS: Record<string, SoftDeleteConfig> = {\n' +
        `${softDeleteLines.join('\n')}\n` +
        '};\n\n' +
        '/** Authorship config per model: the stamp column names. `deletedAt` is\n' +
        ' * the soft-delete column whose being-set triggers `deletedBy`. */\n' +
        'export interface AuthorshipConfig {\n' +
        '    createdBy: string;\n' +
        '    updatedBy: string;\n' +
        '    deletedBy: string;\n' +
        '    deletedAt?: string;\n' +
        '}\n' +
        'export const AUTHORSHIP_MODELS: Record<string, AuthorshipConfig> = {\n' +
        `${authorshipLines.join('\n')}\n` +
        '};\n\n' +
        '/** Models whose writes are recorded to the audit log. */\n' +
        'export const AUDIT_MODELS: ReadonlySet<string> = new Set([\n' +
        `${auditModelLines.join('\n')}\n` +
        ']);\n\n' +
        '/** Audit config: the target model and its column names. */\n' +
        'export interface AuditConfig {\n' +
        '    model: string;\n' +
        '    columns: {\n' +
        '        principal: string;\n' +
        '        action: string;\n' +
        '        model: string;\n' +
        '        recordId: string;\n' +
        '        changes: string;\n' +
        '        createdAt: string;\n' +
        '    };\n' +
        '}\n' +
        'export const AUDIT_CONFIG: AuditConfig = {\n' +
        `    model: '${audit.table}',\n` +
        '    columns: {\n' +
        `${auditColumnLines.join('\n')}\n` +
        '    },\n' +
        '};\n\n' +
        '/** Access levels declared via the `accessScope` generator option. */\n' +
        `export const ACCESS_LEVELS = [${accessLevelsBody}] as const;\n` +
        'export type AccessLevel = (typeof ACCESS_LEVELS)[number];\n\n' +
        '/** Per-model scope columns per access level (OR within a level,\n' +
        ' * AND across levels). Consumed by the `accessScope` extension. */\n' +
        'export type AccessScopeConfig = Record<\n' +
        '    string,\n' +
        '    Partial<Record<AccessLevel, string[]>>\n' +
        '>;\n' +
        `export const ACCESS_SCOPE_MODELS: AccessScopeConfig = {${accessModelsBody}};\n\n` +
        '/** Runtime resolver per level: `undefined` = level inactive (skip),\n' +
        ' * `null` = active but no value (deny), a value = `=`, an array = `IN`. */\n' +
        'export type AccessScopeValue = string | string[] | null | undefined;\n' +
        'export type AccessScopeResolvers = Record<\n' +
        '    AccessLevel,\n' +
        '    () => AccessScopeValue\n' +
        '>;\n'
    );
}

/**
 * Emit `models.ts`: one `@classType()` class per Prisma model, each field an
 * optional `@property()` (reads use `select` projections, so any field may be
 * absent). Nullable columns are additionally typed `| null`. Hidden fields
 * (`omit` config secrets, soft-delete `deletedAt`) are excluded from the exposed
 * contract.
 */
function renderModels(models: readonly Model[], hidden: Hidden): string {
    const used: Used = { enums: new Set() };
    const classes = models.map(model => {
        const fields = model.fields
            .filter(f => !hidden(model, f))
            .map(field => {
                const { rpc, ts } = fieldTypes(field, used);
                const nullable =
                    !field.isRequired && !field.isList ? ' | null' : '';
                return (
                    `    @property(${rpc}, true)\n` +
                    `    ${field.name}?: ${ts}${nullable};`
                );
            });

        return renderClass(model.name, fields);
    });

    return (
        "import { classType, property } from '@imqueue/rpc';\n" +
        renderUsedImports(used) +
        '\n' +
        `${classes.join('\n\n')}\n`
    );
}

const DIRECTION = "'asc' | 'desc'";

/** Scalar operator classes the per-model `<Model>Where` classes reference. */
const OPS_CLASSES = [
    renderClass(
        'StringWhere',
        [
            ['eq', 'string'],
            ['not', 'string'],
            ['in', 'string[]'],
            ['notIn', 'string[]'],
            ['lt', 'string'],
            ['lte', 'string'],
            ['gt', 'string'],
            ['gte', 'string'],
            ['contains', 'string'],
            ['startsWith', 'string'],
            ['endsWith', 'string'],
        ].map(
            ([op, type]) =>
                `    @property('${type}', true)\n    ${op}?: ${type};`,
        ),
    ),
    renderClass(
        'NumberWhere',
        [
            ['eq', 'number'],
            ['not', 'number'],
            ['in', 'number[]'],
            ['notIn', 'number[]'],
            ['lt', 'number'],
            ['lte', 'number'],
            ['gt', 'number'],
            ['gte', 'number'],
        ].map(
            ([op, type]) =>
                `    @property('${type}', true)\n    ${op}?: ${type};`,
        ),
    ),
    renderClass('BooleanWhere', [
        "    @property('boolean', true)\n    eq?: boolean;",
        "    @property('boolean', true)\n    not?: boolean;",
    ]),
    renderClass('CountOrderBy', [
        `    @property("${DIRECTION}", true)\n    _count?: ${DIRECTION};`,
    ]),
].join('\n\n');

/** `<Model>Where` field: bare value (equality) or operator object. */
function whereField(field: Field, used: Used): TypePair {
    if (field.kind === 'object') {
        return { rpc: `'${field.type}Where'`, ts: `${field.type}Where` };
    }
    if (field.kind === 'enum') {
        used.enums.add(field.type);
        const union = enumUnions[field.type]!;
        if (field.isList) {
            return { rpc: `"Array<${union}>"`, ts: `${field.type}[]` };
        }
        return {
            rpc: `"${union} | StringWhere"`,
            ts: `${field.type} | StringWhere`,
        };
    }
    const ts = scalarType(field);
    if (field.isList) {
        return { rpc: `'${ts}[]'`, ts: `${ts}[]` };
    }
    const ops: string | undefined = {
        string: 'StringWhere',
        number: 'NumberWhere',
        boolean: 'BooleanWhere',
    }[ts];
    if (!ops) {
        return { rpc: `'${ts}'`, ts }; // Json/unknown: equality only
    }

    return { rpc: `'${ts} | ${ops}'`, ts: `${ts} | ${ops}` };
}

/** `<Model>OrderBy` field, or null when the field cannot be ordered by. */
function orderByField(field: Field): TypePair | null {
    if (field.kind === 'object') {
        return field.isList
            ? { rpc: `'CountOrderBy'`, ts: 'CountOrderBy' }
            : { rpc: `'${field.type}OrderBy'`, ts: `${field.type}OrderBy` };
    }
    if (field.isList || field.type === 'Json') {
        return null;
    }

    return { rpc: `"${DIRECTION}"`, ts: DIRECTION };
}

/**
 * The query DSL runtime emitted into `query.ts`: loose `Where`/`Select`/
 * `OrderBy` types and the `toWhere`/`toSelect`/`toOrderBy` converters.
 */
const QUERY_RUNTIME = `
export type Direction = 'asc' | 'desc';

export interface FilterOps {
    eq?: unknown;
    not?: unknown;
    in?: unknown[];
    notIn?: unknown[];
    lt?: unknown;
    lte?: unknown;
    gt?: unknown;
    gte?: unknown;
    contains?: string;
    startsWith?: string;
    endsWith?: string;
}

export type Where = object;

export type Select = object;

export type OrderBy = object;

type Node = Record<string, unknown>;

const OP_MAP: Record<string, string> = {
    eq: 'equals',
    not: 'not',
    in: 'in',
    notIn: 'notIn',
    lt: 'lt',
    lte: 'lte',
    gt: 'gt',
    gte: 'gte',
    contains: 'contains',
    startsWith: 'startsWith',
    endsWith: 'endsWith',
};

const LOGICAL = new Set(['AND', 'OR', 'NOT']);

function isPlainObject(v: unknown): v is Node {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isOps(v: unknown): v is Node {
    return (
        isPlainObject(v) &&
        Object.keys(v).length > 0 &&
        Object.keys(v).every(k => k in OP_MAP)
    );
}

function toLeaf(value: unknown): unknown {
    if (isOps(value)) {
        const out: Node = {};
        for (const [op, operand] of Object.entries(value)) {
            out[OP_MAP[op]!] = operand;
        }

        return out;
    }

    return value;
}

export function toWhere(
    map: RelationMap,
    model: string,
    where: Where | undefined,
): Record<string, unknown> | undefined {
    if (!where) {
        return undefined;
    }
    const rels = map[model] ?? {};
    const out: Node = {};
    for (const [key, value] of Object.entries(where)) {
        if (LOGICAL.has(key)) {
            const parts: unknown[] = Array.isArray(value) ? value : [value];
            out[key] = parts.map(w => toWhere(map, model, w as Where));
            continue;
        }
        const rel = rels[key];
        if (rel) {
            const nested = toWhere(map, rel.target, value as Where);
            out[key] = rel.isList ? { some: nested } : nested;
            continue;
        }
        out[key] = toLeaf(value);
    }

    return out;
}

export function toSelect(
    select: Select | undefined,
): Record<string, unknown> | undefined {
    if (!select) {
        return undefined;
    }
    const out: Node = {};
    for (const [key, value] of Object.entries(select)) {
        if (value === true) {
            out[key] = true;
            continue;
        }
        if (isPlainObject(value)) {
            out[key] = { select: toSelect(value) };
        }
    }

    return Object.keys(out).length > 0 ? out : undefined;
}

function orderValue(
    map: RelationMap,
    model: string,
    key: string,
    value: unknown,
): unknown {
    const rel = (map[model] ?? {})[key];
    if (!rel) {
        return value;
    }
    if (rel.isList) {
        if (isPlainObject(value) && '_count' in value) {
            return { _count: value._count };
        }
        throw new Error(
            \`Cannot order by a field through to-many relation "\${key}"; \` +
                \`use { "\${key}": { _count: "asc" } } instead\`,
        );
    }
    const nested: Node = {};
    for (const [k, v] of Object.entries(value as Node)) {
        nested[k] = orderValue(map, rel.target, k, v);
    }

    return nested;
}

export function toOrderBy(
    map: RelationMap,
    model: string,
    orderBy: OrderBy | undefined,
): unknown[] | undefined {
    if (!orderBy || Object.keys(orderBy).length === 0) {
        return undefined;
    }

    return Object.entries(orderBy).map(([key, value]) => ({
        [key]: orderValue(map, model, key, value),
    }));
}
`;

/**
 * Emit `query.ts`: the query DSL — the `toWhere`/`toSelect`/`toOrderBy`
 * converters and loose `Where`/`Select`/`OrderBy` types, plus per-model
 * `<Model>Select`, `<Model>Where` and `<Model>OrderBy` classes typing that
 * DSL for RPC clients, and the scalar operator classes they reference. Where
 * semantics follow the converters: a bare value is equality, a to-many
 * relation filter is wrapped in `some`, a to-many order allows `_count` only.
 * Hidden fields are excluded from every surface.
 */
function renderQuery(models: readonly Model[], hidden: Hidden): string {
    const used: Used = { enums: new Set() };
    const classes = models.flatMap(model => {
        const fields = model.fields.filter(f => !hidden(model, f));
        const logical = ['AND', 'OR', 'NOT'].map(
            op =>
                `    @property('${model.name}Where` +
                ` | Array<${model.name}Where>', true)\n` +
                `    ${op}?: ${model.name}Where | ${model.name}Where[];`,
        );

        return [
            renderClass(
                `${model.name}Select`,
                fields.map(field => {
                    const ts =
                        field.kind === 'object'
                            ? `boolean | ${field.type}Select`
                            : 'boolean';
                    return (
                        `    @property('${ts}', true)\n` +
                        `    ${field.name}?: ${ts};`
                    );
                }),
            ),
            renderClass(`${model.name}Where`, [
                ...logical,
                ...fields.map(field => {
                    const { rpc, ts } = whereField(field, used);
                    return (
                        `    @property(${rpc}, true)\n` +
                        `    ${field.name}?: ${ts};`
                    );
                }),
            ]),
            renderClass(
                `${model.name}OrderBy`,
                fields.flatMap(field => {
                    const type = orderByField(field);
                    return type
                        ? [
                              `    @property(${type.rpc}, true)\n` +
                                  `    ${field.name}?: ${type.ts};`,
                          ]
                        : [];
                }),
            ),
        ];
    });

    return (
        "import { classType, property } from '@imqueue/rpc';\n" +
        renderUsedImports(used) +
        "import type { RelationMap } from '#generated/relations.js';\n" +
        '\n' +
        `${QUERY_RUNTIME.trim()}\n\n` +
        `${OPS_CLASSES}\n\n` +
        `${classes.join('\n\n')}\n`
    );
}

/**
 * One `<Model>CreateInput`/`<Model>UpdateInput` property. Relations nest as
 * `<Target>CreateNestedOne/Many` (`create`/`connect`). FK scalar columns
 * (`isReadOnly`) and defaulted/list fields are optional; on update everything
 * but `id` is optional.
 */
interface FieldLine {
    line: string;
    /** Whether the line carries a `@validate(...)` decorator. */
    validated: boolean;
}

function inputFieldLine(
    field: Field,
    used: Used,
    forceOptional: boolean,
    enumValues: Record<string, string[]>,
    withValidation: boolean,
): FieldLine {
    const type =
        field.kind === 'object'
            ? {
                  rpc: `'${field.type}CreateNested${field.isList ? 'Many' : 'One'}'`,
                  ts: `${field.type}CreateNested${field.isList ? 'Many' : 'One'}`,
              }
            : fieldTypes(field, used);
    const required =
        !forceOptional &&
        field.kind !== 'object' &&
        field.isRequired &&
        !field.hasDefaultValue &&
        !field.isReadOnly &&
        !field.isList;
    const validator = withValidation
        ? fieldValidator(field, !required, enumValues)
        : null;
    const validate = validator ? `    @validate(${validator})\n` : '';
    if (required) {
        return {
            line: `${validate}    @property(${type.rpc})\n    ${field.name}!: ${type.ts};`,
            validated: !!validator,
        };
    }
    const nullable = !field.isRequired && !field.isList ? ' | null' : '';

    return {
        line:
            `${validate}    @property(${type.rpc}, true)\n` +
            `    ${field.name}?: ${type.ts}${nullable};`,
        validated: !!validator,
    };
}

/**
 * Emit `inputs.ts`: per-model `<Model>CreateInput` (and `<Model>UpdateInput`
 * for models with an `id`), plus the `<Model>WhereUnique` and
 * `<Model>CreateNestedOne/Many` classes relations reference. Managed columns
 * (`@updatedAt`, `now()` defaults, soft-delete `deletedAt`) are excluded; the
 * read-surface `omit` config does NOT apply — secrets are legitimate inputs.
 */
function renderInputs(
    models: readonly Model[],
    hidden: Hidden,
    enumValues: Record<string, string[]>,
    validation: ReadonlySet<string>,
): string {
    const used: Used = { enums: new Set() };
    const targets = new Set(
        models.flatMap(m =>
            m.fields
                .filter(f => f.kind === 'object' && !hidden(m, f))
                .map(f => f.type),
        ),
    );
    const skipped = (model: Model, field: Field) =>
        field.isUpdatedAt || isNowDefault(field) || hidden(model, field);

    // Build an input class from field lines, sealing it `@validatable()` when any
    // field carries a `@validate(...)` decorator so `@validated` can infer it.
    const buildInput = (name: string, entries: FieldLine[]): string =>
        renderClass(
            name,
            entries.map(e => e.line),
            entries.some(e => e.validated),
        );

    const classes = models.flatMap(model => {
        const out: string[] = [];
        const withValidation = validation.has(model.name);
        const uniques = uniqueSingleFields(model);
        if (targets.has(model.name)) {
            if (uniques.length > 0) {
                out.push(
                    renderClass(
                        `${model.name}WhereUnique`,
                        uniques.map(field => {
                            const { rpc, ts } = fieldTypes(field, used);
                            return (
                                `    @property(${rpc}, true)\n` +
                                `    ${field.name}?: ${ts};`
                            );
                        }),
                    ),
                );
            }
            out.push(
                renderClass(`${model.name}CreateNestedOne`, [
                    `    @property('${model.name}CreateInput', true)\n` +
                        `    create?: ${model.name}CreateInput;`,
                    ...(uniques.length > 0
                        ? [
                              `    @property('${model.name}WhereUnique', true)\n` +
                                  `    connect?: ${model.name}WhereUnique;`,
                          ]
                        : []),
                ]),
                renderClass(`${model.name}CreateNestedMany`, [
                    `    @property('Array<${model.name}CreateInput>', true)\n` +
                        `    create?: ${model.name}CreateInput[];`,
                    ...(uniques.length > 0
                        ? [
                              `    @property('Array<${model.name}WhereUnique>', true)\n` +
                                  `    connect?: ${model.name}WhereUnique[];`,
                          ]
                        : []),
                ]),
            );
        }
        const fields = model.fields.filter(f => !skipped(model, f));
        out.push(
            buildInput(
                `${model.name}CreateInput`,
                fields.map(f =>
                    inputFieldLine(f, used, false, enumValues, withValidation),
                ),
            ),
        );
        const idField = model.fields.find(f => f.isId);
        if (idField) {
            const { rpc, ts } = fieldTypes(idField, used);
            const idValidator = withValidation
                ? fieldValidator(idField, false, enumValues)
                : null;
            const idLine: FieldLine = {
                line:
                    (idValidator ? `    @validate(${idValidator})\n` : '') +
                    `    @property(${rpc})\n    ${idField.name}!: ${ts};`,
                validated: !!idValidator,
            };
            out.push(
                buildInput(`${model.name}UpdateInput`, [
                    idLine,
                    ...fields
                        .filter(f => !f.isId)
                        .map(f =>
                            inputFieldLine(
                                f,
                                used,
                                true,
                                enumValues,
                                withValidation,
                            ),
                        ),
                ]),
            );
        }
        // Bulk (createMany/updateMany) data is scalar-only: Prisma accepts no
        // nested relation writes there, so relations are left out entirely.
        const scalars = fields.filter(f => f.kind !== 'object');
        out.push(
            buildInput(
                `${model.name}CreateBulkInput`,
                scalars.map(f =>
                    inputFieldLine(f, used, false, enumValues, withValidation),
                ),
            ),
            buildInput(
                `${model.name}UpdateBulkInput`,
                scalars
                    .filter(f => !f.isId)
                    .map(f =>
                        inputFieldLine(
                            f,
                            used,
                            true,
                            enumValues,
                            withValidation,
                        ),
                    ),
            ),
        );

        return out;
    });

    const body = `${classes.join('\n\n')}\n`;
    const validationImports = body.includes('@validate(')
        ? "import { z } from 'zod';\n" +
          "import { validatable, validate } from '@imqueue/validation';\n"
        : '';

    return (
        "import { classType, property } from '@imqueue/rpc';\n" +
        renderUsedImports(used) +
        validationImports +
        '\n' +
        body
    );
}

/** Whether the field's DB default is a client-side `uuid()` (no arguments). */
function isUuidDefault(field: Field): boolean {
    const def = field.default;

    return (
        field.hasDefaultValue &&
        typeof def === 'object' &&
        !Array.isArray(def) &&
        'name' in def &&
        def.name === 'uuid'
    );
}

/**
 * The base Zod expression for a field, or `null` when no meaningful validation
 * applies (relations, `Json`, unmapped scalars). `uuid()`-defaulted columns are
 * validated as UUIDs (this auto-derives the `id` rule without a `///`
 * directive); string columns pick up their `@db.VarChar(n)` length as `.max(n)`.
 */
function zodBase(
    field: Field,
    enumValues: Record<string, string[]>,
): string | null {
    if (field.kind === 'object') {
        return null;
    }
    if (field.kind === 'enum') {
        const values = enumValues[field.type] ?? [];

        return `z.enum([${values.map(v => `'${v}'`).join(', ')}])`;
    }
    const ts = scalarType(field);
    if (ts === 'string') {
        if (isUuidDefault(field)) {
            return 'z.uuid()';
        }
        const [nativeName, nativeArgs] = field.nativeType ?? [];
        const max =
            nativeName && /char/i.test(nativeName) && nativeArgs?.[0]
                ? `.max(${nativeArgs[0]})`
                : '';

        return `z.string()${max}`;
    }
    if (ts === 'number') {
        return field.type === 'Int' ? 'z.number().int()' : 'z.number()';
    }
    if (ts === 'boolean') {
        return 'z.boolean()';
    }

    return null;
}

/**
 * The full Zod expression for a `@validate(...)` decorator on a field, or `null`
 * when the field has no validation: base type + any `/// @validate <tail>`
 * refinement appended (e.g. `/// @validate .email().max(255)`) + `.optional()`
 * when `optional` (kept in lockstep with the field's `@property` optionality).
 */
function fieldValidator(
    field: Field,
    optional: boolean,
    enumValues: Record<string, string[]>,
): string | null {
    const base = zodBase(field, enumValues);
    if (!base) {
        return null;
    }
    const wrapped = field.isList ? `z.array(${base})` : base;
    const tail = /@validate\s+(.+)/.exec(field.documentation ?? '');
    const refined = tail?.[1] ? wrapped + tail[1].trim() : wrapped;

    return optional ? `${refined}.optional()` : refined;
}

/**
 * Emit `args.ts`: per-model repository/RPC argument classes —
 * `<Model>CreateArgs`, `<Model>UpdateArgs` (models with an `id`),
 * `<Model>SingleArgs`, `<Model>ListArgs`, the bulk `<Model>{Create,Update,
 * Remove}BulkArgs`, and the `<Model>Page` list result — plus the shared
 * `PageOptions` and `BulkCount`. These are the exposed wire contracts of the
 * generated repositories.
 */
function renderArgs(
    models: readonly Model[],
    validation: ReadonlySet<string>,
): string {
    // An `input!: <Input>` line, validated (when the model opts in) by inferring
    // the referenced input class's own `@validate` field schema.
    const inputField = (inputName: string, withValidation: boolean): string =>
        (withValidation ? `    @validate(${inputName})\n` : '') +
        `    @property('${inputName}')\n    input!: ${inputName};`;

    const classes = [
        renderClass('PageOptions', [
            "    @property('number', true)\n    skip?: number;",
            "    @property('number', true)\n    take?: number;",
            "    @property('boolean', true)\n    withTotal?: boolean;",
        ]),
        renderClass('BulkCount', [
            "    @property('number')\n    count!: number;",
        ]),
        ...models.flatMap(model => {
            const n = model.name;
            const withValidation = validation.has(n);
            const select = `    @property('${n}Select', true)\n    select?: ${n}Select;`;
            const out = [
                renderClass(
                    `${n}CreateArgs`,
                    [inputField(`${n}CreateInput`, withValidation), select],
                    withValidation,
                ),
            ];
            if (withId(model)) {
                out.push(
                    renderClass(
                        `${n}UpdateArgs`,
                        [inputField(`${n}UpdateInput`, withValidation), select],
                        withValidation,
                    ),
                );
            }
            out.push(
                renderClass(`${n}SingleArgs`, [
                    `    @property('${n}Where')\n    where!: ${n}Where;`,
                    select,
                ]),
                renderClass(`${n}ListArgs`, [
                    `    @property('${n}Where', true)\n    where?: ${n}Where;`,
                    select,
                    `    @property('${n}OrderBy', true)\n    orderBy?: ${n}OrderBy;`,
                    `    @property('PageOptions', true)\n    options?: PageOptions;`,
                ]),
                renderClass(`${n}CreateBulkArgs`, [
                    `    @property('Array<${n}CreateBulkInput>')\n` +
                        `    input!: ${n}CreateBulkInput[];`,
                ]),
                renderClass(`${n}UpdateBulkArgs`, [
                    `    @property('${n}Where')\n    where!: ${n}Where;`,
                    `    @property('${n}UpdateBulkInput')\n` +
                        `    input!: ${n}UpdateBulkInput;`,
                ]),
                renderClass(`${n}RemoveBulkArgs`, [
                    `    @property('${n}Where')\n    where!: ${n}Where;`,
                ]),
                renderClass(`${n}Page`, [
                    `    @property('Array<${n}>')\n    items!: ${n}[];`,
                    `    @property('number', true)\n    total!: number | null;`,
                ]),
            );

            return out;
        }),
    ];
    const list = (names: string[]) =>
        names.map(name => `    ${name},`).join('\n');
    const inputNames = models.flatMap(m => [
        `${m.name}CreateInput`,
        `${m.name}CreateBulkInput`,
        `${m.name}UpdateBulkInput`,
        ...(withId(m) ? [`${m.name}UpdateInput`] : []),
    ]);
    // Inputs referenced by a `@validate(...)` decorator need a runtime (value)
    // import; the rest stay type-only.
    const valueInputs = new Set(
        models
            .filter(m => validation.has(m.name))
            .flatMap(m => [
                `${m.name}CreateInput`,
                ...(withId(m) ? [`${m.name}UpdateInput`] : []),
            ]),
    );
    const typeInputNames = inputNames.filter(n => !valueInputs.has(n)).sort();
    const valueInputNames = [...valueInputs].sort();
    const queryNames = models
        .flatMap(m => [`${m.name}OrderBy`, `${m.name}Select`, `${m.name}Where`])
        .sort();
    const modelNames = models.map(m => m.name).sort();

    return (
        "import { classType, property } from '@imqueue/rpc';\n" +
        (valueInputNames.length > 0
            ? `import {\n${list(valueInputNames)}\n} from '#generated/inputs.js';\n`
            : '') +
        (typeInputNames.length > 0
            ? `import type {\n${list(typeInputNames)}\n} from '#generated/inputs.js';\n`
            : '') +
        `import type {\n${list(modelNames)}\n} from '#generated/models.js';\n` +
        `import type {\n${list(queryNames)}\n} from '#generated/query.js';\n` +
        (valueInputNames.length > 0
            ? "import { validatable, validate } from '@imqueue/validation';\n"
            : '') +
        '\n' +
        `${classes.join('\n\n')}\n`
    );
}

/**
 * The generic entity helpers emitted into `repositories.ts`, wrapping Prisma
 * delegates with the query DSL converters.
 */
const REPOSITORY_RUNTIME = `
export interface Page<Entity> {
    items: Entity[];
    total: number | null;
}

interface Delegate {
    create(args: any): Promise<unknown>;
    createMany(args: any): Promise<unknown>;
    update(args: any): Promise<unknown>;
    updateMany(args: any): Promise<unknown>;
    deleteMany(args: any): Promise<unknown>;
    findFirst(args: any): Promise<unknown>;
    findMany(args: any): Promise<unknown>;
    count(args: any): Promise<unknown>;
}

async function createEntity<Entity>(
    delegate: Delegate,
    args: { input: object; select?: Select },
): Promise<Entity> {
    return (await delegate.create({
        data: args.input,
        select: toSelect(args.select),
    })) as Entity;
}

async function updateEntity<Entity>(
    delegate: Delegate,
    args: { input: { id: string }; select?: Select },
): Promise<Entity> {
    const { id, ...data } = args.input;

    return (await delegate.update({
        where: { id },
        data,
        select: toSelect(args.select),
    })) as Entity;
}

async function createBulkEntities(
    delegate: Delegate,
    args: { input: object[] },
): Promise<BulkCount> {
    return (await delegate.createMany({ data: args.input })) as BulkCount;
}

async function updateBulkEntities(
    delegate: Delegate,
    model: string,
    args: { where: Where; input: object },
): Promise<BulkCount> {
    return (await delegate.updateMany({
        where: toWhere(RELATIONS, model, args.where) ?? {},
        data: args.input,
    })) as BulkCount;
}

async function removeBulkEntities(
    delegate: Delegate,
    model: string,
    args: { where: Where },
): Promise<BulkCount> {
    return (await delegate.deleteMany({
        where: toWhere(RELATIONS, model, args.where) ?? {},
    })) as BulkCount;
}

async function findEntity<Entity>(
    delegate: Delegate,
    model: string,
    args: { where: Where; select?: Select },
): Promise<Entity | null> {
    return (await delegate.findFirst({
        where: toWhere(RELATIONS, model, args.where) ?? {},
        select: toSelect(args.select),
    })) as Entity | null;
}

async function findPage<Entity>(
    delegate: Delegate,
    model: string,
    args: {
        where?: Where;
        select?: Select;
        orderBy?: OrderBy;
        options?: PageOptions;
    },
): Promise<Page<Entity>> {
    const { skip, take, withTotal } = args.options ?? {};
    const where = toWhere(RELATIONS, model, args.where);

    const [items, total] = await Promise.all([
        delegate.findMany({
            where,
            select: toSelect(args.select),
            orderBy: toOrderBy(RELATIONS, model, args.orderBy),
            skip,
            take,
        }) as Promise<Entity[]>,
        withTotal
            ? (delegate.count({ where }) as Promise<number>)
            : Promise.resolve<number | null>(null),
    ]);

    return { items, total };
}
`;

/**
 * Emit `repositories.ts`: a self-contained data layer — its own generic
 * entity helpers (using the query DSL converters), one repository per model
 * with `create`/`update`/`single`/`list` accepting the generated
 * `<Model>…Args` classes, aggregated into the `repository` export
 * (`repository.user.list(...)`). `create`/`update` pass `input` straight
 * through to Prisma; `update` is omitted for models without an `id`
 * (composite-key join tables).
 */
function renderRepositories(models: readonly Model[]): string {
    const repositories = models.map(model => {
        const name = model.name;
        const acc = lowerFirst(name);
        const methods = [
            `    create<Entity = ${name}>(args: ${name}CreateArgs): Promise<Entity> {\n` +
                `        return createEntity<Entity>(prisma.${acc}, args);\n` +
                `    },`,
            ...(withId(model)
                ? [
                      `    update<Entity = ${name}>(args: ${name}UpdateArgs): Promise<Entity> {\n` +
                          `        return updateEntity<Entity>(prisma.${acc}, args);\n` +
                          `    },`,
                  ]
                : []),
            `    single<Entity = ${name}>(args: ${name}SingleArgs): Promise<Entity | null> {\n` +
                `        return findEntity<Entity>(prisma.${acc}, '${name}', args);\n` +
                `    },`,
            `    list<Entity = ${name}>(args: ${name}ListArgs): Promise<Page<Entity>> {\n` +
                `        return findPage<Entity>(prisma.${acc}, '${name}', args);\n` +
                `    },`,
            `    createBulk(args: ${name}CreateBulkArgs): Promise<BulkCount> {\n` +
                `        return createBulkEntities(prisma.${acc}, args);\n` +
                `    },`,
            `    updateBulk(args: ${name}UpdateBulkArgs): Promise<BulkCount> {\n` +
                `        return updateBulkEntities(prisma.${acc}, '${name}', args);\n` +
                `    },`,
            `    removeBulk(args: ${name}RemoveBulkArgs): Promise<BulkCount> {\n` +
                `        return removeBulkEntities(prisma.${acc}, '${name}', args);\n` +
                `    },`,
        ];

        return `const ${acc} = {\n${methods.join('\n\n')}\n};`;
    });

    const list = (names: string[]) =>
        names.map(name => `    ${name},`).join('\n');
    const argNames = [
        'BulkCount',
        'PageOptions',
        ...models.flatMap(m => [
            `${m.name}CreateArgs`,
            ...(withId(m) ? [`${m.name}UpdateArgs`] : []),
            `${m.name}SingleArgs`,
            `${m.name}ListArgs`,
            `${m.name}CreateBulkArgs`,
            `${m.name}UpdateBulkArgs`,
            `${m.name}RemoveBulkArgs`,
        ]),
    ].sort();
    const modelNames = models.map(m => m.name).sort();
    const aggregate =
        'export const repository = {\n' +
        models.map(m => `    ${lowerFirst(m.name)},`).join('\n') +
        '\n};';

    return (
        `import type {\n${list(argNames)}\n} from '#generated/args.js';\n` +
        `import type {\n${list(modelNames)}\n} from '#generated/models.js';\n` +
        'import {\n' +
        '    type OrderBy,\n' +
        '    type Select,\n' +
        '    type Where,\n' +
        '    toOrderBy,\n' +
        '    toSelect,\n' +
        '    toWhere,\n' +
        "} from '#generated/query.js';\n" +
        "import { RELATIONS } from '#generated/relations.js';\n" +
        "import { prisma } from '#prisma.js';\n" +
        '\n' +
        `${REPOSITORY_RUNTIME.trim()}\n\n` +
        `${repositories.join('\n\n')}\n\n` +
        `${aggregate}\n`
    );
}

/** Emit `index.ts`: a barrel re-exporting every generated module. */
function renderBarrel(): string {
    return (
        ['relations', 'models', 'query', 'inputs', 'args', 'repositories']
            .map(name => `export * from '#generated/${name}.js';`)
            .join('\n') + '\n'
    );
}

const generator = {
    onManifest: () => ({
        prettyName: 'RPC models & repositories',
        defaultOutput: '../src/generated',
    }),
    async onGenerate(options: GeneratorOptions): Promise<void> {
        const output =
            options.generator.output?.value ??
            join(dirname(options.schemaPath), '..', 'src', 'generated');
        const configSet = (key: string): Set<string> => {
            const raw = options.generator.config[key] ?? '';
            return new Set(
                (Array.isArray(raw) ? raw.join(',') : raw)
                    .split(',')
                    .map(entry => entry.trim())
                    .filter(Boolean),
            );
        };
        const omit = configSet('omit');

        const models = options.dmmf.datamodel.models;
        const assertKnown = (key: string, names: Iterable<string>) => {
            for (const name of names) {
                if (!models.some(m => m.name === name)) {
                    throw new Error(
                        `codegen: unknown model "${name}" in \`${key}\``,
                    );
                }
            }
        };

        const tokens = (key: string): string[] => {
            const raw = options.generator.config[key] ?? '';
            return (Array.isArray(raw) ? raw.join(',') : raw)
                .split(',')
                .map(entry => entry.trim())
                .filter(Boolean);
        };
        const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const assertColumn = (
            modelName: string,
            column: string,
            key: string,
        ): void => {
            const model = models.find(m => m.name === modelName);
            if (!model?.fields.some(f => f.name === column)) {
                throw new Error(
                    `codegen: unknown column "${modelName}.${column}" in \`${key}\``,
                );
            }
        };
        const softDelete = parseSoftDelete(
            tokens('softDelete'),
            models,
            assertColumn,
        );
        const authorship = parseAuthorship(
            tokens('authorship'),
            models,
            assertColumn,
        );
        // Link each authored model's soft-delete column (if any) as the trigger
        // that makes an update stamp `deletedBy` (see the authorship extension).
        for (const [name, cfg] of Object.entries(authorship)) {
            const sd = softDelete[name];
            if (sd) {
                cfg.deletedAt = sd.deletedAt;
            }
        }
        const audit = parseAudit(tokens('audit'), models, assertKnown, IDENT);
        // Validation is OFF unless enabled via the `validation` option
        // (e.g. `validation = "auto"`).
        const validation = parseValidation(
            tokens('validation'),
            models,
            assertKnown,
        );
        const accessScope = parseAccessScope(
            tokens('accessScope'),
            models,
            assertColumn,
            IDENT,
        );

        // `scalars` overrides the default scalar→TS map, e.g.
        // `scalars = "DateTime:string,BigInt:string"`. The map starts from
        // `DEFAULT_SCALARS` at module load; codegen runs once per process, so
        // config overrides are applied by mutation below.
        const scalarRaw = options.generator.config.scalars ?? '';
        for (const pair of (Array.isArray(scalarRaw)
            ? scalarRaw.join(',')
            : scalarRaw
        )
            .split(',')
            .map(entry => entry.trim())
            .filter(Boolean)) {
            const [type, tsType] = pair.split(':').map(part => part.trim());
            if (!type || !tsType) {
                throw new Error(
                    `codegen: invalid scalar mapping "${pair}" ` +
                        '(expected Type:tsType)',
                );
            }
            scalars[type] = tsType;
        }

        const include = configSet('include');
        const exclude = configSet('exclude');
        assertKnown('include', include);
        assertKnown('exclude', exclude);
        const generated = models.filter(
            m =>
                (include.size === 0 || include.has(m.name)) &&
                !exclude.has(m.name),
        );
        if (generated.length === 0) {
            throw new Error('codegen: include/exclude left no models');
        }
        const generatedNames = new Set(generated.map(m => m.name));

        Object.assign(
            enumUnions,
            Object.fromEntries(
                options.dmmf.datamodel.enums.map(e => [
                    e.name,
                    e.values.map(v => `'${v.name}'`).join(' | '),
                ]),
            ),
        );
        const enumValues = Object.fromEntries(
            options.dmmf.datamodel.enums.map(e => [
                e.name,
                e.values.map(v => v.name),
            ]),
        );
        const softDeletedField: Hidden = (model, field) =>
            softDelete[model.name]?.deletedAt === field.name;
        const droppedRelation = (field: Field): boolean =>
            field.kind === 'object' && !generatedNames.has(field.type);
        const inputHidden: Hidden = (model, field) =>
            softDeletedField(model, field) || droppedRelation(field);
        const readHidden: Hidden = (model, field) =>
            omit.has(`${model.name}.${field.name}`) ||
            inputHidden(model, field);

        await mkdir(output, { recursive: true });
        await writeFile(
            join(output, 'relations.ts'),
            renderRelations(models, softDelete, authorship, audit, accessScope),
        );
        await writeFile(
            join(output, 'models.ts'),
            renderModels(generated, readHidden),
        );
        await writeFile(
            join(output, 'query.ts'),
            renderQuery(generated, readHidden),
        );
        await writeFile(
            join(output, 'inputs.ts'),
            renderInputs(generated, inputHidden, enumValues, validation),
        );
        await writeFile(
            join(output, 'args.ts'),
            renderArgs(generated, validation),
        );
        await writeFile(
            join(output, 'repositories.ts'),
            renderRepositories(generated),
        );
        await writeFile(join(output, 'index.ts'), renderBarrel());

        try {
            execSync(`npx oxfmt "${output}"`, {
                cwd: join(output, '..', '..'),
                stdio: 'ignore',
            });
        } catch {}
    },
};

// Register with Prisma only when run directly as the generator entry (Prisma
// spawns `node lib/codegen.ts`). Importing this module — e.g. via the package
// barrel — must have no side effects and must not require the dev-only
// `@prisma/generator-helper`, so it is loaded lazily here.
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const { default: generatorHelper } =
        await import('@prisma/generator-helper');
    generatorHelper.generatorHandler(generator);
}
