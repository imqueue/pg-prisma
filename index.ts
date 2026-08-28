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
 * Prisma Next (8.x) and Postgres building blocks for `@imqueue` services.
 *
 * Two kinds of thing live here, and they are used at different times.
 *
 * Query middlewares rewrite the statement before it is lowered to SQL:
 * `stamp` turns deletes into `deletedAt` stamps, hides stamped rows and records
 * who created, updated or deleted a row; `accessScope` narrows every read to
 * the records the caller is allowed to see; and `audit` writes a trail of every
 * write to a table you nominate. `dataLayer` builds all three from an emitted
 * contract in one call and is the entry point for the ordinary case — the
 * individual factories are there to compose something it does not cover.
 *
 * Installers and tools run once at startup or by hand rather than per query:
 * `installArchiving` moves aged rows into a mirror `archive` schema on a
 * pg_cron schedule, `installChangeTriggers` makes Postgres `NOTIFY` on every
 * row change, and `prettifySql`/`silently`/`isSqlLogSuppressed` are
 * query-logging helpers.
 *
 * The per-model configuration is **derived from `contract.json`** by
 * `deriveDataLayer` rather than generated: Prisma Next has no custom-generator
 * protocol and needs none, since the contract already names every model, field
 * and physical column. Nothing is written to disk and nothing can go stale
 * against the schema. Access levels are the one thing that cannot be derived —
 * Prisma Next has no schema annotation to carry them — so they are declared
 * where `dataLayer` is called.
 *
 * The middlewares commute: `stamp` merges what were two order-dependent
 * Prisma 7 extensions, so there is no ordering left for a caller to get wrong.
 *
 * @packageDocumentation
 */

export * from './src/index.js';
