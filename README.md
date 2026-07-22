# @imqueue/pg-prisma

[![License](https://img.shields.io/badge/license-GPL-blue.svg)](https://rawgit.com/imqueue/pg-prisma/master/LICENSE)

A Prisma/Postgres toolkit for Node.js & TypeScript back-ends — the persistence
helpers behind @imqueue framework services. It bundles a set of Prisma
[client extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions)
(soft-delete, audit trail, authorship stamping, row-level access scope), Postgres
operational helpers (row archiving, change-notify triggers, down-migrations, SQL
log formatting), and a Prisma generator that emits typed
[@imqueue/rpc](https://github.com/imqueue/rpc) model & repository classes.

**Documentation:** full guides, tutorial and API reference at
[imqueue.org](https://imqueue.org/). Commercial licensing & support for
closed-source products at [imqueue.com](https://imqueue.com/).

**Using an AI assistant?** Point it at [imqueue.org/llms.txt](https://imqueue.org/llms.txt)
for a machine-readable index of the docs, or see [AGENTS.md](./AGENTS.md).

**Related packages:**

- [@imqueue/core](https://github.com/imqueue/core) - Fast JSON message queue
  over Redis for inter-service communication.
- [@imqueue/rpc](https://github.com/imqueue/rpc) - RPC-like client/service
  implementation over @imqueue/core.
- [@imqueue/validation](https://github.com/imqueue/validation) - Zod-backed
  decorator validation (used by the generated model classes).

# Features

- **Soft-delete extension** — transparently excludes soft-deleted rows and turns
  deletes into `deletedAt` stamps.
- **Audit extension** — writes an append-only audit trail of INSERT/UPDATE/DELETE.
- **Authorship extension** — stamps `createdBy`/`updatedBy`/`deletedBy` from a
  caller-supplied actor id.
- **Access-scope helper** — `accessWhere(...)` composes row-level access filters
  (AND of per-level OR groups) onto any Prisma `where`.
- **Row archiving** — moves aged rows out of hot tables into a mirror `archive`
  schema on a pg_cron schedule (idempotent DB setup).
- **Change-notify triggers** — installs Postgres `NOTIFY` triggers for row
  changes.
- **Down-migrations** — `migrateDown()` undoes applied Prisma migrations (Prisma
  has no native "down").
- **SQL log helpers** — `prettifySql()` and cooperative log suppression.
- **Prisma generator** — emits typed `@imqueue/rpc` models, inputs, query types
  and repositories from your schema.
- **TypeScript included!**

# Requirements

- Node.js ≥ 22.12, PostgreSQL, and Prisma **7+**.
- `@prisma/client` is a **peer dependency** — the extensions import the `Prisma`
  namespace from `@prisma/client/extension` (the entry for shareable Client
  extensions), so they work whether you generate your client to the default
  `@prisma/client` output or to a custom path.
- Some Postgres features are optional: row archiving schedules via `pg_cron` when
  available (it degrades gracefully when the extension is absent).

# Install

```bash
npm i --save @imqueue/pg-prisma
```

# Usage

## Client extensions

```typescript
import { PrismaClient } from '@prisma/client';
import { softDelete, audit, authorship } from '@imqueue/pg-prisma';

// The FIRST-added extension is the OUTERMOST — keep `audit` first so that
// soft-deletes are still recorded in the audit trail.
const prisma = new PrismaClient()
    .$extends(audit({ /* ...config... */ }))
    .$extends(authorship({ /* ...config... */ }))
    .$extends(softDelete({ /* ...config... */ }));
```

## Access scope

```typescript
import { accessWhere } from '@imqueue/pg-prisma';

const where = accessWhere(
    callerWhere,
    { user: ['createdBy'], portfolio: ['portfolioId'] },
    { user: () => currentUserId, portfolio: () => allowedPortfolioIds },
);
```

## Prisma generator

The package ships a Prisma generator that emits typed `@imqueue/rpc` model and
repository classes. Point a generator block at it in your `schema.prisma`:

```prisma
generator imq {
  provider = "node ./node_modules/@imqueue/pg-prisma/src/codegen.js"
}
```

The generated code assumes your project defines the subpath import aliases
`#generated/*` and `#prisma` (your `PrismaClient` instance), and imports
validation decorators from `@imqueue/validation` and RPC decorators from
`@imqueue/rpc`. Install those alongside this package if you use the generator.

## Down-migrations

```bash
node --import tsx node_modules/@imqueue/pg-prisma/src/migrate-down.js \
  --database-url "$DATABASE_URL" --steps 1
```

## Running Unit Tests

Tests run on the native Node.js test runner (`node:test`) with `node:assert` and
no external test framework:

```bash
git clone git@github.com:imqueue/pg-prisma.git
cd pg-prisma
npm install
npm test
```

To produce a coverage report use:

```bash
npm run test-coverage        # prints coverage summary to the console
npm run test-lcov            # writes coverage/lcov.info
```

## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](LICENSE)
