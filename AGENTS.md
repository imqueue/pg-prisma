# AGENTS.md — orientation for coding agents

This file is for AI coding agents (and humans who like density) working on
`@imqueue/pg-prisma`. It captures how the codebase is built, tested and
structured, plus the invariants that are easy to get wrong. Read it before
making changes. For contribution *process/terms* see
[CONTRIBUTING.md](./CONTRIBUTING.md); for end-user docs see the
[README](./README.md) and https://imqueue.org/.

## What this is

`@imqueue/pg-prisma` is the Prisma Next (8.x) / Postgres persistence toolkit of
the @imqueue framework. It provides query middlewares that rewrite a statement
before it is lowered to SQL, and Postgres operational helpers.

There is no code generator. Prisma Next emits `contract.json`, and
`deriveDataLayer` reads the per-model configuration straight out of it, so
nothing is written to disk and nothing can drift from the schema.

## Toolchain & invariants (do not fight these)

- **ESM only**, `"type": "module"`. Use `import`, not `require()`. Import
  sibling modules with the **`.js`** extension (NodeNext resolves it to the
  `.ts` source), e.g. `import { silently } from './sql-log.js'`.
- **TypeScript, `module`/`moduleResolution: nodenext`**, `target: es2024`,
  `verbatimModuleSyntax: true`, `isolatedModules: true`, `strict: true`. Use
  `import type` / `import { type X }` for type-only imports.
- **Node ≥ 22.12. Prisma Next (8.x).**
- **`@prisma/orm-postgres` is a peer dependency.** The middlewares import AST
  constructors and types from **`@prisma/orm-postgres/relational-core/ast`**.
  That subpath resolves without emitting a contract, so this package needs no
  schema of its own to build. The single runtime dep is `pg`, for the audit
  trail's own pool. Do not add heavyweight deps.
- **Use the real AST types.** `AnyQueryAst` is a discriminated union on `kind`;
  narrowing on it gives `table`, `set`, `rows` and `returning` their proper
  types. A hand-rolled structural type here costs the one check that catches a
  mistake.
- **Lint/format:** `oxlint` + `oxfmt`. Run `npm run format` before committing;
  CI checks `npm run format:check`.
- Build **emits `.js`/`.d.ts`/`.js.map` next to sources**; these are
  **gitignored, not committed** (`build` runs `clean-compiled` first). Never
  commit compiled output.
- `removeComments` is intentionally **`false`** — downstream tooling and the
  generated output rely on doc-blocks surviving compilation. Keep it that way.

## Commands

```bash
npm install
npm run build          # clean-compiled + tsc (emits alongside sources)
npm test               # build + node:test over every test/**/*.spec.js
npm run lint           # oxlint
npm run format         # oxfmt (write)  |  npm run format:check (verify)
npm run test-coverage  # tests + experimental coverage summary
npm run test-lcov      # writes coverage/lcov.info
```

Unit tests (`test/**/*.spec.ts`, run compiled) cover the middlewares by
constructing AST nodes directly — no database is needed to assert what a
statement was rewritten into, and that is where the bugs have been. The
installer modules that touch a live database are exercised by the consuming
service's integration suite, not here.

## Layout

| Path | Role |
|---|---|
| `index.ts` | Public entry: `export * from './src/index.js'` |
| `src/index.ts` | Barrel re-exporting the public API |
| `src/ast.ts` | AST helpers; `filterSelects()` walks every select in a statement. |
| `src/derive.ts` | `deriveDataLayer()` — per-table config read from `contract.json`. |
| `src/data-layer.ts` | `dataLayer()` — the composed middleware array, in one call. |
| `src/stamp.ts` | Soft-delete and authorship, as one middleware. |
| `src/access-scope.ts` | Row-level access-scope middleware. |
| `src/audit.ts` | Audit-trail middleware, writing through its own pool. |
| `src/archive.ts` | Row-archiving installer (aged rows → mirror `archive` schema, pg_cron). |
| `src/change-notify.ts` | Postgres row-change `NOTIFY` trigger installer. |
| `src/pretty-sql.ts` | `prettifySql()` SQL pretty-printer for query logging. |
| `src/sql-log.ts` | Cooperative SQL-log suppression (`silently`, `isSqlLogSuppressed`). |
| `test/**` | `node:test` specs (`*.spec.ts`). |

## Behavioural invariants

- **Extension ordering matters.** In Prisma's query extensions the
  **first-added** extension's hook is the **outermost**. When composing `audit`
  with `softDelete`, add `audit` first so soft-deletes still reach the audit
  trail.
- **The generator's emitted code assumes consumer conventions.** It imports the
  consumer's generated modules via `#generated/*`, the client instance via
  `#prisma`, RPC decorators from `@imqueue/rpc`, and validation decorators from
  `@imqueue/validation`. Keep those import strings stable — they are the
  generator's output contract.
- **Filter the whole statement, never just its root.** Prisma Next compiles a
  relation read into one statement holding several selects. A predicate applied
  only to the outermost `from` returns the rows it was meant to exclude,
  through any `include`, with nothing logged. Use `filterSelects()`.
- **Qualify a column by the source's alias when it has one.** `TableSource`
  renders as `"public"."Session" AS "s"`, and a column qualified by the table
  name is then not in scope; Postgres rejects the statement.
- **Buffer audit rows per execution, not per client.** `onRow` runs inside an
  async generator, so concurrent statements on one client interleave at every
  row. A shared buffer lets one statement flush another's rows under the wrong
  actor — the worst failure a security trail has. Key by the plan object, and
  resolve the actor at the first row, inside that statement's async context.
- **`silently()` flips a shared module flag** — it is for pre-request one-offs
  (startup DDL), not interleaved concurrent traffic.

## License

GPL-3.0. Commercial licensing for closed-source products: https://imqueue.com/.
