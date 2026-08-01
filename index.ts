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
 * Prisma and Postgres building blocks for `@imqueue` services.
 *
 * Two kinds of thing live here, and they are used at different times.
 *
 * Query extensions wrap a `PrismaClient` and change what queries do:
 * `softDelete` turns deletes into `deletedAt` stamps and hides stamped rows,
 * `accessScope` narrows every read to the records the caller is allowed to see,
 * `authorship` stamps who created, updated or deleted a row, `audit` writes a
 * trail of every write to a table you nominate, and `isoDates` serializes `Date`
 * values so they survive the RPC wire as ISO strings. Each is independent; each is
 * driven by a per-model config the code generator emits from your Prisma schema.
 *
 * Installers and tools run once at startup or by hand rather than per query:
 * `installArchiving` moves aged rows into a mirror `archive` schema on a pg_cron
 * schedule, `installChangeTriggers` makes Postgres `NOTIFY` on every row change,
 * `migrateDown` rolls applied migrations back (Prisma has no native "down"), and
 * `prettifySql`/`silently`/`isSqlLogSuppressed` are query-logging helpers.
 *
 * Ordering matters when extensions are combined, because Prisma runs the
 * first-added query hook outermost. `audit` has to be added first if it is to see
 * operations that `softDelete` reroutes; the individual pages say so where it
 * applies.
 *
 * The Prisma generator that emits typed `@imqueue/rpc` models from your schema
 * ships separately at `@imqueue/pg-prisma/codegen` and is invoked by Prisma, not
 * imported — it is deliberately absent from this barrel.
 *
 * @packageDocumentation
 */

export * from './src/index.js';
