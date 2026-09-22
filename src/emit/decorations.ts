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
 * The decorators a generated class carries, or none.
 *
 * @remarks
 * An @imqueue service publishes its types over the queue, and the client
 * generator reads them from `@classType`/`@property`; its inputs validate
 * themselves through `@validatable`/`@validate`. A service that is not an
 * @imqueue service - a REST API that validates at its own edge - has no use
 * for either, and decorators it does not use would tie its generated code to
 * a runtime it does not load. With `decorators: false` every one of these is
 * the empty string, and the classes are plain TypeScript.
 */
export interface Decorations {
    /** Whether anything is emitted at all. */
    readonly enabled: boolean;
    /** `@classType()`, on its own line. */
    classType(): string;
    /** `@validatable()`, on its own line. */
    validatable(): string;
    /** `@property(...)` for a member, indented. */
    property(wire: string, optional?: boolean): string;
    /** `@validate(...)` for a member, indented. */
    validate(expression: string): string;
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

const none = (): string => '';

/** Decorations as the generator has always written them, or none. */
export function decorations(enabled = true): Decorations {
    return enabled
        ? {
              enabled,
              classType: () => '@classType()\n',
              validatable: () => '@validatable()\n',
              property: (wire, optional = true) =>
                  `    @property(${quoted(wire)}${optional ? ', true' : ''})\n`,
              validate: expression => `    @validate(${expression})\n`,
          }
        : {
              enabled,
              classType: none,
              validatable: none,
              property: none,
              validate: none,
          };
}
