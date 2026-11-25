import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { definition } from "../shared/definition.ts";
import * as GiceCredentials from "./GiceCredentials.ts";
import { NO_REDIRECT } from "./giceHttp.ts";

/**
 * Fetches a file `mediaUrl` claimed with the token of the server it is on. Null for a host no
 * credential names, and for a URL outside the API of the address the token was issued for.
 */
export const make = Effect.gen(function* () {
  const credentials = yield* GiceCredentials.GiceCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  return Effect.fn("GiceMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const url = URL.parse(request.url);
    if (url === null || url.username !== "" || url.password !== "") return null;
    if (definition.mediaUrl?.(url) == null) return null;
    // Read on every fetch, so media loads as soon as the user saves a token.
    const credential = yield* credentials.get(url.host).pipe(Effect.orElseSucceed(() => null));
    if (credential === null || !url.href.startsWith(`${credential.baseUrl}/api/v1/repos/`))
      return null;
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(url.href).pipe(
          HttpClientRequest.setHeaders({
            ...request.headers,
            // The bytes are streamed straight through, so never let an encoding layer in.
            "accept-encoding": "identity",
            "user-agent": "t3code",
          }),
          HttpClientRequest.bearerToken(Redacted.value(credential.token)),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      );
    // Gice serves a file without redirecting; one that does would leave the token behind.
    return response.status >= 300 && response.status < 400 ? null : response;
  });
});
