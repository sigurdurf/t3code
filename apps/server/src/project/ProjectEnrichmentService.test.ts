import { assert, it } from "@effect/vitest";
import { OrchestrationProjectShell, type RepositoryIdentity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectEnrichment from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const identity = (workspaceRoot: string, version = 1): RepositoryIdentity => ({
  canonicalKey: `example.test/v${version}${workspaceRoot}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://example.test/v${version}${workspaceRoot}.git`,
  },
  rootPath: workspaceRoot,
});

const waitForAvailable = Effect.fn("ProjectEnrichmentServiceTest.waitForAvailable")(function* (
  service: ProjectEnrichment.ProjectEnrichmentService["Service"],
  workspaceRoot: string,
  predicate: (value: ProjectEnrichment.ProjectEnrichment) => boolean,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* service.subscribeChanges;
      for (;;) {
        const available = yield* service.peek(workspaceRoot);
        if (predicate(available)) return available;
        yield* PubSub.take(changes);
      }
    }),
  );
});

const layer = (
  metadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
  options: ProjectEnrichment.ProjectEnrichmentServiceOptions = {},
) =>
  Layer.effect(ProjectEnrichment.ProjectEnrichmentService, ProjectEnrichment.make(options)).pipe(
    Layer.provide(metadataLayer),
  );

it.effect("publishes repository completion while favicon enrichment is still pending", () =>
  Effect.gen(function* () {
    const releaseFavicon = yield* Deferred.make<void>();
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: (workspaceRoot) =>
          Deferred.await(releaseFavicon).pipe(Effect.as(`${workspaceRoot}/favicon.svg`)),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      const changes = yield* service.subscribeChanges;
      yield* service.request("/completed");

      const change = yield* PubSub.take(changes);
      assert.equal(change.workspaceRoot, "/completed");
      assert.isTrue(change.repositoryIdentityResolved);
      assert.equal(change.enrichment.repositoryIdentity?.canonicalKey, "example.test/v1/completed");
      assert.isNull(change.enrichment.faviconPath);

      // A tracked folder asks for its identity alone, and that still queues the lookup.
      const unknown = yield* service.getAvailableRepositoryIdentity("/tracked");
      assert.isFalse(unknown.repositoryIdentityResolved);
      const tracked = yield* PubSub.take(changes);
      assert.equal(tracked.workspaceRoot, "/tracked");
      assert.equal(tracked.enrichment.repositoryIdentity?.canonicalKey, "example.test/v1/tracked");
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);

it.effect("keeps repository workers available when every favicon worker is hung", () =>
  Effect.gen(function* () {
    const faviconWorkersStarted = yield* Deferred.make<void>();
    const faviconStarts = yield* Ref.make(0);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () =>
          Effect.gen(function* () {
            const started = yield* Ref.updateAndGet(faviconStarts, (count) => count + 1);
            if (started === 2) {
              yield* Deferred.succeed(faviconWorkersStarted, undefined);
            }
            return yield* Effect.never;
          }),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.request("/favicon-hung-a");
      yield* service.request("/favicon-hung-b");
      yield* Deferred.await(faviconWorkersStarted);

      yield* service.request("/repository-later");
      const available = yield* waitForAvailable(
        service,
        "/repository-later",
        (value) => value.repositoryIdentity !== null,
      );

      assert.equal(available.repositoryIdentity?.canonicalKey, "example.test/v1/repository-later");
      assert.equal(yield* Ref.get(faviconStarts), 2);
    }).pipe(
      Effect.provide(
        layer(layerMetadata, {
          cacheCapacity: 8,
          maxPending: 4,
          concurrency: 2,
        }),
      ),
    );
  }),
);

