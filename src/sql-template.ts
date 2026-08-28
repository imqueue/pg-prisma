/*!
 * @imqueue/pg-prisma — composable SQL fragments
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
 * A statement and the values bound into it.
 *
 * @remarks
 * The placeholders are numbered from one across the whole statement, which is
 * what composition has to preserve: a fragment written on its own binds `$1`,
 * and the same fragment spliced third into another binds whatever comes next.
 */
export interface SqlFragment {
    /** The statement, with `$1`-style placeholders. */
    text: string;
    /** The values, in placeholder order. */
    values: unknown[];
}

/** Whether a value is a fragment rather than something to bind. */
function isFragment(value: unknown): value is SqlFragment {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as SqlFragment).text === 'string' &&
        Array.isArray((value as SqlFragment).values)
    );
}

/**
 * SQL as a tagged template, with everything interpolated bound.
 *
 * @remarks
 * This is what `Prisma.sql` was, and it exists for the same reason: a column
 * cannot be a bind parameter, so a query built from a caller's choices has to
 * be assembled — and assembling it by concatenation is how an injection gets
 * written. Everything interpolated is bound unless it is itself a fragment,
 * in which case it is spliced and its own placeholders renumbered.
 *
 * Use {@link raw} for the parts that genuinely cannot be bound, and read its
 * warning first.
 *
 * @param strings - The literal parts of the template.
 * @param values - What was interpolated between them.
 * @returns The statement and its values.
 * @example
 * ```typescript
 * const rows = await pool.query(
 *     ...toQuery(sql`SELECT * FROM "User" WHERE id = ${id}`),
 * );
 * ```
 */
export function sql(
    strings: TemplateStringsArray,
    ...values: unknown[]
): SqlFragment {
    const parts: string[] = [];
    const bound: unknown[] = [];

    strings.forEach((literal, at) => {
        parts.push(literal);

        if (at >= values.length) {
            return;
        }

        const value = values[at];

        if (isFragment(value)) {
            // Its placeholders are numbered from one; here they continue from
            // whatever this statement has bound so far.
            parts.push(
                value.text.replace(
                    /\$(\d+)/g,
                    (_, n: string) => `$${Number(n) + bound.length}`,
                ),
            );
            bound.push(...value.values);

            return;
        }

        bound.push(value);
        parts.push(`$${bound.length}`);
    });

    return { text: parts.join(''), values: bound };
}

/**
 * Text spliced in as written, binding nothing.
 *
 * @remarks
 * **The one way to write SQL from a value, and the only unsafe one.** Every
 * caller must be passing something from a closed set it controls — a column
 * name looked up in a map, a direction that is `ASC` or `DESC` — never a
 * string that reached it from outside.
 *
 * @param text - The SQL, spliced verbatim.
 * @returns A fragment binding nothing.
 */
export function raw(text: string): SqlFragment {
    return { text, values: [] };
}

/** A fragment that contributes nothing, for the empty case. */
export const EMPTY: SqlFragment = { text: '', values: [] };

/**
 * Several fragments, one after another.
 *
 * @param parts - The fragments to join.
 * @param separator - What goes between them. Defaults to `, `.
 * @returns One fragment, with its placeholders renumbered in order.
 * @example
 * ```typescript
 * sql`WHERE ${join(matches, ' OR ')}`;
 * ```
 */
export function join(
    parts: readonly SqlFragment[],
    separator = ', ',
): SqlFragment {
    return parts.reduce<SqlFragment>((all, part, at) => {
        const shifted = part.text.replace(
            /\$(\d+)/g,
            (_, n: string) => `$${Number(n) + all.values.length}`,
        );

        return {
            text: at === 0 ? shifted : `${all.text}${separator}${shifted}`,
            values: [...all.values, ...part.values],
        };
    }, EMPTY);
}

/**
 * A fragment as the pair `query` takes.
 *
 * @param fragment - The statement to run.
 * @returns The statement and its values, to spread into `query`.
 */
export function toQuery(fragment: SqlFragment): [string, unknown[]] {
    return [fragment.text, fragment.values];
}
