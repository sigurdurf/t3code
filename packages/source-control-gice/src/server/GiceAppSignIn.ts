import {
  SourceControlSignInError,
  type SourceControlSignInFailure,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as GiceClient from "../shared/definition.ts";
import { decodeMeta, decodeProblem, NO_REDIRECT, SETTINGS_PATH } from "./giceHttp.ts";

/** Gice has no client registration: the id only has to stay the same for a sign-in's refreshes. */
const CLIENT_ID = "t3code";
/**
 * Pushing and merging, pull requests, and workflow files, which agents edit and re-runs need.
 * Never `account` (full control of the account) or `admin`.
 */
const DEFAULT_SCOPES = ["repo:write", "issues:write", "workflows:write"] as const;
const NEVER_ASKED: ReadonlySet<string> = new Set(["account", "admin"]);

const KIND = GiceClient.definition.kind;
const REQUEST_TIMEOUT = Duration.seconds(15);
// Refresh ahead of expiry so a token never lapses between the check and a long request.
const REFRESH_MARGIN_MS = Duration.toMillis(Duration.minutes(5));

const GiceAppSession = Schema.Struct({
  baseUrl: Schema.String,
  accessToken: Schema.String,
  accessTokenExpiresAt: Schema.Number,
  refreshToken: Schema.String,
  refreshTokenExpiresAt: Schema.Number,
  /** Granted, as Gice wrote it. */
  scope: Schema.String,
  /**
   * Saved before a refresh goes out and cleared with its answer. A refresh token works once, so
   * one whose answer was lost must not be sent again: replaying it ends the sign-in.
   */
  refreshing: Schema.optionalKey(Schema.Boolean),
});
type GiceAppSession = typeof GiceAppSession.Type;

const GiceAppSessionJson = Schema.fromJsonString(GiceAppSession);
const decodeSession = Schema.decodeUnknownOption(GiceAppSessionJson);
const encodeSession = Schema.encodeSync(GiceAppSessionJson);

// RFC 6749 and RFC 8628 answers, success or error, with Gice's `interval` on `slow_down`.
const OAuthAnswer = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  device_code: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  verification_uri_complete: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});
type OAuthAnswer = typeof OAuthAnswer.Type;
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthAnswer));

const decodeUser = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ username: Schema.String })),
);

/** The sign-in for a host ended: the user has to sign in again. */
export class GiceSignInEndedError extends Schema.TaggedError<
  GiceSignInEndedError,
  { readonly brand: unique symbol }
>()("GiceSignInEndedError", { host: Schema.String, detail: Schema.String }) {
  override get message(): string {
    return this.detail;
  }
}

/** The access token lapsed and the server could not be reached to renew it; nothing was lost. */
export class GiceSignInUnreachableError extends Schema.TaggedError<
  GiceSignInUnreachableError,
  { readonly brand: unique symbol }
>()("GiceSignInUnreachableError", { host: Schema.String, cause: Schema.Defect() }) {
  override get message(): string {
    return `Could not reach ${this.host} to renew the Gice sign-in. T3 Code tries again with the next request.`;
  }
}

export interface GiceAppToken extends GiceClient.GiceServer {
  readonly token: string;
}

export class GiceAppSignIn extends Context.Service<
  GiceAppSignIn,
  {
    /** The servers with a saved sign-in, by the address each was signed in at. */
    readonly servers: Effect.Effect<ReadonlyArray<GiceClient.GiceServer>>;
    /** The access token for `host`, renewed when due; none when not signed in. */
    readonly token: (
      host: string,
    ) => Effect.Effect<
      Option.Option<GiceAppToken>,
      GiceSignInEndedError | GiceSignInUnreachableError
    >;
    /** Renews on the next `token` when `rejected` is the token a server just refused. */
    readonly rejected: (host: string, rejected: string) => Effect.Effect<void>;
    /** Remembers scopes a server said the sign-in lacks, so the next sign-in asks for them. */
    readonly lacks: (host: string, scopes: ReadonlyArray<string>) => Effect.Effect<void>;
    /** What the user should know about each host's sign-in: why it ended, or what it lacks. */
    readonly notes: Effect.Effect<ReadonlyMap<string, string>>;
    readonly start: (
      address: string,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    /** The account the sign-in `start` began signed in to, once it has been saved. */
    readonly wait: (address: string) => Effect.Effect<string, SourceControlSignInError>;
    readonly cancel: (address: string) => Effect.Effect<void>;
    readonly signOut: (address: string) => Effect.Effect<void, SourceControlSignInError>;
  }
>()("@t3tools/source-control-gice/server/GiceAppSignIn") {}

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<string, SourceControlSignInError>;
  readonly fiber: Fiber.Fiber<boolean>;
}

