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

import type { RelationInfo, RelationMap } from './derive.js';
import {
    type Fields,
    type OrderBy,
    type Projection,
    type Select,
    type Where,
    toOrdering,
    toPredicate,
    toProjection,
} from './query.js';

/** A page of entities, and the total when one was asked for. */
export interface Page<Entity> {
    /** The rows on this page. */
    items: Entity[];
    /** The total matching rows, or null when it was not counted. */
    total: number | null;
}

/** Rows to insert against a relation, as a create input carries them. */
interface NestedCreate {
    create: object[];
}

/** How many rows a bulk write affected. */
export interface BulkCount {
    /** The affected row count. */
    count: number;
}

/** Paging and whether to count. */
export interface PageOptions {
    /** Rows to skip. */
    skip?: number;
    /** Rows to take. */
    take?: number;
    /** Count the matching rows as well as returning the page. */
    withTotal?: boolean;
}

/**
 * A model as a row that was read whole.
 *
 * @remarks
 * Every field of a generated model is optional, because a projected read
 * returns only what it asked for and the type has to describe both. A read
 * with no `select` returns all of them, and this is how a call site says so —
 * `single<RowOf<Shape>>({ where })` rather than a non-null assertion on each
 * field afterwards.
 *
 * It does not make a nullable column non-null: `deletedAt` stays
 * `string | null`, because that is the column and not the projection.
 */
export type RowOf<Model> = { [Field in keyof Model]-?: Model[Field] };

/**
 * The CRUD surface exposed for one model.
 *
 * @remarks
 * `Entity` is the model's own row type, which the generated `Repositories`
 * supplies — `Repository<Shape>` — so a call site reads a shape without
 * naming one. A read that projects something narrower still says so:
 * `single<{ id: string }>({ select: { id: true } })`.
 */
export interface Repository<Entity = unknown> {
    /** Insert a row and return it. */
    create<Row = Entity>(args: {
        input: object;
        select?: Select;
    }): Promise<Row>;
    /**
     * Insert many rows in one statement, and return them.
     *
     * @remarks
     * One `INSERT` rather than one per row, which is what makes copying a
     * table's worth of rows a single round trip. A nested relation is not
     * accepted here: the rows go in flat.
     */
    createBulk<Row = Entity>(args: {
        input: readonly object[];
        select?: Select | undefined;
    }): Promise<Row[]>;
    /** Update a row by id and return it. */
    update<Row = Entity, Input extends { id: string } = { id: string }>(args: {
        input: Input;
        select?: Select | undefined;
    }): Promise<Row>;
    /** The first row matching the filter, or null. */
    single<Row = Entity>(args: {
        where?: Where | undefined;
        select?: Select | undefined;
        orderBy?: OrderBy | undefined;
    }): Promise<Row | null>;
    /** A page of rows matching the filter. */
    list<Row = Entity>(args: {
        where?: Where | undefined;
        select?: Select | undefined;
        orderBy?: OrderBy | undefined;
        options?: PageOptions | undefined;
    }): Promise<Page<Row>>;
    /** How many rows match the filter. */
    count(args: { where?: Where | undefined }): Promise<number>;
    /**
     * Insert a row, or update the one already holding its key.
     *
     * @remarks
     * The key is the id unless `conflictOn` names another unique — a queue
     * keyed by `(portfolioId, kind, reference)` has no id to upsert on, and
     * reading first and then writing is a race the unique index would lose.
     */
    upsert<Row = Entity, Input extends object = Record<string, unknown>>(args: {
        input: Input;
        conflictOn?: readonly string[] | undefined;
        select?: Select | undefined;
    }): Promise<Row>;
    /** Apply the same change to every row matching the filter. */
    updateBulk(args: { where?: Where; input: object }): Promise<BulkCount>;
    /** Delete every row matching the filter. */
    removeBulk(args: { where?: Where }): Promise<BulkCount>;
}

