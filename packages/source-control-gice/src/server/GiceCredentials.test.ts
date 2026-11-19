import { assert, describe, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";

import * as GiceCredentials from "./GiceCredentials.ts";

const LOGIN = '{"host":"https://gice.example","token":"login-token","vcs":"jj"}';

function harness(env: NodeJS.ProcessEnv, files: Readonly<Record<string, string>>) {
  return GiceCredentials.layer.pipe(
    Layer.provideMerge(TestSourceControlHost.layer()),
    Layer.provide(
      FileSystem.layerNoop({
        readFileString: (path) =>
          files[path] === undefined
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(files[path]),
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
  source: credential.source,
});

describe("GiceCredentials", () => {
  it("reads a server address the way gice does", () => {
    for (const [address, host, baseUrl] of [
      ["https://Gice.Example/", "gice.example", "https://gice.example"],
      ["gice.example:8443", "gice.example:8443", "https://gice.example:8443"],
      ["localhost:3000", "localhost:3000", "http://localhost:3000"],
      ["127.0.0.1:3000", "127.0.0.1:3000", "http://127.0.0.1:3000"],
      ["https://example.com/gice/", "example.com", "https://example.com/gice"],
    ] as const) {
      assert.deepStrictEqual(GiceCredentials.parseGiceServer(address), { host, baseUrl }, address);
    }
    for (const address of [
      undefined,
      " ",
      "ftp://gice.example",
      "https://user:pw@gice.example",
      "https://gice.example/?a=1",
    ]) {
      assert.isNull(GiceCredentials.parseGiceServer(address), address);
    }
  });

  it.effect("uses the gice login for its own server, found without a port too", () =>
    Effect.gen(function* () {
      const credentials = yield* GiceCredentials.GiceCredentials;
      assert.deepStrictEqual(describeCredential(yield* credentials.get("Gice.Example")), {
        host: "gice.example",
        baseUrl: "https://gice.example",
        token: "login-token",
        source: "gice",
      });
      const missing = yield* Effect.flip(credentials.get("other.example"));
      assert.strictEqual(missing._tag, "GiceNotSignedInError");
    }).pipe(Effect.provide(harness({}, { "/home/alice/.config/gice/config.json": LOGIN }))),
  );

  it.effect("reads the login below XDG_CONFIG_HOME and matches a server by hostname", () =>
    Effect.gen(function* () {
      const credentials = yield* GiceCredentials.GiceCredentials;
      const credential = yield* credentials.get("localhost");
      assert.strictEqual(credential.baseUrl, "http://localhost:3000");
      assert.strictEqual(
        (yield* Effect.flip(credentials.get("localhost:4000")))._tag,
        "GiceNotSignedInError",
      );
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
        assert.deepStrictEqual(
          (yield* credentials.all).map(describeCredential).map((c) => [c.host, c.token, c.source]),
          [
            ["staging.example", "env-token", "env"],
            ["gice.example", "login-token", "gice"],
          ],
        );
      }).pipe(
        Effect.provide(
          harness(
            { GICE_HOST: "staging.example", GICE_TOKEN: "env-token" },
            { "/home/alice/.config/gice/config.json": LOGIN },
          ),
        ),
      ),
  );

  it.effect("prefers a saved token, on the saved server or else the one gice targets", () =>
    Effect.gen(function* () {
      const credentials = yield* GiceCredentials.GiceCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

      // GICE_TOKEN alone goes to the login's server, ahead of the login's own token.
      assert.strictEqual((yield* credentials.get("gice.example")).source, "env");

      yield* settings.update({ sourceControlHosts: { gice: { token: "saved-token" } } });
      assert.deepStrictEqual(describeCredential(yield* credentials.get("gice.example")), {
        host: "gice.example",
        baseUrl: "https://gice.example",
        token: "saved-token",
        source: "settings",
      });

      yield* settings.update({
        sourceControlHosts: { gice: { host: "work.example", token: "saved-token" } },
      });
      assert.strictEqual(
        Redacted.value((yield* credentials.get("work.example")).token),
        "saved-token",
      );
      // The saved token belongs to the saved server, so the other server keeps its own.
      assert.strictEqual(
        Redacted.value((yield* credentials.get("gice.example")).token),
        "env-token",
      );

      // A reference left in place by getWithSecrets is one its secret provider could not read.
      yield* settings.update({
        sourceControlHosts: {
          gice: {
            host: "work.example",
            token: { provider: SecretProviderId.make("vault"), reference: "gice#token" },
          },
        },
      });
      assert.strictEqual(
        (yield* Effect.flip(credentials.get("gice.example")))._tag,
        "SettingsSecretUnresolvedError",
      );
    }).pipe(
      Effect.provide(
        harness({ GICE_TOKEN: "env-token" }, { "/home/alice/.config/gice/config.json": LOGIN }),
      ),
    ),
  );
});
