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

/**
 * Cooperative SQL-log suppression. Self-contained (no external dependencies):
 * a query-log sink checks {@link isSqlLogSuppressed} before emitting, and any
 * code that must run quietly wraps itself in {@link silently}.
 *
 * It flips a shared module flag, so it is meant for pre-request one-offs (e.g.
 * startup DDL) rather than interleaved concurrent traffic. The flag lives on a
 * const wrapper so there is no reassignable binding.
 */
const state = { suppressed: false };

/** Whether SQL logging is currently suppressed — a log sink should skip while true. */
export function isSqlLogSuppressed(): boolean {
    return state.suppressed;
}

/** Run `fn` with SQL logging suppressed, restoring the previous state after. */
export async function silently<T>(fn: () => Promise<T>): Promise<T> {
    const previous = state.suppressed;
    state.suppressed = true;
    try {
        return await fn();
    } finally {
        state.suppressed = previous;
    }
}
