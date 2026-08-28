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

import type { DeriveFields } from '../derive.js';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ImportMap } from './imports.js';
import {
    type EmitContract,
    type EnumNames,
    emitEnums,
    emitModels,
} from './models.js';
import { type ValidationRules, emitRpcTypes } from './rpc.js';

/** Everything {@link emitAll} needs. */
export interface EmitAllOptions {
    /** The emitted contract, read from `contract.json`. */
    contract: EmitContract;
    /** Directory the files are written to. */
    outDir: string | URL;
    /** Namespace to emit. Defaults to the only one, or `public`. */
    namespace?: string;
    /** Validation rules per model per field, as Zod suffixes. */
    validation?: ValidationRules;
    /** Where the generated files import their runtime from. */
    imports?: ImportMap;
    /** Stamp field names, where a service overrides the defaults. */
    fields?: DeriveFields;
    /** Fields kept off the generated surface, as `Model.field`. */
    omit?: readonly string[];
    /** Names for enum members whose database label is not the name. */
    enums?: EnumNames;
}

/** One emitted file. */
const FILES = {
    enums: 'enums.ts',
    models: 'models.ts',
    rpc: 'rpc.ts',
    index: 'index.ts',
} as const;

/**
 * Emit every generated file for a contract.
 *
 * @remarks
 * The three emitters and the barrel that ties them together, in one call,
 * because writing them out separately is the same handful of lines in every
 * consumer — and a consumer that forgets the barrel gets a build error rather
 * than a hint.
 *
 * Deliberately takes an `outDir` and no opinion about where a project keeps
 * its contract or its generated code: those are the consumer's conventions,
 * not this package's.
 *
 * @param options - The contract, where to write, and what to redirect.
 * @returns The paths written.
 * @example
 * ```typescript
 * await emitAll({
 *     contract,
 *     outDir: new URL('../src/generated/', import.meta.url),
 *     imports: parseImportMap('zod=@my-org/runtime'),
 * });
 * ```
 */
export async function emitAll({
    contract,
    outDir,
    namespace,
    validation,
    imports,
    fields,
    omit,
    enums,
}: EmitAllOptions): Promise<string[]> {
    const dir = outDir instanceof URL ? outDir : new URL(`file://${outDir}/`);
    const shared = {
        contract,
        ...(namespace ? { namespace } : {}),
        ...(omit ? { omit } : {}),
    };
    const written: [string, string][] = [
        [FILES.enums, emitEnums({ ...shared, ...(enums ? { enums } : {}) })],
        [
            FILES.models,
            emitModels({ ...shared, ...(imports ? { imports } : {}) }),
        ],
        [
            FILES.rpc,
            emitRpcTypes({
                ...shared,
                ...(validation ? { validation } : {}),
                ...(imports ? { imports } : {}),
                ...(fields ? { fields } : {}),
            }),
        ],
        [
            FILES.index,
            Object.values(FILES)
                .filter(name => name !== FILES.index)
                .map(
                    name =>
                        `export * from './${name.replace(/\.ts$/, '.js')}';\n`,
                )
                .join(''),
        ],
    ];

    await mkdir(dir, { recursive: true });
    await Promise.all(
        written.map(([name, body]) => writeFile(new URL(name, dir), body)),
    );

    return written.map(([name]) => new URL(name, dir).pathname);
}