/** The ORM collection this façade drives. */
interface Collection {
    where(predicate: unknown): Collection;
    select(...fields: string[]): Collection;
    include(name: string, branch: (b: Collection) => Collection): Collection;
    orderBy(by: (fields: Fields) => unknown): Collection;
    limit(n: number): Collection;
    offset(n: number): Collection;
    all(): Promise<unknown[]>;
    first(): Promise<unknown>;
    create(input: object): Promise<unknown>;
    update(input: object): Promise<unknown>;
    createAll(rows: readonly object[]): Promise<unknown[]>;
    upsert(args: {
        create: object;
        update: object;
        conflictOn?: Record<string, true>;
    }): Promise<unknown>;
    updateAndCount(input: object): Promise<number>;
    deleteAndCount(): Promise<number>;
    aggregate(
        build: (a: { count(): unknown }) => object,
    ): Promise<Record<string, number>>;
}

/** Everything {@link repositoriesFor} needs. */
export interface RepositoryOptions {
    /** Relations per model, from `deriveDataLayer`. */
    relations: RelationMap;
    /** Namespace the models live in. Defaults to `public`. */
    namespace?: string;
}

/** Apply a projection's scalar half and its relation branches. */
function project(query: Collection, projection?: Projection): Collection {
    if (!projection) {
        return query;
    }
    const selected =
        projection.fields.length > 0
            ? query.select(...projection.fields)
            : query;

    return projection.includes.reduce(
        (acc, one) =>
            acc.include(one.name, branch => project(branch, one.projection)),
        selected,
    );
}

/**
 * Build the CRUD façade the RPC surface delegates to.
 *
 * @remarks
 * Under Prisma 7 this was generated: five methods for every model, each
 * delegating to one of a handful of shared helpers — 800 lines of output that
 * said the same thing fourteen times. Prisma Next addresses every model
 * through the identical `db.orm.<ns>.<Model>` shape, so the façade is built at
 * run time from the contract instead, and there is nothing to regenerate when
 * a model is added.
 *
 * Models are reached by their lower-camel name, as the generated repository
 * exposed them: `repository.user`, `repository.roleInheritance`.
 *
 * Pass the emitted `Repositories` interface as the type argument to make
 * access total: without it every lookup is `Repository | undefined`, which is
 * noise at each of a service's call sites.
 *
 * @param db - The client, as returned by the `postgres()` factory.
 * @param options - Relations and the namespace to read.
 * @returns A repository per model, resolved on access.
 * @example
 * ```typescript
 * const repository = repositoriesFor(db, { relations });
 *
 * await repository.user.list<User>({ where: { active: { eq: true } } });
 * ```
 */
export function repositoriesFor<
    // `object`, not `Record<string, Repository>`: the emitted `Repositories`
    // is an interface with a fixed key per model, and an interface has no
    // index signature, so it can never satisfy a Record constraint.
    Repositories extends object = Record<string, Repository>,
