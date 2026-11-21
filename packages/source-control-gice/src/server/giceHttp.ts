/** What every request to a Gice server shares, whichever part of the package sends it. */
import * as Schema from "effect/Schema";

/** Where the app's Gice sign-in and token live, for messages that send the user there. */
export const SETTINGS_PATH = "Settings → Source control & issues";

/** fetch would carry a token, code or cookie to any redirect target. */
export const NO_REDIRECT: RequestInit = { redirect: "manual" };

/** Gice's error object (`httpx`), the `error` of every refusal. */
export const GiceProblem = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.String,
  field: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});

export const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: GiceProblem })),
);

/** `GET /meta`: the server's features and how to reach it. */
const Meta = Schema.Struct({
  features: Schema.optional(Schema.Array(Schema.String)),
  site: Schema.optional(Schema.Struct({ version: Schema.optional(Schema.String) })),
  // Null when the server has SSH turned off.
  ssh: Schema.optional(Schema.NullOr(Schema.Struct({ host: Schema.String }))),
  oauth: Schema.optional(
    Schema.Struct({
      device_authorization_endpoint: Schema.optional(Schema.String),
      token_endpoint: Schema.optional(Schema.String),
      revocation_endpoint: Schema.optional(Schema.String),
    }),
  ),
});

export const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
