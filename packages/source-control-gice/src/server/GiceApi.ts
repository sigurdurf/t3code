import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { definition } from "../shared/definition.ts";
import * as GiceAppSignIn from "./GiceAppSignIn.ts";
import * as GiceCredentials from "./GiceCredentials.ts";
import { decodeProblem, GiceProblem, NO_REDIRECT, SETTINGS_PATH } from "./giceHttp.ts";

const TIMEOUT = Duration.seconds(30);

export const GiceApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "forbidden",
  "rate-limited",
  "not-found",
  "failed",
]);

export class GiceApiError extends Schema.TaggedError<
  GiceApiError,
  { readonly brand: unique symbol }
>()("GiceApiError", {
  host: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: GiceApiFailure,
  detail: Schema.String,
  /** Gice's own name for the refusal, such as `head_changed`, when it gave one. */
  code: Schema.optional(Schema.String),
  /** The request field a `validation_failed` refusal is about. */
  field: Schema.optional(Schema.String),
  /** When a throttled server said to try again, in epoch milliseconds. */
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Gice ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

/** `owner/name`, each as Gice names them: never `.` or `..`, which would leave the route. */
export const REPOSITORY_NAME =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/u;

export interface GiceApiRequest {
  /** The server's hostname, with a port when it has one. */
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `owner/name`, which puts `path` below the repository's `/repos/owner/name`. */
  readonly repository?: string;
  /** Below `/api/v1` or the repository, starting with a slash and carrying any query string. */
  readonly path: string;
  readonly body?: unknown;
}

type Decodable = Schema.Codec<unknown, unknown, never, never>;

/** One page of a listing. */
export interface GiceList<A> {
  readonly items: ReadonlyArray<A>;
  /** The whole listing's length, from `X-Total-Count`; absent when the server sent none. */
  readonly total: number | undefined;
}

export class GiceApi extends Context.Service<
  GiceApi,
  {
    /** The response body as text. */
    readonly request: (input: GiceApiRequest) => Effect.Effect<string, GiceApiError>;
    /** The response body decoded as JSON of `schema`. */
    readonly read: <S extends Decodable>(
      input: GiceApiRequest,
      schema: S,
    ) => Effect.Effect<S["Type"], GiceApiError>;
    /** A page of a listing whose rows are `item`s. */
    readonly readList: <S extends Decodable>(
      input: GiceApiRequest,
      item: S,
    ) => Effect.Effect<GiceList<S["Type"]>, GiceApiError>;
  }
>()("@t3tools/source-control-gice/server/GiceApi") {}

// Gice answers every 404 with one code, so only its wording tells a missing subject apart.
const ALREADY_OFF =
  /^(?:the issue does not have that label|label not found|you have not reacted with \S+)$/u;

/** A 404 for taking off a label or reaction that is already off, not for a missing subject. */
export const isAlreadyOff = (error: { readonly reason: string; readonly detail: string }) =>
  error.reason === "not-found" && ALREADY_OFF.test(error.detail);

/** Whether a listing goes on past its first `seen` rows, of which `page` holds the last. */
export const listContinues = (page: GiceList<unknown>, seen: number, pageSize: number) =>
  page.total === undefined ? page.items.length >= pageSize : seen < page.total;

type TargetRequest = Omit<GiceApiRequest, "operation" | "host" | "repository">;

/**
 * GiceApi's calls for a caller's targets: below the repository `repositoryOf` names, when it
 * names one, with failures mapped to the caller's error by `mapError`.
 */
export function targetRequests<Target extends { readonly host: string }, E>(
  api: GiceApi["Service"],
  options: {
    readonly repositoryOf: (target: Target) => string | undefined;
    readonly mapError: (operation: string, target: Target) => (error: GiceApiError) => E;
  },
) {
  const at = (operation: string, target: Target, request: TargetRequest): GiceApiRequest => {
    const repository = options.repositoryOf(target);
    return {
      ...request,
      host: target.host,
      operation,
      ...(repository === undefined ? {} : { repository }),
    };
  };
  return {
    send: (operation: string, target: Target, request: TargetRequest) =>
      api
        .request(at(operation, target, request))
        .pipe(Effect.mapError(options.mapError(operation, target))),
    read: <S extends Decodable>(
      operation: string,
      target: Target,
      request: TargetRequest,
      schema: S,
    ) =>
      api
        .read(at(operation, target, request), schema)
        .pipe(Effect.mapError(options.mapError(operation, target))),
    readList: <S extends Decodable>(
      operation: string,
      target: Target,
      request: TargetRequest,
      item: S,
    ) =>
      api
        .readList(at(operation, target, request), item)
        .pipe(Effect.mapError(options.mapError(operation, target))),
  };
}

const reasonForStatus = (status: number): typeof GiceApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 403
      ? "forbidden"
      : status === 429
        ? "rate-limited"
        : status === 404
          ? "not-found"
          : "failed";

// A review's line comments are `comments[0].body`.
const BODY_FIELD = /(?:^|\.)body$/u;

const MAX_PROBLEM_TEXT = 300;
const problemDetail = (problem: typeof GiceProblem.Type | undefined, status: number) => {
  // Gice counts a body's bytes, where T3 Code counts its characters.
  if (
    problem?.reason === "too_long" &&
    problem.limit !== undefined &&
    BODY_FIELD.test(problem.field ?? "")
  )
    return `The text is too long for Gice: it takes at most ${problem.limit.toLocaleString("en-US")} bytes, and characters outside basic Latin take 2 to 4 bytes each.`;
  const line = problem?.message.replace(/\s+/gu, " ").trim();
  if (!line) return `Gice answered HTTP ${status}.`;
  return line.length > MAX_PROBLEM_TEXT ? `${line.slice(0, MAX_PROBLEM_TEXT)}…` : line;
};

const refusalReason = (text: string) => Option.getOrUndefined(decodeProblem(text))?.error.reason;

const SCOPE_NAME = /\b(?:repo|issues|workflows):(?:read|write|admin)\b|\baccount\b|\badmin\b/gu;

/** The scopes a 403 `insufficient_scope` names: its `WWW-Authenticate`, else its message. */
export function missingScopes(wwwAuthenticate: string | undefined, message: string) {
  const named = /\bscope="([^"]*)"/u.exec(wwwAuthenticate ?? "")?.[1];
  if (named !== undefined) return named.split(/\s+/u).filter((scope) => scope !== "");
  // Gice's workflow-file refusals name the scope only in their text: "...needs a token with the
  // workflows:write scope".
  const needs = /\bneeds? a token with the ([a-z:\s,]+?) scopes?\b/u.exec(message)?.[1] ?? "";
  return [...new Set(needs.match(SCOPE_NAME) ?? [])];
}

