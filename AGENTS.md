# AGENTS.md — orientation for coding agents

This file is for AI coding agents (and humans who like density) working on
`@imqueue/pg-prisma`. It captures how the codebase is built, tested and
structured, plus the invariants that are easy to get wrong. Read it before
making changes. For contribution *process/terms* see
[CONTRIBUTING.md](./CONTRIBUTING.md); for end-user docs see the
[README](./README.md) and https://imqueue.org/.

## What this is

`@imqueue/pg-prisma` is the Prisma/Postgres persistence toolkit of the @imqueue
framework. It provides Prisma client extensions, Postgres operational helpers,
and a Prisma generator that emits typed
[`@imqueue/rpc`](https://github.com/imqueue/rpc) model & repository classes.
The generated model classes validate their inputs with
[`@imqueue/validation`](https://github.com/imqueue/validation).

## Toolchain & invariants (do not fight these)

- **ESM only**, `"type": "module"`. Use `import`, not `require()`. Import
  sibling modules with the **`.js`** extension (NodeNext resolves it to the
  `.ts` source), e.g. `import { silently } from './sql-log.js'`.
- **TypeScript, `module`/`moduleResolution: nodenext`**, `target: es2024`,
  `verbatimModuleSyntax: true`, `isolatedModules: true`, `strict: true`. Use
  `import type` / `import { type X }` for type-only imports.
- **Node ≥ 22.12. Prisma 7+.**
- **`@prisma/client` is a peer dependency.** The extension modules import the
  `Prisma` namespace / `PrismaClient` type from **`@prisma/client/extension`** —
  the official entry for *shareable* Client extensions. It resolves without
  running `prisma generate` and works no matter where the consumer generates
  their client (default `@prisma/client` output or a custom output path), so
  this package needs no schema or generated client of its own to build. Runtime
  deps are kept minimal: `pg` (down-migrations) and `@prisma/generator-helper`
  (the generator). Do not add heavyweight deps.
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

Unit tests (`test/**/*.spec.ts`, run compiled) cover the pure helpers
(`prettifySql`, `accessWhere`). The extension and installer modules that touch a
live database are exercised by the consuming service's integration suite, not
here.

## Layout

| Path | Role |
|---|---|
| `index.ts` | Public entry: `export * from './src/index.js'` |
| `src/index.ts` | Barrel re-exporting the public API |
| `src/soft-delete.ts` | Prisma soft-delete query extension. |
| `src/audit.ts` | Prisma audit-trail query extension. |
| `src/authorship.ts` | Prisma authorship-stamping query extension. |
| `src/access-scope.ts` | `accessWhere()` row-level access-scope filter composer. |
| `src/archive.ts` | Row-archiving installer (aged rows → mirror `archive` schema, pg_cron). |
| `src/change-notify.ts` | Postgres row-change `NOTIFY` trigger installer. |
| `src/migrate-down.ts` | `migrateDown()` — undo applied Prisma migrations; also a CLI. |
| `src/pretty-sql.ts` | `prettifySql()` SQL pretty-printer for query logging. |
| `src/sql-log.ts` | Cooperative SQL-log suppression (`silently`, `isSqlLogSuppressed`). |
| `src/codegen.ts` | Prisma generator: emits typed `@imqueue/rpc` models & repositories. |
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
- **`migrateDown()` is side-effect-pure at import time.** The generator and the
  migrate-down CLI only run when their module is executed directly
  (`import.meta.url === argv[1]`); importing the package barrel must have no side
  effects and must not require the dev-only `@prisma/generator-helper`.
- **`silently()` flips a shared module flag** — it is for pre-request one-offs
  (startup DDL), not interleaved concurrent traffic.

## License

GPL-3.0. Commercial licensing for closed-source products: https://imqueue.com/.
