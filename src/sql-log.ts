/*!
 * Cooperative SQL-log suppression
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

// The flag lives on a const wrapper rather than a `let` so there is no
// reassignable binding to import.
const state = { suppressed: false };

/**
 * Whether SQL logging is currently suppressed.
 *
 * @remarks
 * This is the read half of a cooperative protocol, and cooperative is the
 * operative word: nothing here intercepts logging. A query-log sink has to call
 * this and skip emitting while it answers `true`, and code that wants to run
 * quietly has to wrap itself in {@link silently}. A sink that does not check is
 * unaffected by either.
 *
 * Suppression is a single module-wide flag, not per-client or per-request, so it
 * suits one-off work that owns the process for its duration — startup DDL, a
 * migration, a maintenance script. Under concurrent traffic it will also silence
 * whatever else happens to be querying at the time.
 *
 * @returns `true` while a {@link silently} call is in progress.
 */
export function isSqlLogSuppressed(): boolean {
    return state.suppressed;
}

/**
 * Run `fn` with SQL logging suppressed.
 *
 * @remarks
 * The previous state is restored in a `finally`, so nesting works and a throw
 * still un-suppresses. What it does NOT do is scope the suppression to `fn`'s own
 * queries — the flag is module-wide, so anything else querying concurrently is
 * silenced for as long as `fn` runs.
 *
 * @param fn - Work to run while logging is suppressed.
 * @returns Whatever `fn` resolves to.
 * @example
 * ```typescript
 * await silently(() => client.$executeRawUnsafe(startupDdl));
 * ```
 */
export async function silently<T>(fn: () => Promise<T>): Promise<T> {
    const previous = state.suppressed;
    state.suppressed = true;
    try {
        return await fn();
    } finally {
        state.suppressed = previous;
    }
}
