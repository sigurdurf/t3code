/** What every request to a Gice server shares, whichever part of the package sends it. */
import * as Schema from "effect/Schema";

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
});

export const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
