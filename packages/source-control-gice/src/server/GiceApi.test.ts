import { assert, describe, it } from "@effect/vitest";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as GiceApi from "./GiceApi.ts";
import { fakeGiceServer, invalid, problem, type SentRequest } from "./GiceApi.testkit.ts";

const ask = (input: Omit<GiceApi.GiceApiRequest, "host" | "operation">) =>
  GiceApi.GiceApi.use((api) => api.request({ host: "code.example", operation: "test", ...input }));

describe("GiceApi", () => {
  it.effect("sends the token to the address it was issued for, and follows no redirect", () => {
    const { layer, sent } = fakeGiceServer({ "GET /user": { username: "alice" } });
    return Effect.gen(function* () {
      yield* ask({ path: "/user" });
      assert.deepStrictEqual(sent, [
        {
          method: "GET",
          url: "https://code.example/api/v1/user",
          path: "/user",
          authorization: "Bearer env-token",
          redirect: "manual",
          body: undefined,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails on a redirect rather than carrying the token on", () => {
    const { layer, sent } = fakeGiceServer({
      "GET /moved": new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/api/v1/user" },
      }),
    });
    return Effect.gen(function* () {
      const moved = yield* Effect.flip(ask({ path: "/moved" }));
      assert.strictEqual(moved.status, 302);
      assert.strictEqual(sent.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks nothing of a host it holds no token for", () => {
    const { layer, sent } = fakeGiceServer({});
    return Effect.gen(function* () {
      const stranger = yield* Effect.flip(
        GiceApi.GiceApi.use((api) =>
          api.request({ host: "elsewhere.example", operation: "test", path: "/user" }),
        ),
      );
      assert.deepStrictEqual([stranger.reason, stranger.status], ["missing-tool", null]);
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the gice login again after the server refuses its token", () => {
    const login = (token: string) => `{"host":"https://code.example","token":"${token}"}`;
    const files: Record<string, string> = { "/home/alice/.config/gice/config.json": login("old") };
    const { layer, sent } = fakeGiceServer(
      {
        "GET /user": (request: SentRequest) =>
          request.authorization === "Bearer new"
            ? { username: "alice" }
            : problem(401, "unauthorized", "invalid credentials"),
      },
      { env: {}, files },
    );
    return Effect.gen(function* () {
      yield* Effect.flip(ask({ path: "/user" }));
      files["/home/alice/.config/gice/config.json"] = login("new");
      yield* ask({ path: "/user" });
      assert.deepStrictEqual(
        sent.map((request) => request.authorization),
        ["Bearer old", "Bearer new"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("puts a repository's path below its /repos route", () => {
    const { layer, paths } = fakeGiceServer({ "GET /repos/acme/web/pulls/4": {} });
    return Effect.gen(function* () {
      yield* ask({ repository: "acme/web", path: "/pulls/4" });
      assert.deepStrictEqual(paths(), ["GET /repos/acme/web/pulls/4"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a repository that is not owner/name without asking", () => {
    const { layer, sent } = fakeGiceServer({});
    return Effect.gen(function* () {
      for (const repository of ["acme/web/../../user", "acme/..", "./web"]) {
        const error = yield* Effect.flip(ask({ repository, path: "" }));
        assert.deepStrictEqual(
          [error.reason, error.detail],
          ["failed", "Gice repositories are named owner/name."],
          repository,
        );
      }
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes Gice's own message on", () => {
    const { layer } = fakeGiceServer({
      "POST /repos/acme/web/pulls/4/merge": problem(
        409,
        "conflict",
        "pull request has merge conflicts",
      ),
    });
    return Effect.gen(function* () {
      const conflict = yield* Effect.flip(
        ask({ method: "POST", path: "/repos/acme/web/pulls/4/merge" }),
      );
      assert.deepStrictEqual(
        [conflict.status, conflict.reason, conflict.detail],
        [409, "failed", "pull request has merge conflicts"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { field: "body", limit: 65_536, detail: /at most 65,536 bytes, and characters/u },
    { field: "comments[0].body", limit: 65_536, detail: /at most 65,536 bytes, and characters/u },
    // A title is counted in characters, which Gice's own message says well enough.
    { field: "title", limit: 256, detail: /^title: is too long$/u },
  ])("explains Gice's limit on $field", ({ field, limit, detail }) => {
    const { layer } = fakeGiceServer({
      "POST /comments": invalid(`${field}: is too long`, { field, reason: "too_long", limit }),
    });
    return Effect.gen(function* () {
      const tooLong = yield* Effect.flip(ask({ method: "POST", path: "/comments" }));
      assert.match(tooLong.detail, detail);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { status: 401, code: "unauthorized", reason: "unauthenticated" },
    { status: 403, code: "forbidden", reason: "forbidden" },
    { status: 404, code: "not_found", reason: "not-found" },
    { status: 429, code: "rate_limited", reason: "rate-limited" },
    { status: 500, code: "internal", reason: "failed" },
  ] as const)("reads HTTP $status as $reason", ({ status, code, reason }) => {
    const { layer } = fakeGiceServer({ "GET /thing": problem(status, code, "refused") });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(ask({ path: "/thing" }));
      assert.deepStrictEqual([error.status, error.reason], [status, reason]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the status when the answer carries no message", () => {
    const { layer } = fakeGiceServer({ "GET /slow": new Response("slow down", { status: 503 }) });
    return Effect.gen(function* () {
      assert.strictEqual(
        (yield* Effect.flip(ask({ path: "/slow" }))).detail,
        "Gice answered HTTP 503.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a response that is not the JSON asked for", () => {
    const { layer } = fakeGiceServer({ "GET /user": { name: "alice" } });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        GiceApi.GiceApi.use((api) =>
          api.read(
            { host: "code.example", operation: "test", path: "/user" },
            Schema.Struct({ username: Schema.String }),
          ),
        ),
      );
      assert.deepStrictEqual(
        [error.reason, error.detail],
        ["failed", "Gice returned an unreadable response."],
      );
    }).pipe(Effect.provide(layer));
  });

  describe("a throttled server", () => {
    const throttled = () => {
      let answered = false;
      return fakeGiceServer({
        "GET /user": () => {
          if (answered) return { username: "alice" };
          answered = true;
          return problem(429, "rate_limited", "slow down", { "retry-after": "60" });
        },
        "POST /comments": {},
      });
    };

    it.effect("says when to try again", () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const error = yield* Effect.flip(ask({ path: "/user" }));
        assert.deepStrictEqual([error.reason, error.retryAt], ["rate-limited", now + 60_000]);
      }).pipe(Effect.provide(throttled().layer)),
    );

    it.effect("fails a read in the background at once until then, and asks again after", () => {
      const { layer, sent } = throttled();
      return Effect.gen(function* () {
        yield* Effect.flip(ask({ path: "/user" }));
        const paused = yield* Effect.flip(ask({ path: "/user" }));
        assert.deepStrictEqual([paused.reason, sent.length], ["rate-limited", 1]);
        yield* TestClock.adjust("60 seconds");
        yield* ask({ path: "/user" });
        assert.strictEqual(sent.length, 2);
      }).pipe(Effect.provide(layer));
    });

    it.effect("pauses the server however its host is spelled", () => {
      const { layer, sent } = fakeGiceServer(
        { "GET /user": problem(429, "rate_limited", "slow down", { "retry-after": "60" }) },
        { env: { GICE_HOST: "https://Code.Example:8443", GICE_TOKEN: "env-token" } },
      );
      return Effect.gen(function* () {
        yield* Effect.flip(ask({ path: "/user" }));
        const paused = yield* Effect.flip(
          GiceApi.GiceApi.use((api) =>
            api.request({ host: "code.example:8443", operation: "test", path: "/user" }),
          ),
        );
        assert.deepStrictEqual([paused.reason, sent.length], ["rate-limited", 1]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("still sends a write, or a read someone is waiting on", () => {
      const { layer, paths } = throttled();
      return Effect.gen(function* () {
        yield* Effect.flip(ask({ path: "/user" }));
        yield* ask({ method: "POST", path: "/comments" });
        yield* ask({ path: "/user" }).pipe(
          Effect.provideService(SourceControlRateLimit.Interactive, true),
        );
        assert.deepStrictEqual(paths(), ["GET /user", "POST /comments", "GET /user"]);
      }).pipe(Effect.provide(layer));
    });
  });
});
