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

/**
 * The modules generated code imports at runtime, and how a consumer redirects
 * them.
 *
 * @remarks
 * The decorators the generated classes carry are only meaningful to the
 * registry that defined them. `@imqueue/rpc`, `@imqueue/validation` and `zod`
 * therefore have to be a **single copy** shared with the service, and a second
 * copy fails silently rather than loudly — a second decorator registry that
 * nothing reads, or a `ZodError` that fails `instanceof`.
 *
 * The reliable way to guarantee one copy is for one package to own the
 * dependency and re-export it, with every service taking it from there. That
 * only works if the generated files can be pointed at that package, which is
 * what this module exists to allow.
 */

/** A module the generated code imports from, and what it takes from it. */
export interface RuntimeModule {
    /** The specifier, before any redirection. */
    readonly from: string;
    /** The named exports taken from it. */
    readonly symbols: readonly string[];
    /**
     * Whether these are types rather than values.
     *
     * @remarks
     * A type imported as a value compiles under `verbatimModuleSyntax` and
     * then fails at run time with no such export, because there is nothing
     * there to import.
     */
    readonly typeOnly?: boolean;
}

/**
 * Where each runtime lives by default.
 *
 * @remarks
 * Declared rather than written at each emission site, so a specifier appears
 * once and redirection has a single place to act.
 */
export const RUNTIME = {
    rpc: {
        from: '@imqueue/rpc',
        symbols: ['classType', 'property'],
    },
    validation: {
        from: '@imqueue/validation',
        symbols: ['validatable', 'validate'],
    },
    zod: {
        from: 'zod',
        symbols: ['z'],
    },
    repository: {
        from: '@imqueue/pg-prisma',
        symbols: ['Repository'],
        typeOnly: true,
    },
} as const satisfies Record<string, RuntimeModule>;

/** A runtime the generated code can import from. */
export type RuntimeName = keyof typeof RUNTIME;

/** Original specifier to the specifier to emit in its place. */
export type ImportMap = Readonly<Record<string, string>>;

/**
 * Read an import map from its generator-option spelling.
 *
 * @remarks
 * `"zod=@my-org/runtime, @imqueue/rpc=@my-org/runtime"`. An
 * entry naming a specifier this package never emits is a throw rather than a
 * no-op: silently ignoring it would leave the consumer believing a redirection
 * had been applied when the generated files still point at the original.
 *
 * @param spec - The option value, or undefined for no redirection.
 * @returns The parsed map.
 * @throws When an entry is malformed or names an unknown specifier.
 * @example
 * ```typescript
 * parseImportMap('zod=@my-org/runtime');
 * // { zod: '@my-org/runtime' }
 * ```
 */
export function parseImportMap(spec?: string): ImportMap {
    const known = new Set(
        Object.values(RUNTIME).map(module => module.from as string),
    );

    return Object.fromEntries(
        (spec ?? '')
            .split(',')
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0)
            .map(entry => {
                const [from, to] = entry.split('=').map(part => part.trim());
                if (!from || !to) {
                    throw new Error(`imports: "${entry}" is not "<from>=<to>"`);
                }
                if (!known.has(from)) {
                    throw new Error(
                        `imports: "${from}" is not a module this generator ` +
                            `emits (${[...known].sort().join(', ')})`,
                    );
                }

                return [from, to];
            }),
    );
}

/**
 * Emit the import statements for the runtimes a file uses.
 *
 * @remarks
 * Statements are **merged by resolved specifier**. Redirecting several
 * runtimes at one package is the whole point of the option, and emitting one
 * import per original specifier would then produce three imports of the same
 * module in a file — which is a lint error, and reads as an oversight rather
 * than as the redirection it is. Specifiers and symbols are both sorted, so
 * the output is stable and a regenerated file diffs cleanly.
 *
 * @param names - The runtimes this file takes symbols from.
 * @param map - Redirections, from {@link parseImportMap}.
 * @returns The import statements, newline-terminated, or '' for none.
 * @example
 * ```typescript
 * emitImports(['rpc', 'zod'], { zod: '@my-org/runtime',
 *                               '@imqueue/rpc': '@my-org/runtime' });
 * // "import { classType, property, z } from '@my-org/runtime';\n"
 * ```
 */
export function emitImports(
    names: readonly RuntimeName[],
    map: ImportMap = {},
): string {
    // Keyed by specifier AND by whether it is a type import: the two cannot
    // merge into one statement, and a type merged into a value import is the
    // failure this distinction exists to prevent.
    const merged = names.reduce<Record<string, Set<string>>>((acc, name) => {
        const module: RuntimeModule = RUNTIME[name];
        const specifier = map[module.from] ?? module.from;
        const key = `${module.typeOnly ? 'type' : 'value'} ${specifier}`;
        const symbols = acc[key] ?? new Set<string>();

        module.symbols.forEach(symbol => symbols.add(symbol));
        acc[key] = symbols;

        return acc;
    }, {});

    return Object.keys(merged)
        .sort()
        .map(key => {
            const [kind, ...rest] = key.split(' ');
            const specifier = rest.join(' ');

            return (
                `import ${kind === 'type' ? 'type ' : ''}{ ` +
                `${[...(merged[key] ?? [])].sort().join(', ')} } ` +
                `from '${specifier}';\n`
            );
        })
        .join('');
}
