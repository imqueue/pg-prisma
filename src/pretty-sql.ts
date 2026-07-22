/*!
 * SQL pretty-printer for query logging
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
 * SQL keywords broken onto their own line. Multi-word / longer entries come
 * first so the regex alternation matches greedily (e.g. `LEFT JOIN` before
 * `JOIN`, `WITH RECURSIVE` before `WITH`).
 */
const KEYWORDS = [
    'WITH RECURSIVE',
    'WITH',
    'SELECT',
    'INSERT INTO',
    'UPDATE',
    'DELETE FROM',
    'FROM',
    'LEFT JOIN',
    'RIGHT JOIN',
    'INNER JOIN',
    'CROSS JOIN',
    'JOIN',
    'WHERE',
    'GROUP BY',
    'ORDER BY',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'RETURNING',
    'VALUES',
    'SET',
    'ON CONFLICT',
    'UNION ALL',
    'UNION',
    'AND',
    'OR',
];

const CLAUSE = new RegExp(`\\b(${KEYWORDS.join('|')})\\b`, 'gi');
/** Continuation clauses indented one level under the statement they belong to. */
const INDENT = /^(AND|OR|LEFT JOIN|RIGHT JOIN|INNER JOIN|CROSS JOIN|JOIN)\b/i;

/**
 * Format a one-line SQL string for readable logs: collapse whitespace,
 * upper-case and break before major keywords, and indent boolean/join
 * continuations. Purely cosmetic and best-effort — not a real SQL parser.
 */
export function prettifySql(sql: string): string {
    const broken = sql
        .replace(/\s+/g, ' ')
        .trim()
        .replace(CLAUSE, match => `\n${match.toUpperCase()}`);

    return broken
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => (INDENT.test(line) ? `  ${line}` : line))
        .join('\n');
}
