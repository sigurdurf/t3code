import { assert, describe, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  encodeJson,
  fakeGiceServer,
  HEAD_SHA,
  issue,
  problem,
  pull,
  pullSummary,
  repository as repositoryOf,
  type SentRequest,
  template,
  user,
} from "./GiceApi.testkit.ts";
import * as GiceSourceControlProvider from "./GiceSourceControlProvider.ts";

const SSH_REMOTE = "ssh://git@code.example:2222/acme/web.git";
const context = {
  provider: { kind: SourceControlProviderKind.make("gice"), name: "Gice", baseUrl: "" },
  remoteName: "origin",
  remoteUrl: SSH_REMOTE,
};
const repository = repositoryOf("acme/web");
const meta = (fields: Record<string, unknown> = {}) => ({
  applications: false,
  email: false,
  features: ["labels", ...GiceSourceControlProvider.REQUIRED_FEATURES],
  site: { version: "e952f00661b1" },
  ssh: { host: "code.example", port: 2222 },
  ...fields,
});
const signedIn = {
  "GET /user": { ...user("alice"), email: "alice@example.com" },
  "GET /meta": meta(),
};
const discovery = GiceSourceControlProvider.makeDiscovery;
type Discovery = Effect.Success<typeof discovery>;
const refineWith = (spec: Discovery) => (remoteUrl: string) =>
  spec.refineUnknownRemote({ cwd: "/repo", context: { ...context, remoteUrl } });
const refine = (remoteUrl: string) =>
  discovery.pipe(Effect.flatMap((spec) => refineWith(spec)(remoteUrl)));

