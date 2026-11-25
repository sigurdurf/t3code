import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fakeGiceServer, HEAD_SHA, problem } from "./GiceApi.testkit.ts";
import * as GiceMediaFetch from "./GiceMediaFetch.ts";

const RAW = `/repos/acme/web/raw?ref=${HEAD_SHA}&path=docs%2Fshot.png`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const fetchMedia = (url: string, headers: Record<string, string> = {}) =>
  GiceMediaFetch.make.pipe(
    Effect.flatMap((fetch) => fetch({ url, headers })),
    Effect.flatMap((response) =>
      response === null
        ? Effect.succeed(null)
        : response.arrayBuffer.pipe(
            Effect.map((body) => ({
              status: response.status,
              type: response.headers["content-type"],
              body: new Uint8Array(body),
            })),
          ),
    ),
    Effect.scoped,
  );

describe("GiceMediaFetch", () => {
  it.effect("reads a private file with the token of the server it is on", () => {
    const { layer, sent } = fakeGiceServer({
      [`GET ${RAW}`]: new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    return Effect.gen(function* () {
      const media = yield* fetchMedia(`https://code.example/api/v1${RAW}`, { range: "bytes=0-" });
      assert.deepStrictEqual(media, { status: 200, type: "image/png", body: PNG });
      assert.deepStrictEqual(
        sent.map((request) => [request.url, request.authorization, request.redirect]),
        [[`https://code.example/api/v1${RAW}`, "Bearer env-token", "manual"]],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the server's refusal on as its answer", () => {
    const { layer } = fakeGiceServer({
      [`GET ${RAW}`]: problem(404, "not_found", "path docs/shot.png not found"),
    });
    return Effect.gen(function* () {
      assert.strictEqual((yield* fetchMedia(`https://code.example/api/v1${RAW}`))?.status, 404);
    }).pipe(Effect.provide(layer));
  });

  it.effect("normalizes uppercase hostnames before validating and sending the request", () => {
    const { layer, sent } = fakeGiceServer({
      [`GET ${RAW}`]: new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    return Effect.gen(function* () {
      const media = yield* fetchMedia(`https://Code.Example/api/v1${RAW}`);
      assert.deepStrictEqual(media, { status: 200, type: "image/png", body: PNG });
      assert.deepStrictEqual(
        sent.map((request) => [request.url, request.authorization]),
        [[`https://code.example/api/v1${RAW}`, "Bearer env-token"]],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { name: "a server no credential names", url: `https://other.example/api/v1${RAW}` },
    { name: "plain HTTP to a server reached over HTTPS", url: `http://code.example/api/v1${RAW}` },
    { name: "a page outside the server's API", url: "https://code.example/acme/web/blob?path=a" },
    {
      name: "embedded URL credentials",
      url: `https://user:pass@code.example/api/v1${RAW}`,
    },
    {
      name: "path traversal leaving /api/v1/repos/",
      url: "https://code.example/api/v1/repos/../../../admin?path=a",
    },
    {
      name: "path traversal leaving /raw",
      url: "https://code.example/api/v1/repos/acme/web/raw/../../pulls/1?path=a",
    },
    {
      name: "a non-/raw API endpoint",
      url: "https://code.example/api/v1/repos/acme/web/pulls/1?path=a",
    },
  ])("sends no token to $name", ({ url }) => {
    const { layer, sent } = fakeGiceServer({});
    return Effect.gen(function* () {
      assert.isNull(yield* fetchMedia(url));
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a redirect unfollowed, since its target would not get the token", () => {
    const { layer } = fakeGiceServer({
      [`GET ${RAW}`]: new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/shot.png" },
      }),
    });
    return Effect.gen(function* () {
      assert.isNull(yield* fetchMedia(`https://code.example/api/v1${RAW}`));
    }).pipe(Effect.provide(layer));
  });
});
