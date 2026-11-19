import { assert, describe, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GiceApi from "./GiceApi.ts";
import * as GiceCredentials from "./GiceCredentials.ts";
import * as GiceSourceControlProvider from "./GiceSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly redirect: RequestRedirect | undefined;
  readonly body: unknown;
}

type Route = unknown | Response | ((request: SentRequest) => unknown);

const SSH_REMOTE = "ssh://git@code.example:2222/acme/web.git";
const context = {
  provider: { kind: SourceControlProviderKind.make("gice"), name: "Gice", baseUrl: "" },
  remoteName: "origin",
  remoteUrl: SSH_REMOTE,
};

const repository = {
  full_name: "acme/web",
  default_branch: "main",
  clone_url_http: "https://code.example/acme/web.git",
  clone_url_ssh: "ssh://git@code.example:2222/acme/web.git",
};

const pull = (fields: Record<string, unknown>) => ({
  number: 4,
  title: "Add feature",
  state: "open",
  head: "feature",
  base: "main",
  head_repo: { owner: "acme", name: "web", full_name: "acme/web" },
  cross_repo: false,
  updated_at: "2026-03-04T05:06:07.123456789Z",
  closed_at: null,
  merged_at: null,
  ...fields,
});

/** A server on code.example, a name that says nothing, known by GICE_HOST and GICE_TOKEN. */
function fakeGice(
  routes: Record<string, Route>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly git?: Partial<SourceControlHost.SourceControlHost["Service"]["git"]>;
  } = {},
) {
  const sent: Array<SentRequest> = [];
  const client = HttpClient.make((request, _url, _signal, fiber) => {
    const url = new URL(request.url);
    const entry: SentRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      body:
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined,
    };
    const key = `${entry.method} ${url.pathname}`;
    // Every lookup first asks what the server can do; this one predates `features` unless told.
    const meta = key === "GET /api/v1/meta";
    if (!meta) sent.push(entry);
    const route = meta && !(key in routes) ? {} : routes[key];
    const answer = typeof route === "function" ? route(entry) : route;
    const response =
      answer === undefined
        ? new Response(encodeJson({ error: { code: "not_found", message: "not found" } }), {
            status: 404,
          })
        : answer instanceof Response
          ? answer
          : new Response(encodeJson(answer));
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = Layer.merge(
    GiceApi.layer,
    FileSystem.layerNoop({
      readFileString: (path) =>
        path === "/tmp/body.md" ? Effect.succeed("Body") : Effect.die(path),
    }),
  ).pipe(
    Layer.provideMerge(GiceCredentials.layer),
    Layer.provideMerge(TestSourceControlHost.layer(options.git ? { git: options.git } : {})),
    Layer.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed("{}") })),
    Layer.provide(
      Layer.succeed(
        HostProcess.Environment,
        options.env ?? { GICE_HOST: "https://code.example", GICE_TOKEN: "env-token" },
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { layer, sent };
}

const problem = (status: number, code: string, message: string) =>
  new Response(encodeJson({ error: { code, message } }), { status });

describe("GiceApi", () => {
  it.effect("sends the token only to the server it was issued for, without redirects", () => {
    const { layer, sent } = fakeGice({
      "GET /api/v1/user": { username: "alice" },
      "GET /api/v1/moved": new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/api/v1/user" },
      }),
    });
    return Effect.gen(function* () {
      const api = yield* GiceApi.GiceApi;
      yield* api.request({ host: "code.example", operation: "test", path: "/user" });
      assert.deepStrictEqual(sent[0], {
        method: "GET",
        url: "https://code.example/api/v1/user",
        authorization: "Bearer env-token",
        redirect: "manual",
        body: undefined,
      });

      const moved = yield* Effect.flip(
        api.request({ host: "code.example", operation: "test", path: "/moved" }),
      );
      assert.strictEqual(moved.status, 302);
      assert.strictEqual(sent.length, 2);

      const stranger = yield* Effect.flip(
        api.request({ host: "elsewhere.example", operation: "test", path: "/user" }),
      );
      assert.strictEqual(stranger.reason, "unauthenticated");
      assert.isNull(stranger.status);
      assert.strictEqual(sent.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads Gice's error body and tells sign-out, absence and throttling apart", () => {
    const { layer } = fakeGice({
      "POST /api/v1/repos/acme/web/pulls/4/merge": problem(
        409,
        "conflict",
        "pull request has merge conflicts",
      ),
      "GET /api/v1/user": problem(401, "unauthorized", "invalid credentials"),
      "GET /api/v1/slow": new Response("slow down", { status: 429 }),
    });
    return Effect.gen(function* () {
      const api = yield* GiceApi.GiceApi;
      const fail = (method: "GET" | "POST", path: string) =>
        Effect.flip(api.request({ host: "code.example", operation: "test", method, path }));
      const conflict = yield* fail("POST", "/repos/acme/web/pulls/4/merge");
      assert.deepStrictEqual(
        [conflict.status, conflict.reason, conflict.code, conflict.detail],
        [409, "failed", "conflict", "pull request has merge conflicts"],
      );
      assert.strictEqual((yield* fail("GET", "/user")).reason, "unauthenticated");
      assert.strictEqual((yield* fail("GET", "/repos/acme/gone")).reason, "not-found");
      const throttled = yield* fail("GET", "/slow");
      assert.deepStrictEqual(
        [throttled.reason, throttled.code, throttled.detail],
        ["rate-limited", null, "Gice answered HTTP 429."],
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("GiceSourceControlProvider discovery", () => {
  it.effect("reports the signed-in account and claims remotes on a signed-in server", () => {
    const { layer } = fakeGice({ "GET /api/v1/user": { username: "alice" } });
    return Effect.gen(function* () {
      const discovery = yield* GiceSourceControlProvider.makeDiscovery;
      const item = yield* discovery.probe();
      assert.strictEqual(item.status, "available");
      assert.strictEqual(item.auth.status, "authenticated");
      assert.deepStrictEqual(item.auth.account, Option.some("alice"));
      assert.deepStrictEqual(item.auth.host, Option.some("code.example"));

      assert.deepStrictEqual(yield* discovery.refineUnknownRemote({ cwd: "/repo", context }), {
        kind: "gice",
        name: "Gice",
        baseUrl: "https://code.example",
      });
      assert.isNull(
        yield* discovery.refineUnknownRemote({
          cwd: "/repo",
          context: { ...context, remoteUrl: "git@other.example:acme/web.git" },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a refused token apart from a server that cannot answer", () => {
    const answers = [
      problem(401, "unauthorized", "invalid credentials"),
      problem(500, "internal", "internal error"),
    ];
    const { layer } = fakeGice({ "GET /api/v1/user": () => answers.shift() });
    return Effect.gen(function* () {
      const discovery = yield* GiceSourceControlProvider.makeDiscovery;
      assert.strictEqual((yield* discovery.probe()).auth.status, "unauthenticated");
      assert.strictEqual((yield* discovery.probe()).auth.status, "unknown");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks no server when no credential names one", () => {
    const { layer, sent } = fakeGice({}, { env: {} });
    return Effect.gen(function* () {
      const discovery = yield* GiceSourceControlProvider.makeDiscovery;
      assert.strictEqual((yield* discovery.probe()).auth.status, "unauthenticated");
      assert.isNull(yield* discovery.refineUnknownRemote({ cwd: "/repo", context }));
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  });
});

describe("GiceSourceControlProvider", () => {
  it.effect("finds a branch's pull requests on the web host of an SSH remote", () => {
    const { layer, sent } = fakeGice({
      "GET /api/v1/repos/acme/web/pulls": [
        pull({ number: 9, head: "other" }),
        pull({ number: 5 }),
        pull({
          number: 4,
          // The server's own word for its page, which a sub-path or plain HTTP would change.
          html_url: "http://code.example/git/acme/web/pulls/4",
          cross_repo: true,
          head_repo: { owner: "Bob", name: "web", full_name: "Bob/web" },
        }),
      ],
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const own = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "open",
      });
      assert.deepStrictEqual(
        own.map((item) => [item.number, item.url, item.isCrossRepository]),
        [
          [5, "https://code.example/acme/web/pulls/5", false],
          [4, "http://code.example/git/acme/web/pulls/4", true],
        ],
      );
      assert.strictEqual(
        sent[0]?.url,
        "https://code.example/api/v1/repos/acme/web/pulls?state=open&per_page=100&page=1",
      );
      const forked = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "bob:feature",
        state: "all",
      });
      assert.deepStrictEqual(
        forked.map((item) => [item.number, item.headRepositoryNameWithOwner]),
        [[4, "Bob/web"]],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks an upgraded server for the branch alone, within a minute of the upgrade", () => {
    let features: ReadonlyArray<string> | undefined;
    const { layer, sent } = fakeGice({
      "GET /api/v1/meta": () => ({ registration: true, features }),
      "GET /api/v1/repos/acme/web/pulls": [
        pull({ number: 5, draft: true, head_sha: "21723f23022029e1ce4a03f0465998d7a48de838" }),
      ],
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const find = (headSelector: string) =>
        provider.listChangeRequests({ cwd: "/repo", context, headSelector, state: "open" });
      yield* find("feature");
      features = ["pull_filters"];
      yield* find("feature");
      yield* TestClock.adjust("1 minute");
      const [found] = yield* find("feature");
      yield* find("bob:feature");
      assert.deepStrictEqual(
        sent.map((request) => new URL(request.url).search),
        [
          "?state=open&per_page=100&page=1",
          "?state=open&per_page=100&page=1",
          "?state=open&per_page=100&page=1&head=feature&fields=summary",
          "?state=open&per_page=100&page=1&head=bob%3Afeature&fields=summary",
        ],
      );
      assert.deepStrictEqual(
        [found?.isDraft, found?.headSha],
        [true, "21723f23022029e1ce4a03f0465998d7a48de838"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the fork only when a pull request's head is in another repository", () => {
    const { layer, sent } = fakeGice({
      "POST /api/v1/repos/acme/web/pulls": () =>
        new Response(encodeJson(pull({})), { status: 201 }),
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const create = (headSelector: string) =>
        provider.createChangeRequest({
          cwd: "/repo",
          context,
          baseRefName: "main",
          headSelector,
          title: "Add feature",
          bodyFile: "/tmp/body.md",
        });
      yield* create("feature");
      yield* create("Acme:feature");
      yield* create("bob:feature");
      const body = { title: "Add feature", body: "Body", head: "feature", base: "main" };
      assert.deepStrictEqual(
        sent.map((request) => request.body),
        [body, body, { ...body, head_repo: "bob/web" }],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a repository on the signed-in server and hands back its clone URLs", () => {
    const { layer, sent } = fakeGice({
      "POST /api/v1/user/repos": { ...repository, full_name: "alice/web", clone_url_ssh: "" },
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const created = yield* provider.createRepository({
        cwd: "/new",
        repository: "alice/web",
        visibility: "private",
      });
      assert.deepStrictEqual(sent[0]?.body, { name: "web", is_private: true });
      assert.strictEqual(sent[0]?.url, "https://code.example/api/v1/user/repos");
      // A server with SSH off has only the HTTP clone URL.
      assert.deepStrictEqual(created, {
        nameWithOwner: "alice/web",
        url: repository.clone_url_http,
        sshUrl: repository.clone_url_http,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("checks out a fork's pull request from the head ref the base repository keeps", () => {
    const git: Array<ReadonlyArray<string>> = [];
    const { layer } = fakeGice(
      {
        "GET /api/v1/repos/acme/web/pulls/4": pull({
          cross_repo: true,
          head_repo: { owner: "bob", name: "web", full_name: "bob/web" },
        }),
      },
      {
        git: {
          listLocalBranchNames: () => Effect.succeed(["main"]),
          execute: (input) => {
            git.push(input.args);
            return Effect.succeed({
              exitCode: TestSourceControlHost.processOutput("").exitCode,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
          createBranch: (input) => {
            git.push(["branch", input.branch, input.startPoint]);
            return Effect.void;
          },
          switchRef: (input) => {
            git.push(["switch", input.refName]);
            return Effect.succeed({ refName: input.refName });
          },
        },
      },
    );
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      yield* provider.checkoutChangeRequest({ cwd: "/repo", context, reference: "#4" });
      assert.deepStrictEqual(git, [
        ["fetch", "origin", "refs/pull/4/head"],
        ["branch", "pr-4", "FETCH_HEAD"],
        ["switch", "pr-4"],
      ]);
    }).pipe(Effect.provide(layer));
  });
});