describe("GiceSourceControlProvider discovery", () => {
  it.effect("reports the signed-in account and the server's version", () =>
    Effect.gen(function* () {
      const { version, ...auth } = yield* (yield* discovery).probeAuth;
      assert.strictEqual(version, "e952f00661b1");
      assert.deepStrictEqual(
        [auth.status, auth.account, auth.host],
        ["authenticated", Option.some("alice"), Option.some("code.example")],
      );
      assert.deepStrictEqual(auth.accounts, [
        { host: "code.example", account: "alice", active: true, authenticated: true },
      ]);
    }).pipe(Effect.provide(fakeGiceServer(signedIn).layer)),
  );

  it.effect("claims a remote on a server it holds a token for, and no other", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* refine(SSH_REMOTE), {
        kind: "gice",
        name: "Gice",
        baseUrl: "https://code.example",
      });
      assert.isNull(yield* refine("git@other.example:acme/web.git"));
    }).pipe(Effect.provide(fakeGiceServer(signedIn).layer)),
  );

  it.effect.each([
    {
      name: "a refused token",
      user: problem(401, "unauthorized", "invalid credentials"),
      meta: meta(),
      status: "unauthenticated",
      detail:
        "Gice refused the token for code.example. Replace it in Settings, or run `gice auth login --host https://code.example`.",
    },
    {
      name: "a server that cannot answer",
      user: problem(500, "internal", "internal error"),
      meta: meta(),
      status: "unknown",
      detail: "internal error",
    },
    {
      name: "a server too old for T3 Code",
      user: user("alice"),
      // The release before the one T3 Code needs.
      meta: meta({ features: ["labels", "pull_files_no_patch"] }),
      status: "unknown",
      detail:
        "The Gice server at code.example is too old for T3 Code. Update Gice on that server, then refresh.",
    },
    {
      name: "a server without one feature T3 Code uses, whatever else it lists",
      user: user("alice"),
      meta: meta({
        features: [
          ...GiceSourceControlProvider.REQUIRED_FEATURES.filter(
            (feature) => feature !== "pull_viewed_files",
          ),
          "device_flow",
        ],
      }),
      status: "unknown",
      detail:
        "The Gice server at code.example is too old for T3 Code. Update Gice on that server, then refresh.",
    },
  ])("tells $name apart", ({ user: answer, meta: features, status, detail }) =>
    Effect.gen(function* () {
      const auth = yield* (yield* discovery).probeAuth;
      assert.deepStrictEqual([auth.status, auth.detail], [status, Option.some(detail)]);
    }).pipe(Effect.provide(fakeGiceServer({ "GET /user": answer, "GET /meta": features }).layer)),
  );

  it.effect("reports every server it holds a token for, each asked with its own token", () => {
    const { layer, sent } = fakeGiceServer({
      "GET /user": (request: SentRequest) =>
        user(new URL(request.url).host === "old.example" ? "bob" : "alice"),
      "GET /meta": (request: SentRequest) =>
        meta(
          new URL(request.url).host === "old.example"
            ? { features: ["labels", "issue_mentioned_filter"] }
            : {},
        ),
    });
    return Effect.gen(function* () {
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({
        sourceControlHosts: {
          gice: {
            tokens: { "old.example": "old-token", "off.example": "off-token" },
            hosts: { "off.example": { enabled: false } },
          },
        },
      });
      const auth = yield* (yield* discovery).probeAuth;
      // A server turned off is asked nothing, but keeps a row Settings can turn it back on from.
      assert.deepStrictEqual(
        auth.accounts?.map((entry) => [entry.host, entry.authenticated]),
        [
          ["code.example", true],
          ["off.example", false],
        ],
      );
      assert.deepStrictEqual(
        [auth.status, auth.host, auth.account, auth.detail],
        [
          "authenticated",
          Option.some("code.example"),
          Option.some("alice"),
          Option.some(
            "The Gice server at old.example is too old for T3 Code. Update Gice on that server, then refresh.",
          ),
        ],
      );
      assert.deepStrictEqual(
        new Set(sent.map((request) => `${new URL(request.url).host} ${request.authorization}`)),
        new Set(["old.example Bearer old-token", "code.example Bearer env-token"]),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks no server when no credential names one", () => {
    const { layer, sent } = fakeGiceServer({}, { env: {} });
    return Effect.gen(function* () {
      assert.strictEqual((yield* (yield* discovery).probeAuth).status, "unauthenticated");
      assert.isNull(yield* refine(SSH_REMOTE));
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  });
});

describe("GiceSourceControlProvider SSH hosts", () => {
  const sshServer = () =>
    fakeGiceServer({ "GET /meta": meta({ ssh: { host: "SSH.Example", port: 22 } }) });
  const SSH_ELSEWHERE = "ssh://git@ssh.example:2222/acme/web.git";

  it.effect("finds the server of a remote on its SSH host, whatever the port, asking once", () => {
    const { layer, sent } = sshServer();
    return Effect.gen(function* () {
      const refine = refineWith(yield* discovery);
      const server = { kind: "gice", name: "Gice", baseUrl: "https://code.example" };
      assert.deepStrictEqual(yield* refine(SSH_ELSEWHERE), server);
      assert.deepStrictEqual(yield* refine("git@ssh.example:acme/other.git"), server);
      assert.strictEqual(sent.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets no SSH host stand in for the web host of an HTTPS remote", () =>
    Effect.gen(function* () {
      assert.isNull(yield* refine("https://ssh.example/acme/web.git"));
      assert.isNull(yield* refine("git@elsewhere.example:acme/web.git"));
    }).pipe(Effect.provide(sshServer().layer)),
  );

  it.effect("leaves a remote unknown while its server cannot answer, and asks again later", () => {
    const answers = [
      problem(500, "internal", "internal error"),
      meta({ ssh: { host: "ssh.example", port: 22 } }),
    ];
    const { layer, sent } = fakeGiceServer({ "GET /meta": () => answers.shift() });
    return Effect.gen(function* () {
      const refine = refineWith(yield* discovery);
      yield* Effect.flip(refine(SSH_ELSEWHERE));
      yield* Effect.flip(refine(SSH_ELSEWHERE));
      assert.strictEqual(sent.length, 1);
      yield* TestClock.adjust("30 seconds");
      assert.isNotNull(yield* refine(SSH_ELSEWHERE));
    }).pipe(Effect.provide(layer));
  });

  const resolveContextWith = (spec: Discovery) => (input: { readonly context: typeof context }) =>
    refineWith(spec)(input.context.remoteUrl).pipe(
      Effect.map((found) => (found ? { ...input.context, provider: found } : input.context)),
      Effect.orDie,
    );

  it.effect("names the web host of a remote on the SSH host", () =>
    Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      assert.strictEqual(
        yield* provider.resolveRemoteWebHost!({
          cwd: "/repo",
          context: { ...context, remoteUrl: SSH_ELSEWHERE },
          resolveContext: resolveContextWith(yield* discovery),
        }),
        "code.example",
      );
    }).pipe(Effect.provide(sshServer().layer)),
  );

  it.effect("gives a checkout on the SSH host its web address", () =>
    Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const seenContexts: Array<typeof context> = [];
      const resolve = resolveContextWith(yield* discovery);
      const identity = yield* provider.refineRepositoryIdentity!({
        identity: {
          canonicalKey: "ssh.example/acme/web",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: SSH_ELSEWHERE },
          rootPath: "/repo",
          provider: SourceControlProviderKind.make("unknown"),
        },
        resolveContext: (input) => {
          seenContexts.push(input.context);
          return resolve(input);
        },
      });
      assert.deepStrictEqual(
        [identity.provider, identity.webUrl],
        ["gice", "https://code.example/acme/web"],
      );
      // Matches Forgejo after unknownRemoteProvider so unknown-remote caching keys on the host.
      assert.deepStrictEqual(seenContexts[0]?.provider, {
        kind: "unknown",
        name: "ssh.example",
        baseUrl: "https://ssh.example",
      });
    }).pipe(Effect.provide(sshServer().layer)),
  );
});

describe("GiceSourceControlProvider", () => {
  it.effect("has the server find a branch's pull requests on the web host of an SSH remote", () => {
    const { layer, sent } = fakeGiceServer({
      "GET /repos/acme/web/pulls": (request: SentRequest) =>
        new URL(request.url).searchParams.get("head") === "feature"
          ? [pullSummary("acme/web", 5, { draft: true })]
          : [
              pullSummary("acme/web", 4, {
                // The server's own word for its page, which a sub-path or plain HTTP would change.
                html_url: "http://code.example/git/acme/web/pulls/4",
                cross_repo: true,
                head_label: "Bob:feature",
                head_repo: { owner: "Bob", name: "web", full_name: "Bob/web" },
              }),
            ],
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const find = (headSelector: string) =>
        provider.listChangeRequests({ cwd: "/repo", context, headSelector, state: "open" });
      const found = [...(yield* find("feature")), ...(yield* find("bob:feature"))];
      assert.deepStrictEqual(
        sent.map((request) => request.url),
        [
          "https://code.example/api/v1/repos/acme/web/pulls?state=open&head=feature&fields=summary&per_page=20",
          "https://code.example/api/v1/repos/acme/web/pulls?state=open&head=bob%3Afeature&fields=summary&per_page=20",
        ],
      );
      assert.deepStrictEqual(
        found.map((item) => [
          item.number,
          item.url,
          item.isDraft,
          item.headSha,
          item.headRepositoryNameWithOwner,
        ]),
        [
          [5, "https://code.example/acme/web/pulls/5", true, HEAD_SHA, "acme/web"],
          [4, "http://code.example/git/acme/web/pulls/4", false, HEAD_SHA, "Bob/web"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("searches an explicit repository override when listing change requests", () => {
    const { layer, sent } = fakeGiceServer({
      "GET /repos/bob/web/pulls": [pullSummary("bob/web", 9)],
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "merged",
        repository: "bob/web",
      });
      assert.deepStrictEqual(
        sent.map((request) => request.url),
        [
          "https://code.example/api/v1/repos/bob/web/pulls?state=merged&head=feature&fields=summary&per_page=20",
        ],
      );
      assert.strictEqual(found[0]?.number, 9);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finds every head the probe names with one listing", () => {
    const { layer, sent } = fakeGiceServer({ "GET /repos/acme/web/pulls": [] });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const probe = provider.headBranchProbe!({
        headSelectors: ["feature", "bob:feature", "feature"],
        state: "all",
        ownerHeadSelector: "Bob:feature",
      });
      assert.deepStrictEqual(probe, {
        headSelectors: ["feature,bob:feature,Bob:feature"],
        limit: 100,
      });
      yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: probe.headSelectors[0]!,
        state: "all",
        limit: probe.limit,
      });
      assert.deepStrictEqual(
        sent.map((request) => new URL(request.url).searchParams.get("head")),
        ["feature,bob:feature,Bob:feature"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens drafts, naming the fork only for a head in another repository", () => {
    const { layer, sent } = fakeGiceServer({
      "POST /repos/acme/web/pulls": () =>
        new Response(encodeJson(pull("acme/web", 4)), { status: 201 }),
    });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const create = (headSelector: string, draft?: boolean) =>
        provider.createChangeRequest({
          cwd: "/repo",
          context,
          baseRefName: "main",
          headSelector,
          title: "Add feature",
          bodyFile: "/tmp/body.md",
          ...(draft === undefined ? {} : { draft }),
        });
      yield* create("feature");
      yield* create("Acme:feature");
      yield* create("bob:feature");
      yield* create("feature", true);
      const body = { title: "Add feature", body: "Body", head: "feature", base: "main" };
      assert.deepStrictEqual(
        sent.map((request) => request.body),
        [body, body, { ...body, head_repo: "bob/web" }, { ...body, draft: true }],
      );
    }).pipe(Effect.provide(layer));
  });

  const repositories = {
    "GET /user": { ...user("Alice"), email: "alice@example.com" },
    "POST /user/repos": repositoryOf("alice/web", { clone_url_ssh: "" }),
    "GET /repos/acme/web": repository,
  };

  // Gice has no way to create a repository for another account or an organisation.
  it.effect("creates repositories only under the signed-in account", () => {
    const { layer, sent } = fakeGiceServer(repositories);
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const elsewhere = yield* Effect.flip(
        provider.createRepository({ cwd: "/new", repository: "acme/web", visibility: "private" }),
      );
      assert.strictEqual(
        elsewhere.detail,
        "Gice creates repositories only under your own account, Alice, not under acme.",
      );
      assert.isFalse(sent.some((request) => request.method === "POST"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a repository, cloned over HTTP from a server with SSH off", () => {
    const { layer, sent } = fakeGiceServer(repositories);
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      const created = yield* provider.createRepository({
        cwd: "/new",
        repository: "alice/web",
        visibility: "private",
      });
      assert.deepStrictEqual(
        sent.filter((request) => request.method === "POST").map((request) => request.body),
        [{ name: "web", is_private: true }],
      );
      assert.deepStrictEqual(created, {
        nameWithOwner: "alice/web",
        url: "https://code.example/alice/web.git",
        sshUrl: "https://code.example/alice/web.git",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads a named repository on the signed-in server from a checkout elsewhere", () => {
    const { layer, sent } = fakeGiceServer(repositories);
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        context: { ...context, remoteUrl: "git@github.com:acme/web.git" },
        repository: "acme/web",
      });
      assert.strictEqual(sent.at(-1)?.url, "https://code.example/api/v1/repos/acme/web");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      name: "into a new branch",
      branches: ["main"],
      force: false,
      after: [
        ["branch", "pr-4", "abc123"],
        ["switch", "pr-4"],
      ],
    },
    {
      name: "again, bringing its branch up to date",
      branches: ["main", "pr-4"],
      force: false,
      after: [
        ["switch", "pr-4"],
        ["merge", "--ff-only", "--quiet", "abc123"],
      ],
    },
    {
      name: "again by force, dropping its branch's own commits",
      branches: ["main", "pr-4"],
      force: true,
      after: [
        ["switch", "pr-4"],
        ["reset", "--hard", "--quiet", "abc123"],
      ],
    },
  ])(
    "checks out a fork's pull request from the head ref the base repository keeps $name",
    ({ branches, force, after }) => {
      const git: Array<ReadonlyArray<string>> = [];
      const { layer } = fakeGiceServer(
        {
          "GET /repos/acme/web/pulls/4": pull("acme/web", 4, {
            cross_repo: true,
            head_label: "bob:feature",
            head_repo: { owner: "bob", name: "web", full_name: "bob/web" },
          }),
        },
        {
          git: {
            listLocalBranchNames: () => Effect.succeed(branches),
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
            resolveCommit: (input) =>
              Effect.succeed({ commitSha: input.revision === "FETCH_HEAD" ? "abc123" : "" }),
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
        yield* provider.checkoutChangeRequest({ cwd: "/repo", context, reference: "#4", force });
        assert.deepStrictEqual(git, [["fetch", "origin", "refs/pull/4/head"], ...after]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("GiceSourceControlProvider pull request templates", () => {
  const BASE = "0123456789abcdef0123456789abcdef01234567";
  const TEMPLATES = `GET /repos/acme/web/templates?kind=pull&ref=${BASE}`;
  const git = {
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    readConfigValue: () => Effect.succeed(SSH_REMOTE),
    resolveCommit: () => Effect.succeed({ commitSha: BASE }),
  };
  const directory = (name: string) => `.github/PULL_REQUEST_TEMPLATE/${name}.md`;

  it.effect.each([
    {
      name: "the default template ahead of a directory's",
      answer: [
        template("pull", ".github/pull_request_template.md", {
          name: "Default",
          body: "Default\n",
        }),
        template("pull", directory("feature"), { body: "Feature" }),
      ],
      expected: Option.some("Default"),
    },
    {
      name: "the only template of a directory",
      answer: [template("pull", directory("feature"), { body: "Feature" })],
      expected: Option.some("Feature"),
    },
    {
      name: "no template where a directory offers a choice",
      answer: [
        template("pull", directory("pull_request_template"), { body: "One" }),
        template("pull", directory("release"), { body: "Two" }),
      ],
      expected: Option.none(),
    },
    {
      name: "no template where the server has none at that commit",
      answer: problem(404, "not_found", `ref ${BASE} not found`),
      expected: Option.none(),
    },
  ])("reads $name at the base's commit", ({ answer, expected }) => {
    const { layer, paths } = fakeGiceServer({ [TEMPLATES]: answer }, { git });
    return Effect.gen(function* () {
      const provider = yield* GiceSourceControlProvider.make;
      assert.deepStrictEqual(
        yield* provider.readChangeRequestTemplate!({ cwd: "/repo", treeish: "origin/main" }),
        expected,
      );
      assert.deepStrictEqual(paths(), [TEMPLATES]);
    }).pipe(Effect.provide(layer));
  });
});

describe("GiceSourceControlProvider links", () => {
  const resolve = (url: string) =>
    GiceSourceControlProvider.make.pipe(
      Effect.map((provider) => provider.resolveLink!({ cwd: "/repo", url: new URL(url) })),
    );

  it.effect("reads the title and description a pasted pull request link names", () => {
    const { layer, paths } = fakeGiceServer({
      "GET /repos/acme/web/issues/4": issue("acme/web", 4, {
        title: "Add feature",
        body: "",
        is_pull: true,
      }),
    });
    return Effect.gen(function* () {
      const lookup = yield* resolve("https://code.example/acme/web/pulls/4/files");
      assert.deepStrictEqual(yield* lookup!, { title: "Add feature", body: null });
      assert.deepStrictEqual(paths(), ["GET /repos/acme/web/issues/4"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts no lookup for a page that is no issue or pull request", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* resolve("https://code.example/acme/web/blob?path=README.md"));
    }).pipe(Effect.provide(fakeGiceServer({}).layer)),
  );

  it.effect("sends no token to a host it was not saved for", () => {
    const { layer, sent } = fakeGiceServer({});
    return Effect.gen(function* () {
      const lookup = yield* resolve("https://gice.elsewhere.example/acme/web/issues/4");
      yield* Effect.flip(lookup!);
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  });
});
