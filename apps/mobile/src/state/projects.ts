import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { serverEnvironment } from "./server";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
/** What the environment's projects say about the servers its change request links are on. */
export function useChangeRequestHosts(environmentId: EnvironmentId | null) {
  return useAtomValue(environmentProjects.changeRequestHostsAtom(environmentId));
}

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
