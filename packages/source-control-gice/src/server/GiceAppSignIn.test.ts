import { assert, describe, it } from "@effect/vitest";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as GiceClient from "../shared/definition.ts";
import * as GiceApi from "./GiceApi.ts";
import { encodeJson, fakeGiceServer, problem, STALLED, UNREACHABLE } from "./GiceApi.testkit.ts";
import * as GiceAppSignIn from "./GiceAppSignIn.ts";
import * as GiceCredentials from "./GiceCredentials.ts";

const BASE = "https://code.example";
const HOUR = 3_600_000;

const meta = (overrides: Record<string, unknown> = {}) => ({
  features: ["token_scopes", "device_flow"],
  oauth: {
    device_authorization_endpoint: `${BASE}/api/v1/oauth/device/code`,
    token_endpoint: `${BASE}/api/v1/oauth/token`,
    revocation_endpoint: `${BASE}/api/v1/oauth/revoke`,
  },
  ...overrides,
});

const deviceCode = {
  device_code: "gicedc_d8863b20396301ef47ba6672efc27a8a98fca46f",
  user_code: "NFMP-GKKF",
  verification_uri: `${BASE}/device`,
  verification_uri_complete: `${BASE}/device?code=NFMP-GKKF`,
  expires_in: 900,
  interval: 5,
};

const granted = (access: string, refresh: string) => ({
  access_token: access,
  token_type: "Bearer",
  expires_in: 28_800,
  refresh_token: refresh,
  refresh_token_expires_in: 7_776_000,
  scope: "repo:write issues:write workflows:write",
});

const oauthError = (error: string, extra: Record<string, unknown> = {}) =>
  new Response(encodeJson({ error, error_description: `${error} described`, ...extra }), {
    status: 400,
  });

const session = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    baseUrl: BASE,
    accessToken: "gicet_current",
    accessTokenExpiresAt: 8 * HOUR,
    refreshToken: "gicerf_current",
    refreshTokenExpiresAt: 2_000 * HOUR,
    scope: "repo:write issues:write workflows:write",
    ...overrides,
  });

const signInTo = (signIn: string) =>
  TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
    settings.update({ sourceControlHosts: { gice: { signIns: { "code.example": signIn } } } }),
  );

const stored = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const settings = yield* host.settings.get;
  const raw = readSourceControlHostSettings(GiceClient.settings, settings.sourceControlHosts.gice)
    .signIns["code.example"];
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
});

const tokenNow = GiceAppSignIn.GiceAppSignIn.use((signIn) => signIn.token("code.example")).pipe(
  Effect.map(Option.map((found) => found.token)),
  Effect.map(Option.getOrUndefined),
);

const readUser = GiceApi.GiceApi.use((api) =>
  api.request({ host: "code.example", operation: "test", path: "/user" }),
);

