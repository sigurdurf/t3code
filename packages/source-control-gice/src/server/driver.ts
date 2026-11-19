import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as GiceApi from "./GiceApi.ts";
import * as GiceCredentials from "./GiceCredentials.ts";
import * as GicePullRequestProvider from "./GicePullRequestProvider.ts";
import * as GiceSourceControlProvider from "./GiceSourceControlProvider.ts";

const services = GiceApi.layer.pipe(Layer.provideMerge(GiceCredentials.layer));

const makeInstance = Effect.all({
  sourceControl: GiceSourceControlProvider.make,
  discovery: GiceSourceControlProvider.makeDiscovery,
  pullRequests: GicePullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