>(
    db: {
        orm: Record<string, Record<string, Collection>>;
        transaction?: Transactional['transaction'];
    },
    { relations, namespace = 'public' }: RepositoryOptions,
): Repositories {
    const models = db.orm[namespace] ?? {};

    // A nested create is several inserts, so it has to commit as one. Already
    // inside a transaction the client has no `transaction` of its own and the
    // work is atomic regardless, so it runs inline.
    const atomically = <Result>(
        run: (orm: Record<string, Collection>) => Promise<Result>,
    ): Promise<Result> =>
        db.transaction
            ? db.transaction(tx => run(tx.orm[namespace] ?? {}))
            : run(models);
    const modelFor = (accessor: string): string =>
        accessor.charAt(0).toUpperCase() + accessor.slice(1);

    const repository = (
        model: string,
        scope: Record<string, Collection> = models,
    ): Repository => {
        const collection = (): Collection => scope[model] as Collection;
        const filtered = (where?: Where): Collection => {
            const predicate = toPredicate(relations, model, where);

            return predicate ? collection().where(predicate) : collection();
        };

        // A write returns every column unless it is told otherwise, so a
        // `select` that is dropped here hands the caller whatever the row
        // holds — a credential secret among it. Its RETURNING carries scalars
        // only (the ORM ignores an `include` on a write), so a select naming a
        // relation is satisfied by reading the row back once, which is what
        // Prisma 7 did behind `create({ select })`.
        const write = async (
            run: (query: Collection) => Promise<unknown>,
            select: Select | undefined,
        ): Promise<unknown> => {
            const projection = toProjection(relations, model, select);
            const scalars = projection?.includes.length
                ? []
                : (projection?.fields ?? []);
            const written = await run(
                scalars.length > 0
                    ? collection().select(...scalars)
                    : collection(),
            );

            if (!projection?.includes.length) {
                return written;
            }

            return project(
                collection().where({ id: (written as { id: string }).id }),
                projection,
            ).first();
        };

        return {
            async count(args: { where?: Where | undefined }): Promise<number> {
                // Through `list` rather than the ORM's own `count`, so the
                // middleware sees the same query shape a read would — a
                // count that ignored the soft-delete filter or the access
                // scope would answer about rows the caller cannot read.
                const { total } = await this.list<unknown>({
                    ...args,
                    options: { take: 0, withTotal: true },
                });

                return total ?? 0;
            },
            async createBulk<Entity>(args: {
                input: readonly object[];
                select?: Select | undefined;
            }): Promise<Entity[]> {
                if (args.input.length === 0) {
                    return [];
                }

                const projection = toProjection(relations, model, args.select);
                const scalars = projection?.includes.length
                    ? []
                    : (projection?.fields ?? []);

                return (await (
                    scalars.length > 0
                        ? collection().select(...scalars)
                        : collection()
                ).createAll(args.input)) as Entity[];
            },
            async create<Entity>(args: {
                input: object;
                select?: Select | undefined;
            }): Promise<Entity> {
                const nested = Object.entries(args.input).filter(
                    ([key, value]) =>
                        relations[model]?.[key]?.isList &&
                        Array.isArray((value as NestedCreate | null)?.create),
                );

                if (nested.length === 0) {
                    return (await write(
                        query => query.create(args.input),
                        args.select,
                    )) as Entity;
                }

                // Prisma Next rejects a relation key on an insert outright, so
                // the children are written separately — with the foreign key
                // the relation joins on taken from the row just created.
                const own = Object.fromEntries(
                    Object.entries(args.input).filter(
                        ([key]) => !relations[model]?.[key],
                    ),
                );

                return (await atomically(async orm => {
                    const parent = repository(model, orm);
                    const made = (await parent.create<Entity>({
                        input: own,
                    })) as Record<string, unknown>;

                    for (const [key, value] of nested) {
                        const relation = relations[model]?.[
                            key
                        ] as RelationInfo;
                        const link = Object.fromEntries(
                            relation.targetFields.map(
                                (field: string, index: number) => [
                                    field,
                                    made[relation.localFields[index] as string],
                                ],
                            ),
                        );

                        for (const child of (value as NestedCreate).create) {
                            await repository(relation.target, orm).create({
                                input: { ...child, ...link },
                            });
                        }
                    }

                    return args.select
                        ? ((await repository(model, orm).single<Entity>({
                              where: { id: made.id as string },
                              select: args.select,
                          })) as Entity)
                        : (made as Entity);
                })) as Entity;
            },
            async update<
                Entity,
                Input extends { id: string } = { id: string },
            >(args: {
                input: Input;
                select?: Select | undefined;
            }): Promise<Entity> {
                const { id, ...data } = args.input;

                return (await write(
                    query => query.where({ id }).update(data),
                    args.select,
                )) as Entity;
            },
            async single<Entity>(args: {
                where?: Where | undefined;
                select?: Select | undefined;
                orderBy?: OrderBy | undefined;
            }): Promise<Entity | null> {
                // Ordered where asked: "the first row matching" is only
                // meaningful once the order is stated, and the newest of
                // several matches is a common thing to want.
                const found = await toOrdering(args.orderBy)
                    .reduce(
                        (query, by) => query.orderBy(by),
                        project(
                            filtered(args.where),
                            toProjection(relations, model, args.select),
                        ),
                    )
                    .first();

                return (found ?? null) as Entity | null;
            },
            async list<Entity>(args: {
                where?: Where | undefined;
                select?: Select | undefined;
                orderBy?: OrderBy | undefined;
                options?: PageOptions | undefined;
            }): Promise<Page<Entity>> {
                const { skip, take, withTotal } = args.options ?? {};
                const base = filtered(args.where);
                const ordered = toOrdering(args.orderBy).reduce(
                    (query, by) => query.orderBy(by),
                    project(base, toProjection(relations, model, args.select)),
                );
                const paged = [
                    (query: Collection): Collection =>
                        skip === undefined ? query : query.offset(skip),
                    (query: Collection): Collection =>
                        take === undefined ? query : query.limit(take),
                ].reduce((query, step) => step(query), ordered);

                // Counted on the filter, not on the page: the total answers
                // "how many match", which paging must not narrow.
                const [items, total] = await Promise.all([
                    paged.all() as Promise<Entity[]>,
                    withTotal
                        ? base
                              .aggregate(a => ({ total: a.count() }))
                              .then(row => row.total ?? 0)
                        : Promise.resolve(null),
                ]);

                return { items, total };
            },
            async upsert<
                Entity,
                Input extends object = Record<string, unknown>,
            >(args: {
                input: Input;
                conflictOn?: readonly string[] | undefined;
                select?: Select | undefined;
            }): Promise<Entity> {
                const key = args.conflictOn ?? ['id'];

                // The key identifies the row; everything else is what an
                // existing row is updated to. Writing the key again on
                // conflict would be a no-op at best.
                const rest = Object.fromEntries(
                    Object.entries(args.input).filter(
                        ([field]) => !key.includes(field),
                    ),
                );

                // Keyed rather than blind, so a re-run updates the row it
                // created rather than adding a second — which is what makes a
                // seed safe to run on every start.
                return (await write(
                    query =>
                        query.upsert({
                            create: args.input,
                            update: rest,
                            ...(args.conflictOn
                                ? {
                                      conflictOn: Object.fromEntries(
                                          args.conflictOn.map(field => [
                                              field,
                                              true,
                                          ]),
                                      ),
                                  }
                                : {}),
                        }),
                    args.select,
                )) as Entity;
            },
            async updateBulk(args: {
                where?: Where;
                input: object;
            }): Promise<BulkCount> {
                return {
                    count: await filtered(args.where).updateAndCount(
                        args.input,
                    ),
                };
            },
            async removeBulk(args: { where?: Where }): Promise<BulkCount> {
                return { count: await filtered(args.where).deleteAndCount() };
            },
        };
    };

    return new Proxy({} as Repositories, {
        get: (_target, accessor: string): Repository =>
            repository(modelFor(accessor)),
        has: (_target, accessor: string): boolean =>
            modelFor(accessor) in models,
        ownKeys: (): string[] =>
            Object.keys(models).map(
                model => model.charAt(0).toLowerCase() + model.slice(1),
            ),
        getOwnPropertyDescriptor: () => ({
            enumerable: true,
            configurable: true,
        }),
    });
}