describe("GiceAppSignIn", () => {
  it.effect("signs in with the device flow, slowing down for good when told to", () => {
    const polls: Array<unknown> = [
      oauthError("authorization_pending"),
      oauthError("slow_down", { interval: 10 }),
      oauthError("authorization_pending"),
      granted("gicet_new", "gicerf_new"),
    ];
    const server = fakeGiceServer(
      {
        "GET /meta": meta(),
        "POST /oauth/device/code": deviceCode,
        "POST /oauth/token": () => polls.shift(),
        "GET /user": { username: "alice" },
      },
      { env: {} },
    );
    return Effect.gen(function* () {
      const signIn = yield* GiceAppSignIn.GiceAppSignIn;
      const prompt = yield* signIn.start("code.example");
      assert.deepStrictEqual(prompt, {
        userCode: "NFMP-GKKF",
        verificationUri: `${BASE}/device`,
        verificationUriComplete: `${BASE}/device?code=NFMP-GKKF`,
        expiresAt: 900_000,
        scopes: ["repo:write", "issues:write", "workflows:write"],
      });
      const waiting = yield* Effect.forkChild(signIn.wait("https://code.example/"));
      // Polls at 5s, 10s, then every 10s after `slow_down`.
      yield* TestClock.adjust("35 seconds");
      assert.strictEqual(yield* Fiber.join(waiting), "alice");

      const pollTimes = server.sent.filter((sent) => sent.path === "/oauth/token");
      assert.strictEqual(pollTimes.length, 4);
      assert.deepStrictEqual(server.sent[1]?.body, {
        client_id: "t3code",
        client_name: "T3 Code on devbox",
        scope: "repo:write issues:write workflows:write",
      });
      assert.deepStrictEqual(pollTimes[0]?.body, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode.device_code,
        client_id: "t3code",
      });
      // Nothing carries a code or token anywhere but the server, and nothing follows a redirect.
      assert.isTrue(server.sent.every((sent) => sent.url.startsWith(`${BASE}/api/v1/`)));
      assert.isTrue(server.sent.every((sent) => sent.redirect === "manual"));
      assert.deepStrictEqual(yield* stored, {
        baseUrl: BASE,
        accessToken: "gicet_new",
        accessTokenExpiresAt: 30_000 + 28_800_000,
        refreshToken: "gicerf_new",
        refreshTokenExpiresAt: 30_000 + 7_776_000_000,
        scope: "repo:write issues:write workflows:write",
      });
      // API requests now go out with the sign-in.
      yield* readUser;
      assert.strictEqual(server.sent.at(-1)?.authorization, "Bearer gicet_new");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("ends each way the device flow can end", () => {
    const outcomes = [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
      ["invalid_grant", "failed"],
    ] as const;
    return Effect.forEach(outcomes, ([error, reason]) => {
      const server = fakeGiceServer(
        {
          "GET /meta": meta(),
          "POST /oauth/device/code": deviceCode,
          "POST /oauth/token": oauthError(error),
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        const signIn = yield* GiceAppSignIn.GiceAppSignIn;
        yield* signIn.start("code.example");
        const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("code.example")));
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(waiting)).reason, reason);
        assert.strictEqual(yield* stored, undefined);
      }).pipe(Effect.provide(server.layer));
    });
  });

  it.effect("keeps polling through a dropped poll and stops at the code's expiry", () => {
    const server = fakeGiceServer(
      {
        "GET /meta": meta(),
        "POST /oauth/device/code": { ...deviceCode, expires_in: 12 },
        "POST /oauth/token": UNREACHABLE,
      },
      { env: {} },
    );
    return Effect.gen(function* () {
      const signIn = yield* GiceAppSignIn.GiceAppSignIn;
      yield* signIn.start("code.example");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("code.example")));
      yield* TestClock.adjust("15 seconds");
      assert.strictEqual((yield* Fiber.join(waiting)).reason, "expired");
      assert.strictEqual(server.paths().filter((path) => path === "POST /oauth/token").length, 2);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("cancels a sign-in so approving the code afterwards saves nothing", () => {
    const server = fakeGiceServer(
      {
        "GET /meta": meta(),
        "POST /oauth/device/code": deviceCode,
        "POST /oauth/token": granted("gicet_new", "gicerf_new"),
      },
      { env: {} },
    );
    return Effect.gen(function* () {
      const signIn = yield* GiceAppSignIn.GiceAppSignIn;
      yield* signIn.start("code.example");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("code.example")));
      yield* signIn.cancel("code.example");
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual((yield* Fiber.join(waiting)).reason, "cancelled");
      assert.strictEqual(yield* stored, undefined);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("signs in only where codes and links stay on the named server", () => {
    const cases = [
      [{ "GET /meta": meta({ features: ["token_scopes"] }) }, "unsupported"],
      [
        {
          "GET /meta": meta({
            oauth: {
              device_authorization_endpoint: "https://gice.internal/api/v1/oauth/device/code",
            },
          }),
        },
        "calls itself https://gice.internal",
      ],
      [
        {
          "GET /meta": meta(),
          "POST /oauth/device/code": {
            ...deviceCode,
            verification_uri: "https://evil.example/device",
          },
        },
        "not on https://code.example",
      ],
    ] as const;
    return Effect.forEach(cases, ([routes, expected]) => {
      const server = fakeGiceServer(routes, { env: {} });
      return Effect.gen(function* () {
        const signIn = yield* GiceAppSignIn.GiceAppSignIn;
        const error = yield* Effect.flip(signIn.start("code.example"));
        assert.include(`${error.reason} ${error.detail}`, expected);
        assert.isTrue(server.sent.every((sent) => sent.url.startsWith(`${BASE}/`)));
      }).pipe(Effect.provide(server.layer));
    });
  });

  it.effect("drops a filled-in link on another server but keeps the sign-in", () => {
    const server = fakeGiceServer(
      {
        "GET /meta": meta(),
        "POST /oauth/device/code": {
          ...deviceCode,
          verification_uri_complete: "https://evil.example/device?code=NFMP-GKKF",
        },
      },
      { env: {} },
    );
    return Effect.gen(function* () {
      const prompt = yield* GiceAppSignIn.GiceAppSignIn.use((signIn) =>
        signIn.start("code.example"),
      );
      assert.strictEqual(prompt.verificationUriComplete, undefined);
      assert.strictEqual(prompt.verificationUri, `${BASE}/device`);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("ends the sign-in it replaces at the server", () => {
    const server = fakeGiceServer(
      {
        "GET /meta": meta(),
        "POST /oauth/device/code": deviceCode,
        "POST /oauth/token": granted("gicet_new", "gicerf_new"),
        "GET /user": { username: "alice" },
        "POST /oauth/revoke": {},
      },
      { env: {} },
    );
    return Effect.gen(function* () {
      yield* signInTo(session());
      const signIn = yield* GiceAppSignIn.GiceAppSignIn;
      yield* signIn.start("code.example");
      const waiting = yield* Effect.forkChild(signIn.wait("code.example"));
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(waiting);
      assert.deepStrictEqual(server.sent.at(-1)?.body, {
        token: "gicerf_current",
        client_id: "t3code",
      });
      assert.strictEqual((yield* stored)?.refreshToken, "gicerf_new");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("signs out by ending the sign-in at the server, and says so when it cannot", () =>
    Effect.forEach(
      [
        [{}, null],
        [UNREACHABLE, "could not reach code.example"],
      ] as const,
      ([answer, failure]) => {
        const server = fakeGiceServer({ "POST /oauth/revoke": answer }, { env: {} });
        return Effect.gen(function* () {
          yield* signInTo(session());
          const result = yield* Effect.flip(
            GiceAppSignIn.GiceAppSignIn.use((signIn) => signIn.signOut("code.example")),
          ).pipe(Effect.option);
          assert.deepStrictEqual(server.bodies(), [
            ["POST /oauth/revoke", { token: "gicerf_current", client_id: "t3code" }],
          ]);
          // Forgotten either way.
          assert.strictEqual(yield* stored, undefined);
          if (failure === null) assert.isTrue(Option.isNone(result));
          else assert.include(Option.getOrThrow(result).detail, failure);
        }).pipe(Effect.provide(server.layer));
      },
    ),
  );

  describe("refresh", () => {
    it.effect("renews once for concurrent requests and saves the new pair", () => {
      const server = fakeGiceServer(
        { "POST /oauth/token": granted("gicet_next", "gicerf_next") },
        { env: {} },
      );
      return Effect.gen(function* () {
        // Within five minutes of expiry.
        yield* signInTo(session({ accessTokenExpiresAt: 4 * 60_000 }));
        const tokens = yield* Effect.all([tokenNow, tokenNow, tokenNow], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual(tokens, ["gicet_next", "gicet_next", "gicet_next"]);
        assert.deepStrictEqual(server.bodies(), [
          [
            "POST /oauth/token",
            { grant_type: "refresh_token", refresh_token: "gicerf_current", client_id: "t3code" },
          ],
        ]);
        const after = yield* stored;
        assert.strictEqual(after?.refreshToken, "gicerf_next");
        assert.strictEqual(after?.refreshing, undefined);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("renews on a 401 token_expired and sends the request again once", () => {
      const server = fakeGiceServer(
        {
          "POST /oauth/token": granted("gicet_next", "gicerf_next"),
          "GET /user": (sent: { authorization: string | undefined }) =>
            sent.authorization === "Bearer gicet_next"
              ? { username: "alice" }
              : new Response(
                  encodeJson({
                    error: {
                      code: "unauthorized",
                      message: "the access token has expired",
                      reason: "token_expired",
                    },
                  }),
                  { status: 401 },
                ),
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        yield* signInTo(session());
        assert.include(yield* readUser, "alice");
        assert.deepStrictEqual(server.paths(), ["GET /user", "POST /oauth/token", "GET /user"]);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("signs out with the reason when Gice refuses the refresh token", () => {
      const server = fakeGiceServer(
        {
          "POST /oauth/token": oauthError("invalid_grant", {
            error_description: "the refresh token was already used; the sign-in has been revoked",
          }),
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        yield* signInTo(session({ accessTokenExpiresAt: 0 }));
        const error = yield* Effect.flip(
          GiceCredentials.GiceCredentials.use((credentials) => credentials.get("code.example")),
        );
        assert.strictEqual(error._tag, "GiceSignInEndedError");
        assert.include(error.message, "already used");
        assert.include(error.message, "Sign in again");
        assert.strictEqual(yield* stored, undefined);
        // Later requests still say why, and discovery can too.
        const again = yield* Effect.flip(
          GiceCredentials.GiceCredentials.use((credentials) => credentials.get("code.example")),
        );
        assert.strictEqual(again._tag, "GiceSignInEndedError");
        assert.strictEqual(server.paths().length, 1);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect(
      "keeps everything when Gice cannot be reached, using a token that still works",
      () => {
        const server = fakeGiceServer({ "POST /oauth/token": UNREACHABLE }, { env: {} });
        return Effect.gen(function* () {
          yield* signInTo(session({ accessTokenExpiresAt: 2 * 60_000 }));
          assert.strictEqual(yield* tokenNow, "gicet_current");
          // The refresh was on record before it went out, and stays so: Gice may have taken it.
          assert.deepStrictEqual(
            [(yield* stored)?.refreshToken, (yield* stored)?.refreshing],
            ["gicerf_current", true],
          );
          // Past expiry, nothing works until Gice answers, and nothing is forgotten.
          yield* TestClock.adjust("3 minutes");
          const error = yield* Effect.flip(tokenNow);
          assert.strictEqual(error._tag, "GiceSignInUnreachableError");
          assert.strictEqual((yield* stored)?.refreshToken, "gicerf_current");
        }).pipe(Effect.provide(server.layer));
      },
    );

    it.effect("does not replay a refresh whose answer was lost after Gice took it", () => {
      const server = fakeGiceServer(
        {
          // The old access token is unknown once Gice rotated it.
          "GET /user/token": problem(401, "unauthorized", "invalid credentials"),
          "POST /oauth/revoke": {},
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        yield* signInTo(session({ accessTokenExpiresAt: 0, refreshing: true }));
        const error = yield* Effect.flip(tokenNow);
        assert.strictEqual(error._tag, "GiceSignInEndedError");
        assert.include(error.message, "ended while T3 Code was renewing it");
        // Ended with revoke, which Gice does not report as a replay.
        assert.deepStrictEqual(server.paths(), ["GET /user/token", "POST /oauth/revoke"]);
        assert.strictEqual(yield* stored, undefined);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("refreshes after a lost answer when Gice never took the refresh", () => {
      const server = fakeGiceServer(
        {
          "GET /user/token": new Response(
            encodeJson({
              error: { code: "unauthorized", message: "expired", reason: "token_expired" },
            }),
            { status: 401 },
          ),
          "POST /oauth/token": granted("gicet_next", "gicerf_next"),
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        yield* signInTo(session({ accessTokenExpiresAt: 0, refreshing: true }));
        assert.strictEqual(yield* tokenNow, "gicet_next");
        assert.deepStrictEqual(server.paths(), ["GET /user/token", "POST /oauth/token"]);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("refreshes after a lost answer when the old token still works", () => {
      const server = fakeGiceServer(
        {
          // Gice never took the refresh: the token it was sent for is still the live one.
          "GET /user/token": { scopes: ["repo:write"] },
          "POST /oauth/token": granted("gicet_next", "gicerf_next"),
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        yield* signInTo(session({ accessTokenExpiresAt: 2 * 60_000, refreshing: true }));
        assert.strictEqual(yield* tokenNow, "gicet_next");
        assert.deepStrictEqual(server.bodies(), [
          ["GET /user/token", undefined],
          [
            "POST /oauth/token",
            { grant_type: "refresh_token", refresh_token: "gicerf_current", client_id: "t3code" },
          ],
        ]);
        assert.strictEqual((yield* stored)?.refreshing, undefined);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("renews one server's sign-in while another server does not answer", () => {
      const OTHER = "https://other.example";
      const stalledSent = Deferred.makeUnsafe<void>();
      const server = fakeGiceServer(
        {
          "POST /oauth/token": (sent: { url: string }) => {
            if (!sent.url.startsWith(BASE)) return granted("gicet_other", "gicerf_other");
            Deferred.doneUnsafe(stalledSent, Exit.void);
            return STALLED;
          },
        },
        { env: {} },
      );
      const tokenOf = (host: string) =>
        GiceAppSignIn.GiceAppSignIn.use((signIn) => signIn.token(host)).pipe(
          Effect.map(Option.map((found) => found.token)),
          Effect.map(Option.getOrUndefined),
        );
      return Effect.gen(function* () {
        yield* TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
          settings.update({
            sourceControlHosts: {
              gice: {
                signIns: {
                  "code.example": session({ accessTokenExpiresAt: 0 }),
                  "other.example": session({ baseUrl: OTHER, accessTokenExpiresAt: 0 }),
                },
              },
            },
          }),
        );
        const stalled = yield* Effect.forkChild(Effect.flip(tokenOf("code.example")));
        // The stalled refresh holds its server's lock while its request goes unanswered.
        yield* Deferred.await(stalledSent);
        // No time passes: the other server's renewal does not wait for the first to time out.
        assert.strictEqual(yield* tokenOf("other.example"), "gicet_other");
        yield* TestClock.adjust("15 seconds");
        assert.strictEqual((yield* Fiber.join(stalled))._tag, "GiceSignInUnreachableError");
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("ends a sign-in unused for 90 days without asking Gice", () => {
      const server = fakeGiceServer({}, { env: {} });
      return Effect.gen(function* () {
        yield* signInTo(session({ accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0 }));
        const error = yield* Effect.flip(tokenNow);
        assert.include(error.message, "90 days");
        assert.deepStrictEqual(server.paths(), []);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("forgets a host's refused token on refresh, sign-out, and sign-in end", () => {
      const server = fakeGiceServer(
        {
          "POST /oauth/token": granted("gicet_next", "gicerf_next"),
          "POST /oauth/revoke": {},
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        const signIn = yield* GiceAppSignIn.GiceAppSignIn;
        // 1) Cleared on refresh.
        yield* signInTo(session({ accessToken: "gicet_reused" }));
        yield* signIn.rejected("code.example", "gicet_reused");
        assert.strictEqual(yield* tokenNow, "gicet_next");
        // Re-storing a session with the old token string should not trigger another refresh.
        yield* signInTo(session({ accessToken: "gicet_reused" }));
        assert.strictEqual(yield* tokenNow, "gicet_reused");
        assert.strictEqual(server.paths().length, 1);

        // 2) Cleared on signOut.
        yield* signIn.rejected("code.example", "gicet_reused");
        yield* signIn.signOut("https://code.example");
        yield* signInTo(session({ accessToken: "gicet_reused" }));
        assert.strictEqual(yield* tokenNow, "gicet_reused");
        assert.strictEqual(server.paths().length, 2);

        // 3) Cleared on end (expired refresh token).
        yield* signInTo(session({ accessToken: "gicet_reused", refreshTokenExpiresAt: 0 }));
        yield* signIn.rejected("code.example", "gicet_reused");
        assert.strictEqual((yield* Effect.flip(tokenNow))._tag, "GiceSignInEndedError");
        yield* signInTo(session({ accessToken: "gicet_reused" }));
        assert.strictEqual(yield* tokenNow, "gicet_reused");
        assert.strictEqual(server.paths().length, 2);
      }).pipe(Effect.provide(server.layer));
    });
  });

  describe("scopes", () => {
    it.effect("says what a refusal lacks and asks for it at the next sign-in", () => {
      const server = fakeGiceServer(
        {
          "PATCH /repos/alice/demo": new Response(
            encodeJson({
              error: {
                code: "forbidden",
                message:
                  "this token does not have the scope repo:admin (it has: repo:write issues:write workflows:write)",
                reason: "insufficient_scope",
              },
            }),
            {
              status: 403,
              headers: {
                "www-authenticate": 'Bearer error="insufficient_scope", scope="repo:admin"',
              },
            },
          ),
          "GET /meta": meta(),
          "POST /oauth/device/code": deviceCode,
        },
        { env: {} },
      );
      return Effect.gen(function* () {
        yield* signInTo(session());
        const error = yield* Effect.flip(
          GiceApi.GiceApi.use((api) =>
            api.request({
              host: "code.example",
              operation: "test",
              method: "PATCH",
              repository: "alice/demo",
              path: "",
            }),
          ),
        );
        assert.include(error.detail, "lacks repo:admin");
        assert.include(error.detail, "Sign in again");
        const signIn = yield* GiceAppSignIn.GiceAppSignIn;
        assert.include((yield* signIn.notes).get("code.example") ?? "", "repo:admin");
        const prompt = yield* signIn.start("code.example");
        assert.deepStrictEqual(prompt.scopes, [
          "repo:write",
          "issues:write",
          "workflows:write",
          "repo:admin",
        ]);
      }).pipe(Effect.provide(server.layer));
    });
  });
});

describe("missingScopes", () => {
  it("reads the header, else a workflow-file refusal's text", () => {
    assert.deepStrictEqual(
      GiceApi.missingScopes('Bearer error="insufficient_scope", scope="repo:admin account"', ""),
      ["repo:admin", "account"],
    );
    assert.deepStrictEqual(
      GiceApi.missingScopes(
        undefined,
        "merging #1 changes workflow files (.gice/workflows/), which run with the repository's secrets: that needs a token with the workflows:write scope",
      ),
      ["workflows:write"],
    );
  });
});

describe("clientName", () => {
  it("keeps only what Gice shows as plain text", () => {
    assert.strictEqual(GiceAppSignIn.clientName("mac.local"), "T3 Code on mac.local");
    assert.strictEqual(GiceAppSignIn.clientName("evil\u202e://x"), "T3 Code on evilx");
    assert.strictEqual(GiceAppSignIn.clientName(""), "T3 Code");
  });
});