it.effect(
  "reports successful cached null as resolved while cold and failed lookups stay unresolved",
  () =>
    Effect.gen(function* () {
      const repositoryStarted = yield* Deferred.make<void>();
      const releaseRepository = yield* Deferred.make<void>();
      const layerMetadata = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) => {
            if (workspaceRoot === "/no-remote") {
              return Effect.succeed(null);
            }
            if (workspaceRoot === "/fails") {
              return Effect.die("repository resolver failed");
            }
            return Deferred.succeed(repositoryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRepository)),
              Effect.as(identity(workspaceRoot)),
            );
          },
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          invalidate: () => Effect.void,
          resolvePath: () => Effect.succeed(null),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectEnrichment.ProjectEnrichmentService;
        const changes = yield* service.subscribeChanges;

        const cold = yield* service.peek("/never-requested");
        assert.isNull(cold.repositoryIdentity);
        assert.isFalse(cold.repositoryIdentityResolved);

        const inFlight = yield* service.getAvailable("/in-flight");
        assert.isNull(inFlight.repositoryIdentity);
        assert.isFalse(inFlight.repositoryIdentityResolved);
        yield* Deferred.await(repositoryStarted);
        assert.isFalse((yield* service.peek("/in-flight")).repositoryIdentityResolved);

        yield* service.request("/no-remote");
        const nullChange = yield* PubSub.take(changes);
        assert.equal(nullChange.workspaceRoot, "/no-remote");
        assert.isTrue(nullChange.repositoryIdentityResolved);
        assert.isNull(nullChange.enrichment.repositoryIdentity);
        assert.isTrue(nullChange.enrichment.repositoryIdentityResolved);

        const warmNull = yield* service.getAvailable("/no-remote");
        assert.isNull(warmNull.repositoryIdentity);
        assert.isTrue(warmNull.repositoryIdentityResolved);

        yield* service.request("/fails");
        const failChange = yield* PubSub.take(changes);
        assert.equal(failChange.workspaceRoot, "/fails");
        assert.isFalse(failChange.repositoryIdentityResolved);
        const failed = yield* service.peek("/fails");
        assert.isNull(failed.repositoryIdentity);
        assert.isFalse(failed.repositoryIdentityResolved);
      }).pipe(Effect.provide(layer(layerMetadata)));
    }),
);

it.effect("deduplicates requests, bounds pending work, and reloads invalidated roots", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const repositoryCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const version = yield* Ref.make(1);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Effect.gen(function* () {
            yield* Ref.update(repositoryCalls, (calls) => [...calls, workspaceRoot]);
            if (workspaceRoot === "/first" && (yield* Ref.get(version)) === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return identity(workspaceRoot, yield* Ref.get(version));
          }),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* Effect.forEach(Array.from({ length: 20 }), () => service.request("/first"), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Deferred.await(firstStarted);
      yield* service.request("/second");
      yield* service.request("/dropped");
      assert.deepEqual(yield* Ref.get(repositoryCalls), ["/first"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* waitForAvailable(service, "/second", (value) => value.repositoryIdentity !== null);
      assert.deepEqual(yield* Ref.get(repositoryCalls), ["/first", "/second"]);

      yield* service.request("/dropped");
      yield* waitForAvailable(service, "/dropped", (value) => value.repositoryIdentity !== null);
      assert.deepEqual(yield* Ref.get(repositoryCalls), ["/first", "/second", "/dropped"]);

      yield* Ref.set(version, 2);
      yield* service.invalidate(["/first"]);
      const invalidated = yield* service.getAvailable("/first");
      assert.isNull(invalidated.repositoryIdentity);
      const refreshed = yield* waitForAvailable(
        service,
        "/first",
        (value) => value.repositoryIdentity?.canonicalKey === "example.test/v2/first",
      );
      assert.equal(refreshed.repositoryIdentity?.canonicalKey, "example.test/v2/first");
      assert.deepEqual(yield* Ref.get(repositoryCalls), [
        "/first",
        "/second",
        "/dropped",
        "/first",
      ]);
    }).pipe(
      Effect.provide(
        layer(layerMetadata, {
          cacheCapacity: 8,
          maxPending: 2,
          concurrency: 1,
        }),
      ),
    );
  }),
);

it.effect(
  "keeps the last resolved repository identity after it expires and while it refreshes",
  () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const resolveCalls = yield* Ref.make(0);
      const layerMetadata = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) =>
            Effect.gen(function* () {
              if ((yield* Ref.updateAndGet(resolveCalls, (count) => count + 1)) > 1) {
                yield* Deferred.succeed(refreshStarted, undefined);
                yield* Deferred.await(releaseRefresh);
              }
              return identity(workspaceRoot);
            }),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          invalidate: () => Effect.void,
          resolvePath: () => Effect.succeed(null),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectEnrichment.ProjectEnrichmentService;
        const changes = yield* service.subscribeChanges;
        yield* service.request("/widgets");
        const resolved = yield* PubSub.take(changes);
        assert.equal(
          resolved.enrichment.repositoryIdentity?.canonicalKey,
          "example.test/v1/widgets",
        );

        yield* TestClock.adjust(Duration.seconds(61));

        const expired = yield* service.getAvailable("/widgets");
        assert.equal(
          expired.repositoryIdentity?.canonicalKey,
          "example.test/v1/widgets",
          "an expired repository identity should still be returned until a refresh replaces it",
        );

        yield* Deferred.await(refreshStarted);
        const refreshing = yield* service.peek("/widgets");
        assert.equal(
          refreshing.repositoryIdentity?.canonicalKey,
          "example.test/v1/widgets",
          "a repository identity should still be returned while its refresh is pending",
        );
      }).pipe(Effect.provide(layer(layerMetadata)));
    }),
);