interface Exchange {
  readonly status: number;
  readonly text: string;
  readonly retryAfter: string | undefined;
}

const signInError = (host: string, reason: SourceControlSignInFailure, detail: string) =>
  new SourceControlSignInError({ provider: KIND, host, reason, detail });

/** Whether `link` is a web address below `baseUrl`, so opening it reaches only that server. */
function isBelow(link: string | undefined, baseUrl: string): link is string {
  const url = URL.parse(link ?? "");
  const base = URL.parse(baseUrl);
  return (
    url !== null &&
    base !== null &&
    url.origin === base.origin &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === base.pathname ||
      url.pathname.startsWith(`${base.pathname.replace(/\/$/u, "")}/`))
  );
}

/** `T3 Code on <machine>`, kept to what Gice accepts as a `client_name` and cannot turn into a link. */
export function clientName(hostname: string): string {
  const machine = hostname
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]/gu, "")
    .slice(0, 40);
  return machine === "" ? "T3 Code" : `T3 Code on ${machine}`;
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const userAgent = `T3Code (${yield* HostProcess.Platform}; ${yield* HostProcess.Architecture})`;
  const name = clientName(yield* HostProcess.Hostname);
  // One at a time per server: refreshing, saving a new sign-in and signing out each replace what
  // is stored for it, and a refresh token replayed by a second refresh ends the sign-in. Holders
  // wait on the network, so one server that does not answer must not hold up another's.
  const hostLocks = new Map<string, Semaphore.Semaphore>();
  const hostLock = (host: string) => {
    let lock = hostLocks.get(host);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      hostLocks.set(host, lock);
    }
    return lock.withPermits(1);
  };
  // Settings hold every server's sign-in in one map, so each write is a short read-modify-write
  // of its own, never held across a request.
  const settingsLock = yield* Semaphore.make(1);
  // At most one refused access token per host; cleared when the host's session changes or ends.
  const refused = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const ended = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const wanted = yield* Ref.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  // A refreshed session whose save failed, with the refresh token stored before it.
  const unsaved = yield* Ref.make<
    ReadonlyMap<string, { readonly from: string; readonly session: GiceAppSession }>
  >(new Map());
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());

  const exchange = (request: HttpClientRequest.HttpClientRequest) =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": userAgent }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (text): Exchange => ({
            status: response.status,
            text,
            retryAfter: response.headers["retry-after"],
          })),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        // Spans would carry the URL; the token and codes travel in bodies and headers only.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        // fetch would carry a code or token to any redirect target.
        Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
      );

  const postForm = (baseUrl: string, path: string, form: Record<string, string>) =>
    exchange(
      HttpClientRequest.post(`${baseUrl}/api/v1/oauth${path}`).pipe(
        HttpClientRequest.bodyUrlParams(form),
      ),
    ).pipe(
      Effect.map((reply) => ({
        ...reply,
        answer: Option.getOrElse(decodeAnswer(reply.text), (): OAuthAnswer => ({})),
      })),
    );

  const getJson = (baseUrl: string, path: string, token?: string) =>
    exchange(
      HttpClientRequest.get(`${baseUrl}/api/v1${path}`).pipe(
        token === undefined ? (request) => request : HttpClientRequest.bearerToken(token),
      ),
    );

  const readSignIns = sourceControlHost.settings.get.pipe(
    Effect.map(
      (settings) =>
        readSourceControlHostSettings(GiceClient.settings, settings.sourceControlHosts[KIND])
          .signIns,
    ),
    Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
  );

  const readStored = (host: string) =>
    readSignIns.pipe(Effect.map((signIns) => decodeSession(signIns[host] ?? "")));

  /** The session to use for `host` and the refresh token Settings holds for it. */
  const current = Effect.fnUntraced(function* (host: string) {
    const stored = yield* readStored(host);
    const entry = (yield* Ref.get(unsaved)).get(host);
    if (Option.isNone(stored)) return Option.none();
    if (entry !== undefined && entry.from === stored.value.refreshToken)
      return Option.some({ session: entry.session, stored: entry.from });
    return Option.some({ session: stored.value, stored: stored.value.refreshToken });
  });

  const clearRefused = (host: string, keepToken?: string) =>
    Ref.update(refused, (map) => {
      const held = map.get(host);
      if (held === undefined || (keepToken !== undefined && held === keepToken)) return map;
      const copy = new Map(map);
      copy.delete(host);
      return copy;
    });

  const replaceStored = Effect.fnUntraced(function* (
    host: string,
    expected: string | null,
    next: GiceAppSession | null,
  ) {
    const signIns = { ...(yield* readSignIns) };
    if (
      expected !== null &&
      decodeSession(signIns[host] ?? "").pipe(
        Option.map((s) => s.refreshToken),
        Option.getOrNull,
      ) !== expected
    )
      return false;
    if (next === null) delete signIns[host];
    else signIns[host] = encodeSession(next);
    yield* sourceControlHost.settings.update({ sourceControlHosts: { [KIND]: { signIns } } });
    yield* clearRefused(host, next?.accessToken);
    yield* Ref.update(unsaved, (map) => {
      const copy = new Map(map);
      copy.delete(host);
      return copy;
    });
    return true;
  });

  /**
   * Replaces what Settings holds for `host` while it is still the sign-in `expected` names (its
   * refresh token), so a sign-out or a newer sign-in meanwhile is not undone. Null `expected`
   * replaces unconditionally.
   */
  const write = Effect.fn("GiceAppSignIn.write")(function* (
    host: string,
    expected: string | null,
    next: GiceAppSession | null,
  ) {
    return yield* settingsLock.withPermits(1)(replaceStored(host, expected, next));
  });

  const setNote = (host: string, note: string | null) =>
    Ref.update(ended, (map) => {
      const copy = new Map(map);
      if (note === null) copy.delete(host);
      else copy.set(host, note);
      return copy;
    });

  const revoke = (session: GiceAppSession) =>
    postForm(session.baseUrl, "/revoke", {
      token: session.refreshToken,
      client_id: CLIENT_ID,
    }).pipe(
      // 400 says the token is not this app's sign-in, which leaves nothing to end.
      Effect.map((reply) => reply.status === 200 || reply.status === 400),
      Effect.orElseSucceed(() => false),
    );

  /** Forgets the sign-in and says why; the user signs in again. */
  const end = Effect.fn("GiceAppSignIn.end")(function* (
    host: string,
    stored: string,
    detail: string,
  ) {
    yield* Effect.logWarning("The Gice sign-in ended; signing out.", { host });
    yield* write(host, stored, null).pipe(Effect.ignore);
    yield* clearRefused(host);
    yield* setNote(host, detail);
    return yield* new GiceSignInEndedError({ host, detail });
  });

  const sessionFrom = (baseUrl: string, now: number, answer: OAuthAnswer): GiceAppSession | null =>
    answer.access_token === undefined || answer.refresh_token === undefined
      ? null
      : {
          baseUrl,
          accessToken: answer.access_token,
          accessTokenExpiresAt: now + (answer.expires_in ?? 0) * 1_000,
          refreshToken: answer.refresh_token,
          refreshTokenExpiresAt: now + (answer.refresh_token_expires_in ?? 0) * 1_000,
          scope: answer.scope ?? "",
        };

  const unreachable = (host: string) => (cause: unknown) =>
    new GiceSignInUnreachableError({ host, cause });

  /** Renews `session`, which `stored` names in Settings. Runs under the host's lock. */
  const refresh = Effect.fn("GiceAppSignIn.refresh")(function* (
    host: string,
    session: GiceAppSession,
    stored: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const again = `Sign in again in ${SETTINGS_PATH}.`;
    if (session.refreshTokenExpiresAt <= now)
      return yield* end(
        host,
        stored,
        `The Gice sign-in for ${host} ended after 90 days without use. ${again}`,
      );
    if (session.refreshing === true) {
      // The last refresh went out and its answer never came. If Gice took it, the stored access
      // token was replaced and is unknown now; if not, it still works or has only expired.
      const probe = yield* getJson(session.baseUrl, "/user/token", session.accessToken).pipe(
        Effect.mapError(unreachable(host)),
      );
      const reason = decodeProblem(probe.text).pipe(
        Option.flatMap((p) => Option.fromUndefinedOr(p.error.reason)),
        Option.getOrUndefined,
      );
      if (probe.status === 401 && reason !== "token_expired") {
        // Ending it with the used refresh token cleans up at Gice without reporting a replay.
        yield* revoke(session);
        return yield* end(
          host,
          stored,
          `The Gice sign-in for ${host} ended while T3 Code was renewing it: Gice's answer did not arrive, or the sign-in was revoked. ${again}`,
        );
      }
      if (probe.status !== 200 && probe.status !== 401)
        return yield* new GiceSignInUnreachableError({
          host,
          cause: new Error(`Gice answered HTTP ${probe.status}.`),
        });
    }
    const marked = { ...session, refreshing: true };
    // Never send a refresh that is not on record as sent.
    if (!(yield* write(host, stored, marked).pipe(Effect.mapError(unreachable(host)))))
      return Option.none<GiceAppToken>();
    const reply = yield* postForm(session.baseUrl, "/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: CLIENT_ID,
    }).pipe(Effect.mapError(unreachable(host)));
    const next =
      reply.status === 200
        ? sessionFrom(session.baseUrl, yield* Clock.currentTimeMillis, reply.answer)
        : null;
    if (next === null) {
      if (reply.answer.error === "invalid_grant")
        return yield* end(
          host,
          session.refreshToken,
          `Gice ended the sign-in for ${host}${reply.answer.error_description ? ` (${reply.answer.error_description})` : ""}. ${again}`,
        );
      // Anything else may or may not have been taken; the mark stays so the next try checks.
      return yield* new GiceSignInUnreachableError({
        host,
        cause: new Error(`Gice answered HTTP ${reply.status} ${reply.answer.error ?? ""}`.trim()),
      });
    }
    // Gice has retired the old pair, so until it is saved the new one lives here.
    yield* clearRefused(host, next.accessToken);
    yield* Ref.update(unsaved, (map) =>
      new Map(map).set(host, { from: session.refreshToken, session: next }),
    );
    yield* write(host, session.refreshToken, next).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced(Duration.millis(250)) }),
      Effect.catch((cause) =>
        Effect.logError("Could not save the renewed Gice sign-in; using it unsaved.", {
          host,
          cause,
        }),
      ),
    );
    return Option.some<GiceAppToken>({ host, baseUrl: next.baseUrl, token: next.accessToken });
  });

  const isFresh = (session: GiceAppSession, now: number) =>
    now < session.accessTokenExpiresAt - REFRESH_MARGIN_MS;

  const token: GiceAppSignIn["Service"]["token"] = Effect.fn("GiceAppSignIn.token")(
    function* (host) {
      const found = yield* current(host);
      if (Option.isNone(found)) return Option.none();
      const { session } = found.value;
      const now = yield* Clock.currentTimeMillis;
      if (isFresh(session, now) && (yield* Ref.get(refused)).get(host) !== session.accessToken) {
        if ((yield* Ref.get(unsaved)).has(host))
          // A renewed session that could not be saved: try again, it is all that works now.
          yield* hostLock(host)(write(host, found.value.stored, session)).pipe(Effect.ignore);
        return Option.some({ host, baseUrl: session.baseUrl, token: session.accessToken });
      }
      return yield* hostLock(host)(
        Effect.gen(function* () {
          // Another request may have renewed it while this one queued.
          const latest = yield* current(host);
          if (Option.isNone(latest)) return Option.none<GiceAppToken>();
          const { session, stored } = latest.value;
          const refusedTokens = yield* Ref.get(refused);
          const now = yield* Clock.currentTimeMillis;
          const usable =
            refusedTokens.get(host) !== session.accessToken && now < session.accessTokenExpiresAt;
          if (usable && isFresh(session, now))
            return Option.some<GiceAppToken>({
              host,
              baseUrl: session.baseUrl,
              token: session.accessToken,
            });
          // A refresh ahead of expiry that cannot reach Gice leaves the still-valid token in use.
          return yield* refresh(host, session, stored).pipe(
            Effect.catchTags({
              GiceSignInUnreachableError: (error) =>
                usable
                  ? Effect.succeedSome<GiceAppToken>({
                      host,
                      baseUrl: session.baseUrl,
                      token: session.accessToken,
                    })
                  : Effect.fail(error),
            }),
          );
        }),
      );
    },
  );

  const rejected: GiceAppSignIn["Service"]["rejected"] = Effect.fn("GiceAppSignIn.rejected")(
    function* (host, rejectedToken) {
      const found = yield* current(host);
      // A refused token saved by hand or read from the CLI says nothing about the sign-in.
      if (Option.isNone(found) || found.value.session.accessToken !== rejectedToken) return;
      yield* Ref.update(refused, (map) => new Map(map).set(host, rejectedToken));
    },
  );

  const lacks: GiceAppSignIn["Service"]["lacks"] = (host, scopes) =>
    Ref.update(wanted, (map) =>
      new Map(map).set(
        host,
        new Set([...(map.get(host) ?? []), ...scopes.filter((name) => !NEVER_ASKED.has(name))]),
      ),
    );

  const notes: GiceAppSignIn["Service"]["notes"] = Effect.gen(function* () {
    const result = new Map(yield* Ref.get(ended));
    const signIns = yield* readSignIns;
    for (const [host, missing] of yield* Ref.get(wanted)) {
      if (signIns[host] === undefined || missing.size === 0) continue;
      const names = [...missing].join(", ");
      result.set(
        host,
        `The Gice sign-in for ${host} is not allowed to do everything T3 Code tried: it lacks ${names}. Sign in again in ${SETTINGS_PATH} to grant it.`,
      );
    }
    return result;
  });

  const servers: GiceAppSignIn["Service"]["servers"] = readSignIns.pipe(
    Effect.map((signIns) =>
      Object.entries(signIns).flatMap(([host, value]) =>
        decodeSession(value).pipe(
          Option.map((session) => [{ host, baseUrl: session.baseUrl }]),
          Option.getOrElse(() => []),
        ),
      ),
    ),
  );

  const failed = (host: string, detail: string) => (cause: unknown) =>
    new SourceControlSignInError({ provider: KIND, host, reason: "failed", detail, cause });

  const poll = Effect.fn("GiceAppSignIn.poll")(function* (
    server: GiceClient.GiceServer,
    deviceCode: string,
    expiresAt: number,
    initialInterval: number,
  ) {
    const { host, baseUrl } = server;
    const expired = () => signInError(host, "expired", "The sign-in code expired. Start again.");
    let interval = initialInterval;
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval));
      if ((yield* Clock.currentTimeMillis) >= expiresAt) return yield* expired();
      const attempt = yield* postForm(baseUrl, "/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }).pipe(Effect.option);
      // A dropped poll is retried on the next tick; the code stays valid until it expires.
      if (Option.isNone(attempt) || attempt.value.status >= 500) continue;
      const { answer, status } = attempt.value;
      const session =
        status === 200 ? sessionFrom(baseUrl, yield* Clock.currentTimeMillis, answer) : null;
      if (session !== null) {
        const user = yield* getJson(baseUrl, "/user", session.accessToken).pipe(
          Effect.map((reply) => (reply.status === 200 ? decodeUser(reply.text) : Option.none())),
          Effect.orElseSucceed(() => Option.none()),
        );
        const previous = yield* hostLock(host)(
          Effect.gen(function* () {
            const before = yield* current(host);
            yield* write(host, null, session);
            return before;
          }),
        ).pipe(Effect.mapError(failed(host, "The server could not save the sign-in.")));
        yield* setNote(host, null);
        yield* Ref.update(wanted, (map) => {
          const copy = new Map(map);
          copy.delete(host);
          return copy;
        });
        // The sign-in this one replaces would otherwise stay listed at Gice for 90 days.
        if (Option.isSome(previous)) yield* revoke(previous.value.session);
        if (Option.isNone(user))
          return yield* signInError(
            host,
            "failed",
            "Signed in, but Gice would not say which account it belongs to.",
          );
        return user.value.username;
      }
      switch (answer.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval = answer.interval ?? interval + 5;
          continue;
        case "expired_token":
          return yield* expired();
        case "access_denied":
          return yield* signInError(host, "denied", "The sign-in was denied on Gice.");
        case "invalid_grant":
          // Gice drops the oldest unopened requests of the busiest networks when it is full.
          return yield* signInError(
            host,
            "failed",
            "Gice no longer knows this sign-in code, which happens when it is busy. Start again.",
          );
        default:
          return yield* signInError(
            host,
            "failed",
            answer.error_description ??
              `Gice refused the sign-in (${answer.error ?? `HTTP ${status}`}).`,
          );
      }
    }
  });

  const namedServer = (address: string) => {
    const server = GiceClient.parseGiceServer(address);
    return server === null
      ? Effect.fail(
          signInError(
            address,
            "unsupported",
            "Enter your Gice server's address, such as https://gice.example.com.",
          ),
        )
      : Effect.succeed(server);
  };

  const askedScopes = (host: string) =>
    Ref.get(wanted).pipe(
      Effect.map((map) => [...new Set([...DEFAULT_SCOPES, ...(map.get(host) ?? [])])]),
    );

  const start: GiceAppSignIn["Service"]["start"] = Effect.fn("GiceAppSignIn.start")(
    function* (address) {
      const server = yield* namedServer(address);
      const { host, baseUrl } = server;
      const unreachableServer = failed(host, `Could not reach ${baseUrl}.`);
      const meta = yield* getJson(baseUrl, "/meta").pipe(Effect.mapError(unreachableServer));
      const decoded =
        meta.status === 200 ? Option.getOrUndefined(decodeMeta(meta.text)) : undefined;
      if (decoded === undefined)
        return yield* signInError(host, "failed", `${baseUrl} does not answer as a Gice server.`);
      if (!decoded.features?.includes("device_flow"))
        return yield* signInError(
          host,
          "unsupported",
          `The Gice server at ${host} cannot sign apps in yet. Update Gice there, or save a token instead.`,
        );
      // Codes and tokens go only to the address the user named; a server that calls itself by
      // another name is signed in to by that name.
      const named = decoded.oauth?.device_authorization_endpoint;
      if (named !== `${baseUrl}/api/v1/oauth/device/code`) {
        const other = URL.parse(named ?? "");
        return yield* signInError(
          host,
          "failed",
          other === null
            ? `The Gice server at ${host} did not say where to sign in.`
            : `The Gice server at ${host} calls itself ${other.origin}. Sign in with that address.`,
        );
      }
      const scopes = yield* askedScopes(host);
      const reply = yield* postForm(baseUrl, "/device/code", {
        client_id: CLIENT_ID,
        client_name: name,
        scope: scopes.join(" "),
      }).pipe(Effect.mapError(unreachableServer));
      const { answer } = reply;
      const wait = Number(reply.retryAfter);
      if (reply.status === 429 || reply.status === 503)
        return yield* signInError(
          host,
          "failed",
          reply.status === 429
            ? `Gice is limiting sign-ins from this network. Try again${Number.isFinite(wait) ? ` in ${Math.max(1, Math.ceil(wait / 60))} minutes` : " later"}.`
            : "Gice has too many sign-ins waiting. Try again in a minute.",
        );
      if (
        reply.status !== 200 ||
        answer.device_code === undefined ||
        answer.user_code === undefined ||
        answer.expires_in === undefined
      )
        return yield* signInError(
          host,
          "failed",
          answer.error_description ??
            `Gice would not start the sign-in (${answer.error ?? `HTTP ${reply.status}`}).`,
        );
      if (!isBelow(answer.verification_uri, baseUrl))
        return yield* signInError(
          host,
          "failed",
          `Gice sent a sign-in page that is not on ${baseUrl}, so T3 Code will not open it.`,
        );
      const complete = isBelow(answer.verification_uri_complete, baseUrl)
        ? answer.verification_uri_complete
        : undefined;
      const expiresAt = (yield* Clock.currentTimeMillis) + answer.expires_in * 1_000;
      const deferred = yield* Deferred.make<string, SourceControlSignInError>();
      const fiber = yield* poll(server, answer.device_code, expiresAt, answer.interval ?? 5).pipe(
        Deferred.into(deferred),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(pending, (map) => [
        map.get(host),
        new Map(map).set(host, { deferred, fiber }),
      ]);
      if (previous !== undefined) {
        yield* Deferred.fail(
          previous.deferred,
          signInError(host, "failed", "A newer sign-in replaced this one."),
        );
        yield* Fiber.interrupt(previous.fiber);
      }
      return {
        userCode: answer.user_code,
        verificationUri: answer.verification_uri,
        ...(complete === undefined ? {} : { verificationUriComplete: complete }),
        expiresAt,
        scopes,
      } satisfies SourceControlSignInPrompt;
    },
  );

  const wait: GiceAppSignIn["Service"]["wait"] = Effect.fn("GiceAppSignIn.wait")(
    function* (address) {
      const { host } = yield* namedServer(address);
      const entry = (yield* Ref.get(pending)).get(host);
      if (entry === undefined)
        return yield* signInError(host, "not-started", "No sign-in is in progress. Start again.");
      return yield* Deferred.await(entry.deferred);
    },
  );

  const cancel: GiceAppSignIn["Service"]["cancel"] = Effect.fn("GiceAppSignIn.cancel")(
    function* (address) {
      const server = GiceClient.parseGiceServer(address);
      const entry = server === null ? undefined : (yield* Ref.get(pending)).get(server.host);
      if (server === null || entry === undefined) return;
      yield* Deferred.fail(
        entry.deferred,
        signInError(server.host, "cancelled", "The sign-in was cancelled."),
      );
      yield* Fiber.interrupt(entry.fiber);
    },
  );

  const signOut: GiceAppSignIn["Service"]["signOut"] = Effect.fn("GiceAppSignIn.signOut")(
    function* (address) {
      const { host } = yield* namedServer(address);
      const found = yield* hostLock(host)(
        Effect.gen(function* () {
          const before = yield* current(host);
          yield* write(host, null, null);
          return before;
        }),
      ).pipe(Effect.mapError(failed(host, "The server could not save the sign-out.")));
      yield* clearRefused(host);
      yield* setNote(host, null);
      if (Option.isNone(found) || (yield* revoke(found.value.session))) return;
      return yield* signInError(
        host,
        "failed",
        `Signed out here, but T3 Code could not reach ${host} to end the sign-in there. Revoke it under Settings → Access tokens on ${host}.`,
      );
    },
  );

  return GiceAppSignIn.of({
    servers,
    token,
    rejected,
    lacks,
    notes,
    start,
    wait,
    cancel,
    signOut,
  });
});

export const layer = Layer.effect(GiceAppSignIn, make);