/** A client that can run work inside one transaction. */
export interface Transactional {
    transaction<Result>(
        run: (tx: {
            orm: Record<string, Record<string, Collection>>;
        }) => Promise<Result>,
    ): Promise<Result>;
}

/**
 * Repositories bound to a transaction.
 *
 * @remarks
 * Prisma Next has no nested writes — `create` rejects a relation key outright
 * — so anything that used to be one nested call is now several, and they have
 * to commit or roll back together. The callback's repositories run on the
 * transaction's connection; throwing from it rolls back.
 *
 * @param db - The client to open the transaction on.
 * @param options - The same options {@link repositoriesFor} takes.
 * @returns A function running work with transaction-bound repositories.
 * @example
 * ```typescript
 * const transaction = transactionFor<Repositories>(db, { relations });
 *
 * await transaction(async repository => {
 *     const user = await repository.user.create<User>({ input });
 *     await repository.credential.create({ input: { userId: user.id } });
 * });
 * ```
 */
export function transactionFor<Repositories extends object>(
    db: Transactional,
    options: RepositoryOptions,
): <Result>(
    run: (repository: Repositories) => Promise<Result>,
) => Promise<Result> {
    return <Result>(
        run: (repository: Repositories) => Promise<Result>,
    ): Promise<Result> =>
        db.transaction(tx => run(repositoriesFor<Repositories>(tx, options)));
}