it.effect("does not let a lookup invalidated mid-flight replace a newer last identity", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const resolveCalls = yield* Ref.make(0);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(resolveCalls, (count) => count + 1);
            if (call === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return identity(workspaceRoot, call);
          }),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      const firstLookup = yield* Effect.forkChild(service.readRepositoryIdentity("/widgets"));
      yield* Deferred.await(firstStarted);
      yield* service.invalidate(["/widgets"]);
      const newer = yield* service.readRepositoryIdentity("/widgets");
      assert.equal(newer?.canonicalKey, "example.test/v2/widgets");

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(firstLookup);
      yield* TestClock.adjust(Duration.seconds(61));

      const expired = yield* service.peek("/widgets");
      assert.equal(expired.repositoryIdentity?.canonicalKey, "example.test/v2/widgets");
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);

it.effect("keeps a lookup's identity when another root is invalidated mid-flight", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(identity(workspaceRoot)),
          ),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      const lookup = yield* Effect.forkChild(service.readRepositoryIdentity("/widgets"));
      yield* Deferred.await(started);
      yield* service.invalidate(["/other"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(lookup);
      yield* TestClock.adjust(Duration.seconds(61));

      const expired = yield* service.peek("/widgets");
      assert.equal(expired.repositoryIdentity?.canonicalKey, "example.test/v1/widgets");
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);

const PROJECT = Schema.decodeSync(OrchestrationProjectShell)({
  id: "project-1",
  title: "Workspace",
  workspaceRoot: "/workspace",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it.effect(
  "enriches a project shell with its root's and its tracked folders' available identities",
  () =>
    Effect.gen(function* () {
      const available: Record<string, ProjectEnrichment.ProjectEnrichment> = {
        "/workspace": {
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        },
        "/workspace/api": {
          repositoryIdentity: identity("/workspace/api"),
          faviconPath: null,
          repositoryIdentityResolved: true,
        },
        // Last known, not yet resolved again.
        "/workspace/docs": {
          repositoryIdentity: identity("/workspace/docs"),
          faviconPath: null,
          repositoryIdentityResolved: false,
        },
      };
      const availableFor = (workspaceRoot: string) =>
        Effect.succeed(
          available[workspaceRoot] ?? {
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          },
        );
      // Only the root's favicon is shown, so only the root may queue a favicon lookup.
      const withFavicon: Array<string> = [];
      const service = {
        getAvailable: (workspaceRoot: string) =>
          Effect.sync(() => withFavicon.push(workspaceRoot)).pipe(
            Effect.andThen(availableFor(workspaceRoot)),
          ),
        getAvailableRepositoryIdentity: availableFor,
      };

      const tracking = yield* ProjectEnrichment.enrichProjectShell(service, {
        ...PROJECT,
        trackedFolders: [
          { path: "/workspace/api", name: "api", discovered: true },
          { path: "/workspace/docs", name: "docs", discovered: true },
        ],
      });
      assert.deepStrictEqual(tracking.project.trackedRepositoryIdentities, [
        identity("/workspace/api"),
        identity("/workspace/docs"),
      ]);
      assert.deepStrictEqual(tracking.resolvedRoots, ["/workspace", "/workspace/api"]);
      assert.deepStrictEqual(withFavicon, ["/workspace"]);

      // A project with no tracked repositories sends no list, as an older server does.
      const single = yield* ProjectEnrichment.enrichProjectShell(service, PROJECT);
      assert.isFalse("trackedRepositoryIdentities" in single.project);
      assert.deepStrictEqual(single.resolvedRoots, ["/workspace"]);
    }),
);
