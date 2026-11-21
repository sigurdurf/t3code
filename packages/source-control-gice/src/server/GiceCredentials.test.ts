import { assert, describe, it } from "@effect/vitest";
import { SecretProviderId, type ServerSettingsPatch } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as GiceCredentials from "./GiceCredentials.ts";

const LOGIN = '{"host":"https://gice.example","token":"login-token","vcs":"jj"}';
const LOGIN_FILE = "/home/alice/.config/gice/config.json";

/** `reads` counts the reads of each file. */
function harness(
  env: NodeJS.ProcessEnv,
  files: Readonly<Record<string, string>>,
  reads: Record<string, number> = {},
) {
  return GiceCredentials.layer.pipe(
    Layer.provideMerge(TestSourceControlHost.layer()),
    Layer.provide(
      FileSystem.layerNoop({
        readFileString: (path) => {
          reads[path] = (reads[path] ?? 0) + 1;
          return files[path] === undefined
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(files[path]);
        },
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/alice")),
  );
}

const describeCredential = (credential: GiceCredentials.GiceCredential) => ({
  host: credential.host,
  baseUrl: credential.baseUrl,
  token: Redacted.value(credential.token),
});

const tokenFor = (host: string) =>
  GiceCredentials.GiceCredentials.use((credentials) => credentials.get(host)).pipe(
    Effect.map((credential) => Redacted.value(credential.token)),
  );

const failureFor = (host: string) =>
  GiceCredentials.GiceCredentials.use((credentials) => Effect.flip(credentials.get(host))).pipe(
    Effect.map((error) => error._tag),
  );

const saveSettings = (patch: ServerSettingsPatch) =>
  TestSourceControlHost.TestSourceControlHostSettings.use((settings) => settings.update(patch));

describe("GiceCredentials", () => {
  const withLogin = harness({}, { [LOGIN_FILE]: LOGIN });

  it.effect("uses the gice login for its own server, found without a port too", () =>
    Effect.gen(function* () {
      const credentials = yield* GiceCredentials.GiceCredentials;
      assert.deepStrictEqual(describeCredential(yield* credentials.get("Gice.Example")), {
        host: "gice.example",
        baseUrl: "https://gice.example",
        token: "login-token",
      });
    }).pipe(Effect.provide(withLogin)),
  );

  it.effect("holds no credential for a server the login does not name", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* failureFor("other.example"), "GiceNotSignedInError");
    }).pipe(Effect.provide(withLogin)),
  );

  it.effect("reads the login below XDG_CONFIG_HOME and tells servers apart by port", () =>
    Effect.gen(function* () {
      const credentials = yield* GiceCredentials.GiceCredentials;
      assert.strictEqual((yield* credentials.get("localhost")).baseUrl, "http://localhost:3000");
      assert.strictEqual(yield* failureFor("localhost:4000"), "GiceNotSignedInError");
    }).pipe(
      Effect.provide(
        harness(
          { XDG_CONFIG_HOME: "/xdg" },
          { "/xdg/gice/config.json": '{"host":"http://localhost:3000","token":"dev-token"}' },
        ),
      ),
    ),
  );

  it.effect(
    "sends GICE_TOKEN to GICE_HOST and keeps the login's token for the login's server",
    () =>
      Effect.gen(function* () {
        const credentials = yield* GiceCredentials.GiceCredentials;
        const servers = yield* credentials.all;
        assert.deepStrictEqual(
          yield* Effect.forEach(servers, (server) =>
            tokenFor(server.host).pipe(Effect.map((token) => [server.host, token])),
          ),
          [
            ["staging.example", "env-token"],
            ["gice.example", "login-token"],
          ],
        );
      }).pipe(
        Effect.provide(
          harness(
            { GICE_HOST: "staging.example", GICE_TOKEN: "env-token" },
            { [LOGIN_FILE]: LOGIN },
          ),
        ),
      ),
  );

  describe("the gice login", () => {
    const files: Record<string, string> = {};
    const reads: Record<string, number> = {};
    const layer = harness({}, files, reads);
    const relogin = (token: string) =>
      Effect.sync(() => {
        files[LOGIN_FILE] = `{"host":"https://gice.example","token":"${token}"}`;
      });

    it.effect("is read once for many requests", () =>
      Effect.gen(function* () {
        yield* relogin("login-token");
        reads[LOGIN_FILE] = 0;
        yield* tokenFor("gice.example");
        yield* tokenFor("gice.example");
        yield* GiceCredentials.GiceCredentials.use((credentials) => credentials.all);
        assert.strictEqual(reads[LOGIN_FILE], 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("is read again once forgotten, as after a refused token", () =>
      Effect.gen(function* () {
        yield* relogin("login-token");
        assert.strictEqual(yield* tokenFor("gice.example"), "login-token");
        yield* relogin("new-login-token");
        assert.strictEqual(yield* tokenFor("gice.example"), "login-token");
        yield* GiceCredentials.GiceCredentials.use((credentials) => credentials.invalidate);
        assert.strictEqual(yield* tokenFor("gice.example"), "new-login-token");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("is read again ten seconds after it was missing", () =>
      Effect.gen(function* () {
        delete files[LOGIN_FILE];
        yield* GiceCredentials.GiceCredentials.use((credentials) => credentials.invalidate);
        assert.strictEqual(yield* failureFor("gice.example"), "GiceNotSignedInError");
        yield* relogin("login-token");
        yield* TestClock.adjust("9 seconds");
        assert.strictEqual(yield* failureFor("gice.example"), "GiceNotSignedInError");
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* tokenFor("gice.example"), "login-token");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("is read again after five minutes", () =>
      Effect.gen(function* () {
        yield* relogin("login-token");
        yield* tokenFor("gice.example");
        yield* relogin("new-login-token");
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(yield* tokenFor("gice.example"), "new-login-token");
      }).pipe(Effect.provide(layer)),
    );
  });

  describe("with a saved token", () => {
    const layer = harness({ GICE_TOKEN: "env-token" }, { [LOGIN_FILE]: LOGIN });
    const saved = saveSettings({
      sourceControlHosts: {
        gice: { tokens: { "gice.example": "saved-token", "work.example:8443": "work-token" } },
      },
    });

    it.effect("sends GICE_TOKEN alone to the login's server, ahead of the login's own", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* tokenFor("gice.example"), "env-token");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("prefers the token saved for a server", () =>
      Effect.gen(function* () {
        yield* saved;
        assert.strictEqual(yield* tokenFor("gice.example"), "saved-token");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("takes a token changed in Settings at once", () =>
      Effect.gen(function* () {
        yield* saved;
        yield* tokenFor("gice.example");
        yield* saveSettings({
          sourceControlHosts: { gice: { tokens: { "gice.example": "new-token" } } },
        });
        assert.strictEqual(yield* tokenFor("gice.example"), "new-token");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("finds a saved server with a port by its hostname", () =>
      Effect.gen(function* () {
        yield* saved;
        const credentials = yield* GiceCredentials.GiceCredentials;
        assert.deepStrictEqual(describeCredential(yield* credentials.get("work.example")), {
          host: "work.example:8443",
          baseUrl: "https://work.example:8443",
          token: "work-token",
        });
        assert.strictEqual(yield* failureFor("other.example"), "GiceNotSignedInError");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("reads a host without a port through its own server before one on another port", () =>
      Effect.gen(function* () {
        yield* saveSettings({
          sourceControlHosts: {
            gice: { tokens: { "work.example:8443": "work-token", "work.example": "web-token" } },
          },
        });
        assert.strictEqual(yield* tokenFor("work.example"), "web-token");
        assert.strictEqual(yield* tokenFor("work.example:8443"), "work-token");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("refuses a server turned off in Settings, which keeps its place in the list", () =>
      Effect.gen(function* () {
        yield* saved;
        yield* saveSettings({
          sourceControlHosts: { gice: { hosts: { "gice.example": { enabled: false } } } },
        });
        assert.strictEqual(yield* failureFor("gice.example"), "GiceHostDisabledError");
        assert.deepStrictEqual(
          (yield* GiceCredentials.GiceCredentials.use((credentials) => credentials.all)).map(
            (credential) => [credential.host, credential.enabled],
          ),
          [
            ["gice.example", false],
            ["work.example:8443", true],
          ],
        );
      }).pipe(Effect.provide(layer)),
    );

    // getWithSecrets leaves in place a reference its secret provider could not read.
    it.effect("fails the one server whose saved token cannot be read", () =>
      Effect.gen(function* () {
        yield* saveSettings({
          sourceControlHosts: {
            gice: {
              tokens: {
                "gice.example": {
                  provider: SecretProviderId.make("vault"),
                  reference: "gice#token",
                },
                "work.example:8443": "work-token",
              },
            },
          },
        });
        assert.strictEqual(yield* failureFor("gice.example"), "SettingsSecretUnresolvedError");
        assert.strictEqual(yield* tokenFor("work.example"), "work-token");
        assert.deepStrictEqual(
          (yield* GiceCredentials.GiceCredentials.use((credentials) => credentials.all)).map(
            (server) => server.host,
          ),
          ["gice.example", "work.example:8443"],
        );
      }).pipe(Effect.provide(layer)),
    );
  });
});