function refusedCredentialHint(
  credential: GiceCredentials.GiceCredential,
  reason: string | undefined,
): string | null {
  const expired = reason === "token_expired";
  switch (credential.source) {
    case "app":
      return `Gice refused the T3 Code sign-in for ${credential.host}. Sign in again in ${SETTINGS_PATH}.`;
    case "settings":
      return expired
        ? `The token saved in Settings for ${credential.host} has expired. Save a new one, or sign in instead.`
        : null;
    case "environment":
      return expired ? "The token in GICE_TOKEN has expired. Set a new one on the server." : null;
    case "cli":
      return expired
        ? `The gice CLI sign-in for ${credential.host} has expired. Run \`gice auth status\` on the server to renew it, or sign in from ${SETTINGS_PATH}.`
        : null;
  }
}

function missingScopeHint(
  credential: GiceCredentials.GiceCredential,
  missing: ReadonlyArray<string>,
): string {
  const names = missing.join(" ");
  switch (credential.source) {
    case "app":
      return `The T3 Code sign-in for ${credential.host} lacks ${names}. Sign in again in ${SETTINGS_PATH}; the new sign-in asks for it.`;
    case "settings":
      return `The token saved in Settings for ${credential.host} lacks ${names}. Save a token that has it, or sign in instead.`;
    case "environment":
      return `The token in GICE_TOKEN lacks ${names}.`;
    case "cli":
      return `The gice CLI login for ${credential.host} lacks ${names}. Sign in to the CLI again with it (\`gice auth login --scopes\`), or sign in from ${SETTINGS_PATH}.`;
  }
}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* GiceCredentials.GiceCredentials;
  const signIns = yield* GiceAppSignIn.GiceAppSignIn;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const exchange = Effect.fn("GiceApi.request")(function* (input: GiceApiRequest) {
    const fail = (
      fields: Pick<GiceApiError, "status" | "reason" | "detail" | "retryAt" | "code" | "field"> & {
        cause?: unknown;
      },
    ) =>
      new GiceApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
        ...(fields.code === undefined ? {} : { code: fields.code }),
        ...(fields.field === undefined ? {} : { field: fields.field }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    const method = input.method ?? "GET";
    yield* Effect.annotateCurrentSpan({
      "gice.host": input.host,
      "gice.operation": input.operation,
      "http.request.method": method,
    });
    if (input.repository !== undefined && !REPOSITORY_NAME.test(input.repository))
      return yield* fail({
        status: null,
        reason: "failed",
        detail: "Gice repositories are named owner/name.",
      });
    const path =
      input.repository === undefined ? input.path : `/repos/${input.repository}${input.path}`;
    // The request goes to the address the credential was issued for, never one built from `host`.
    const credentialFor = credentials.get(input.host).pipe(
      Effect.mapError((cause) =>
        fail({
          status: null,
          reason:
            cause._tag === "GiceNotSignedInError"
              ? "missing-tool"
              : cause._tag === "GiceSignInUnreachableError"
                ? "failed"
                : "unauthenticated",
          detail: cause.message,
          cause,
        }),
      ),
    );
    let credential = yield* credentialFor;
    // One pause per server, however the caller spelled its host. PullRequestService pauses a
    // project under its web URL's host, the same one, so a 429 either sees pauses both. While
    // paused, a background read fails at once; a write or a read someone waits on still goes out.
    const key = { provider: definition.kind, host: credential.host };
    const interactive = yield* SourceControlRateLimit.Interactive;
    const lease = yield* limits
      .check(key, interactive || method !== "GET" ? { allowPaused: true } : undefined)
      .pipe(
        Effect.mapError((paused) =>
          fail({
            status: null,
            reason: "rate-limited",
            detail: paused.detail,
            retryAt: paused.retryAt,
            cause: paused,
          }),
        ),
      );
    const send = (held: GiceCredentials.GiceCredential) => {
      const base = HttpClientRequest.make(method)(`${held.baseUrl}/api/v1${path}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(held.token)),
        HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
      );
      return Effect.gen(function* () {
        const response = yield* httpClient
          .execute(
            input.body === undefined
              ? base
              : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
          )
          .pipe(
            // Client spans expose query strings containing branch names.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            // fetch would carry the bearer token to any redirect target.
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
          );
        return {
          status: response.status,
          retryAfter: response.headers["retry-after"],
          totalCount: response.headers["x-total-count"],
          wwwAuthenticate: response.headers["www-authenticate"],
          text: yield* response.text,
        };
      }).pipe(
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          fail({ status: null, reason: "failed", detail: "Could not reach Gice.", cause }),
        ),
      );
    };
    let reply = yield* send(credential);
    // A refusal is reported once per token: renewing it may hand back the same one.
    let reported: string | null = null;
    if (reply.status === 401) {
      yield* credentials.rejected(credential, refusalReason(reply.text));
      reported = Redacted.value(credential.token);
      // Gice checks the token before anything else, so a refused request changed nothing and
      // goes again once with a renewed one.
      const renewed = yield* credentialFor;
      if (Redacted.value(renewed.token) !== Redacted.value(credential.token)) {
        credential = renewed;
        reply = yield* send(credential);
      }
    }
    const { status, retryAfter, totalCount, text } = reply;
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": status });
    if (status >= 200 && status < 300) {
      yield* limits.recordSuccess({ ...key, lease });
      const total = Number(totalCount);
      return {
        text,
        total:
          totalCount !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined,
      };
    }
    const retryAt =
      status === 429
        ? SourceControlRateLimit.retryAtFromHeader(retryAfter, yield* Clock.currentTimeMillis)
        : undefined;
    if (status === 429) yield* limits.recordRateLimit({ ...key, lease, retryAt });
    if (status === 401 && reported !== Redacted.value(credential.token))
      yield* credentials.rejected(credential, refusalReason(text));
    const problem = Option.getOrUndefined(decodeProblem(text))?.error;
    const missing =
      status === 403 && problem?.reason === "insufficient_scope"
        ? missingScopes(reply.wwwAuthenticate, problem.message)
        : [];
    if (missing.length > 0 && credential.source === "app")
      yield* signIns.lacks(credential.host, missing);
    const hint =
      status === 401
        ? refusedCredentialHint(credential, problem?.reason)
        : missing.length > 0
          ? missingScopeHint(credential, missing)
          : null;
    const detail = problemDetail(problem, status);
    return yield* fail({
      status,
      reason: reasonForStatus(status),
      detail: hint === null ? detail : `${detail.replace(/\.?$/u, ".")} ${hint}`,
      retryAt,
      code: problem?.code,
      field: problem?.field,
    });
  });

  const decode = <S extends Decodable>(input: GiceApiRequest, schema: S, text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(
        (cause) =>
          new GiceApiError({
            host: input.host,
            operation: input.operation,
            status: null,
            reason: "failed",
            detail: "Gice returned an unreadable response.",
            cause,
          }),
      ),
    );

  // `exchange` already traces each request.
  const request = Effect.fnUntraced(function* (input: GiceApiRequest) {
    return (yield* exchange(input)).text;
  });
  const read = <S extends Decodable>(input: GiceApiRequest, schema: S) =>
    exchange(input).pipe(Effect.flatMap(({ text }) => decode(input, schema, text)));
  const readList = <S extends Decodable>(input: GiceApiRequest, item: S) =>
    exchange(input).pipe(
      Effect.flatMap(({ text, total }) =>
        decode(input, Schema.Array(item), text).pipe(Effect.map((items) => ({ items, total }))),
      ),
    );

  return GiceApi.of({ request, read, readList });
});

export const layer = Layer.effect(GiceApi, make);
