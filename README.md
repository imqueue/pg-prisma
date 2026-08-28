# @imqueue/pg-prisma

[![Build Status](https://img.shields.io/github/actions/workflow/status/imqueue/pg-prisma/build.yml)](https://github.com/imqueue/pg-prisma/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/@imqueue/pg-prisma)](https://www.npmjs.com/package/@imqueue/pg-prisma)
[![License](https://img.shields.io/badge/license-GPL-blue.svg)](https://github.com/imqueue/pg-prisma/blob/master/LICENSE)

A Prisma Next (8.x) / Postgres toolkit for Node.js & TypeScript back-ends — the
persistence helpers behind @imqueue framework services. It bundles a set of
Prisma Next query **middlewares** (soft-delete, authorship stamping, audit
trail, row-level access scope) that rewrite the statement before it is lowered
to SQL, plus Postgres operational helpers (row archiving, change-notify
triggers, SQL log formatting).

Their per-model configuration is **derived from the emitted `contract.json`**
rather than generated: Prisma Next has no custom-generator protocol and needs
none, since the contract already names every model, field and physical column.

**Documentation:** full guides, tutorial and API reference at
[imqueue.org](https://imqueue.org/). Commercial licensing & support for
closed-source products at [imqueue.com](https://imqueue.com/).

**Using an AI assistant?** Point it at [imqueue.org/llms.txt](https://imqueue.org/llms.txt)
for a machine-readable index of the docs, or see [AGENTS.md](./AGENTS.md). Current
version, licence and Node floor for every package:
[imqueue.org/status.json](https://imqueue.org/status.json).

**Related packages:**

- [@imqueue/core](https://github.com/imqueue/core) - Fast JSON message queue
  over Redis for inter-service communication.
- [@imqueue/rpc](https://github.com/imqueue/rpc) - RPC-like client/service
  implementation over @imqueue/core.
- [@imqueue/validation](https://github.com/imqueue/validation) - Zod-backed
  decorator validation (used by the generated model classes).

# Features

- **Soft delete and authorship** — a `DELETE` becomes a `deletedAt` stamp,
  stamped rows disappear from reads, and every write records who made it.
- **Access scope** — every read, update and delete is narrowed to the rows the
  caller may see, in the data layer rather than at each call site.
- **Audit trail** — every write to a nominated table recorded with the actor,
  the action and the row as the database returned it.
- **Row archiving** — aged rows moved into a mirror `archive` schema on a
  pg_cron schedule.
- **Change-notify triggers** — Postgres `NOTIFY` on every row change.

Filtering applies across the **whole statement**, not just its outermost
`FROM`. Prisma Next compiles a relation read into one statement holding several
selects, so a filter on the root alone would return soft-deleted and
out-of-scope rows through any `include`.

# Requirements

- Node.js >= 22.12
- `prisma` 8.x and `@prisma/orm-postgres` (peer dependency)
- PostgreSQL 15 or newer

# Install

```bash
npm i @imqueue/pg-prisma
```

# Usage

## The data layer, in one call

```typescript
import { dataLayer } from '@imqueue/pg-prisma';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './prisma/contract.d.ts';
import contractJson from './prisma/contract.json' with { type: 'json' };

const layer = dataLayer({
    contract: contractJson,
    scope: { Portfolio: { portfolio: ['id'] } },
    resolvers: { portfolio: () => currentPortfolioIds() },
    getActorId: currentActorId,
    audit: {
        connectionString: process.env.DATABASE_URL!,
        config: { table: 'AuditLog', columns: { /* ... */ } },
        getPrincipal: currentPrincipal,
    },
});

export const db = postgres<Contract>({
    contractJson,
    url: process.env.DATABASE_URL!,
    middleware: layer.middleware,
});
```

`dataLayer` returns the middlewares already composed. That is the point: a
caller never orders them, and so cannot order them wrongly. Call
`layer.close()` on shutdown to release the audit pool.

## Access scope

Scope is the one thing that cannot be derived from the contract — Prisma Next
has no schema-level annotation to carry it — so it is declared where
`dataLayer` is called, keyed by model and field:

```typescript
scope: {
    Portfolio: { portfolio: ['id'] },
    User:      { user: ['createdBy', 'id'] },
}
```

Columns **within** one level are OR-ed; levels are AND-ed together. A resolver
returning `undefined` leaves its level inactive, a value or array restricts,
and `null` or an empty array denies everything. Get the composition backwards
and the failure is a data leak rather than an error, so a `scope` naming a
model the contract does not define is a throw, not a silent no-op.

## Emitting the RPC model classes

Prisma Next emits `contract.d.ts`, which carries the types but not the
decorated classes. `@classType`/`@property` are what the
[@imqueue/rpc](https://github.com/imqueue/rpc) client generator reads, and an
undecorated type is dropped from the generated client with no error — so the
DTO classes are emitted here, from the same contract:

```typescript
import { emitModels, parseImportMap } from '@imqueue/pg-prisma';

await writeFile('src/generated/models.ts', emitModels({ contract }));
```

### Redirecting the runtime imports

By default the emitted file imports `@imqueue/rpc` directly. Pass `imports` to
point it somewhere else:

```typescript
emitModels({
    contract,
    imports: parseImportMap('@imqueue/rpc=@my-org/runtime'),
});
```

```typescript
// before
import { classType, property } from '@imqueue/rpc';

// after
import { classType, property } from '@my-org/runtime';
```

**Why this exists.** The decorators are only meaningful to the registry that
defined them, so `@imqueue/rpc`, `@imqueue/validation` and `zod` each have to
be a **single copy** shared with the service. A second copy fails silently
rather than loudly — a second decorator registry nothing reads, or a `ZodError`
that fails `instanceof`. The reliable way to guarantee one copy is for one
package to own the dependency and re-export it, with every service taking it
from there; redirecting the emitted imports is what makes that possible.

Redirecting several runtimes at one package merges them into a single
statement, rather than emitting the same specifier three times:

```typescript
parseImportMap(
    'zod=@base, @imqueue/rpc=@base, @imqueue/validation=@base',
);
// import { classType, property, validatable, validate, z } from '@base';
```

Redirecting a module the generator never emits throws rather than being
ignored, because the alternative is believing a redirection was applied while
the generated files still point at the original.

## Composing it yourself

`stamp`, `accessScope` and `audit` are exported individually for cases
`dataLayer` does not cover, and `deriveDataLayer` produces the config they take.
The middlewares commute — `stamp` merges what were two order-dependent Prisma 7
extensions — so there is no required order between them.

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
