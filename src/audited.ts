/*!
 * @imqueue/pg-prisma — the tables a derivation records, by its relation map
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

/**
 * Internal, and not in the barrel.
 *
 * @remarks
 * `repositoriesFor` is handed the relation map alone, as every caller already
 * builds it, yet has to know which tables a trail records: their bulk writes
 * must return rows for the trail to see. The derivation that made the map
 * knows, so it says so here, keyed by the map it handed out.
 */
const AUDITED = new WeakMap<object, Readonly<Record<string, string>>>();

/**
 * Note the tables recorded alongside the relation map derived with them.
 *
 * @param relations - The relation map a derivation returned.
 * @param tables - Its audited tables, physical table to model.
 */
export function noteAudited(
    relations: object,
    tables: Readonly<Record<string, string>>,
): void {
    AUDITED.set(relations, tables);
}

/**
 * The tables recorded alongside a relation map, if a derivation made it.
 *
 * @param relations - The relation map a repository was given.
 * @returns Physical table to model, or undefined for a map built by hand.
 */
export function auditedWith(
    relations: object,
): Readonly<Record<string, string>> | undefined {
    return AUDITED.get(relations);
}
