import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as GiceCredentials from "./GiceCredentials.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);

export const GiceApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class GiceApiError extends Schema.TaggedError<GiceApiError>()("GiceApiError", {
  host: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: GiceApiFailure,
  /** Gice's `error.code` when the server answered with one, such as `conflict`. */
  code: Schema.NullOr(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Gice ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

export interface GiceApiRequest {
  /** The server's hostname, with a port when it has one. */
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below `/api/v1`, starting with a slash and carrying any query string. */
  readonly path: string;
  readonly body?: unknown;
}

/**
 * The optional API capabilities a server advertises in `GET /meta`. A server that predates the
 * list has none of them, which is also the answer while it cannot be asked.
 */
export type GiceFeature =
  | "labels"
  | "reactions"
  | "events"
  | "check_jobs"
  | "comment_meta"
  | "avatars"
  | "pull_stats"
  | "pull_drafts"
  | "pull_filters"
  | "pull_labels_filter"
  | "pull_file_paging"
  | "pull_merge_options"
  | "pull_update_branch"
  | "pull_auto_merge"
  | "pull_viewer_permissions"
  | "pull_reviews"
  | "pull_review_comments"
  | "pull_review_threads"
  | "pull_reviewer_requests"
  | "review_comment_reactions"
  | "reaction_delete_by_content"
  | "pull_review_requested_filter"
  | "pull_merge_message"
  | "pull_auto_merge_expected_head";

export interface GiceFeatures {
  readonly has: (feature: GiceFeature) => boolean;
}

export class GiceApi extends Context.Service<
  GiceApi,
  {
    /** The response body as text. */
    readonly request: (input: GiceApiRequest) => Effect.Effect<string, GiceApiError>;
    /** What the server on `host` can do beyond the original API. */
    readonly features: (host: string) => Effect.Effect<GiceFeatures>;
  }
>()("@t3tools/source-control-gice/server/GiceApi") {}

const decodeMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ features: Schema.optional(Schema.Array(Schema.String)) })),
);

// A server is upgraded without T3 Code restarting, so its answer is only trusted this long.
const FEATURES_TTL = Duration.minutes(1);

/** Reads and remembers each host's features through `request`. */
export const makeFeatures = Effect.fn("GiceApi.makeFeatures")(function* (
  request: (input: GiceApiRequest) => Effect.Effect<string, GiceApiError>,
) {
  const cache = yield* Cache.makeWith(
    (host: string) =>
      request({ host, operation: "features", path: "/meta" }).pipe(
        Effect.map((text): ReadonlySet<string> | null => {
          const meta = Option.getOrUndefined(decodeMeta(text));
          return meta === undefined ? null : new Set(meta.features ?? []);
        }),
        Effect.orElseSucceed(() => null),
      ),
    {
      capacity: 32,
      // An unanswered question is asked again by the next caller.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? FEATURES_TTL : Duration.zero,
    },
  );
  return (host: string): Effect.Effect<GiceFeatures> =>
    Cache.get(cache, host.trim().toLowerCase()).pipe(
      Effect.map((features) => ({ has: (feature) => features?.has(feature) === true })),
    );
});

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    }),
  ),
);

const reasonForStatus = (status: number): typeof GiceApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

const MAX_PROBLEM_TEXT = 300;
const boundedProblemText = (text: string | undefined) => {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_PROBLEM_TEXT ? `${line.slice(0, MAX_PROBLEM_TEXT)}…` : line;
};

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* GiceCredentials.GiceCredentials;

  const request = Effect.fn("GiceApi.request")(function* (input: GiceApiRequest) {
    const fail = (
      fields: Pick<GiceApiError, "status" | "reason" | "detail"> & {
        code?: string | undefined;
        cause?: unknown;
      },
    ) =>
      new GiceApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        code: fields.code ?? null,
        detail: fields.detail,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    const method = input.method ?? "GET";
    yield* Effect.annotateCurrentSpan({
      "gice.host": input.host,
      "gice.operation": input.operation,
      "http.request.method": method,
    });
    // The request goes to the address the credential was issued for, never one built from `host`.
    const credential = yield* credentials.get(input.host).pipe(
      Effect.mapError((cause) =>
        fail({
          status: null,
          reason: cause._tag === "GiceNotSignedInError" ? "unauthenticated" : "failed",
          detail: cause.message,
          cause,
        }),
      ),
    );
    const base = HttpClientRequest.make(method)(`${credential.baseUrl}/api/v1${input.path}`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(credential.token)),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
    );
    const { status, text } = yield* Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
        )
        .pipe(
          // Client spans expose query strings containing branch names.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          // fetch would carry the bearer token to any redirect target.
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        );
      return { status: response.status, text: yield* response.text };
    }).pipe(
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) =>
        fail({ status: null, reason: "failed", detail: "Could not reach Gice.", cause }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": status });
    if (status >= 200 && status < 300) return text;
    const problem = Option.getOrUndefined(decodeProblem(text))?.error;
    return yield* fail({
      status,
      reason: reasonForStatus(status),
      code: problem?.code,
      detail: boundedProblemText(problem?.message) ?? `Gice answered HTTP ${status}.`,
    });
  });

  return GiceApi.of({ request, features: yield* makeFeatures(request) });
});

export const layer = Layer.effect(GiceApi, make);
