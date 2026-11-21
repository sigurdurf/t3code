import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  ProjectId,
  ScopedProjectRef,
  ServerConfig,
} from "@t3tools/contracts";
import {
  NO_CHANGE_REQUEST_HOSTS,
  type ChangeRequestHosts,
} from "@t3tools/source-control-core/shared/definition";
import { Atom } from "effect/reactivity";

import { sourceControlClients } from "../sourceControlClients.ts";

import type { EnvironmentProject } from "./models.ts";
import { scopeProject } from "./models.ts";
import { isScratchProject } from "./projects.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { arrayElementsEqual, parseProjectKey, projectKey, projectRefsEqual } from "./entities.ts";

const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = Object.freeze([]);
const EMPTY_PROJECT_INDEX: ReadonlyMap<ProjectId, OrchestrationProjectShell> = new Map();
const NO_ENVIRONMENT_HOSTS_ATOM = Atom.make(NO_CHANGE_REQUEST_HOSTS);

function sameHosts(left: ChangeRequestHosts, right: ChangeRequestHosts): boolean {
  if (left.size !== right.size) return false;
  for (const [host, kind] of left) {
    if (right.get(host) !== kind) return false;
  }
  return true;
}

export function createEnvironmentProjectAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly serverConfigValueAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Pick<ServerConfig, "scratchWorkspaceRoot"> | null>;
}) {
  const environmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationProjectShell> =>
        get(input.snapshotAtom(environmentId))?.projects ?? EMPTY_PROJECTS,
    ).pipe(Atom.withLabel(`environment-projects:${environmentId}`)),
  );

  const environmentProjectIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ProjectId, OrchestrationProjectShell> => {
      const projects = get(environmentProjectsAtom(environmentId));
      if (projects.length === 0) {
        return EMPTY_PROJECT_INDEX;
      }
      return new Map(projects.map((project) => [project.id, project] as const));
    }).pipe(Atom.withLabel(`environment-project-index:${environmentId}`)),
  );

  // Kept while the projects' servers stay the same, so link readers skip other project changes.
  const environmentChangeRequestHostsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = NO_CHANGE_REQUEST_HOSTS;
    return Atom.make((get) => {
      const next = sourceControlClients.changeRequestHosts(
        get(environmentProjectsAtom(environmentId)).flatMap((project) => [
          project.repositoryIdentity,
          ...(project.trackedRepositoryIdentities ?? []),
        ]),
      );
      if (!sameHosts(previous, next)) previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-change-request-hosts:${environmentId}`));
  });

  const environmentProjectRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedProjectRef> = [];
    return Atom.make((get) => {
      const next = get(environmentProjectsAtom(environmentId)).map((project) => ({
        environmentId,
        projectId: project.id,
      }));
      if (projectRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-project-refs:${environmentId}`));
  });

  const projectAtomFamily = Atom.family((key: string) => {
    const ref = parseProjectKey(key);
    let previousSource: OrchestrationProjectShell | null = null;
    let previousIsScratch = false;
    let previousValue: EnvironmentProject | null = null;
    return Atom.make((get) => {
      const source = get(environmentProjectIndexAtom(ref.environmentId)).get(ref.projectId) ?? null;
      const scratch =
        source !== null &&
        isScratchProject(
          source,
          input.serverConfigValueAtom
            ? get(input.serverConfigValueAtom(ref.environmentId))?.scratchWorkspaceRoot
            : null,
        );
      if (source === previousSource && scratch === previousIsScratch) {
        return previousValue;
      }
      previousSource = source;
      previousIsScratch = scratch;
      previousValue =
        source === null
          ? null
          : {
              ...scopeProject(ref.environmentId, source),
              ...(scratch ? { isScratch: true as const } : {}),
            };
      return previousValue;
    }).pipe(Atom.withLabel(`environment-project:${key}`));
  });

  let previousProjectRefs: ReadonlyArray<ScopedProjectRef> = [];
  const projectRefsAtom = Atom.make((get) => {
    const refs: ScopedProjectRef[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      refs.push(...get(environmentProjectRefsAtom(environmentId)));
    }
    if (projectRefsEqual(previousProjectRefs, refs)) {
      return previousProjectRefs;
    }
    previousProjectRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-project-refs"));

  let previousProjects: ReadonlyArray<EnvironmentProject> = [];
  const projectsAtom = Atom.make((get) => {
    const next = get(projectRefsAtom).flatMap((ref) => {
      const project = get(projectAtomFamily(projectKey(ref)));
      return project === null ? [] : [project];
    });
    if (arrayElementsEqual(previousProjects, next)) {
      return previousProjects;
    }
    previousProjects = next;
    return previousProjects;
  }).pipe(Atom.withLabel("environment-project-list"));

  const projectConfigsReadyAtom = Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalog.isReady) return false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      if (input.serverConfigValueAtom && get(input.serverConfigValueAtom(environmentId)) === null) {
        return false;
      }
    }
    return true;
  }).pipe(Atom.withLabel("environment-project-configs-ready"));

  return {
    environmentProjectsAtom,
    environmentProjectIndexAtom,
    environmentProjectRefsAtom,
    /** What the environment's projects say about the servers its change request links are on. */
    changeRequestHostsAtom: (environmentId: EnvironmentId | null) =>
      environmentId === null
        ? NO_ENVIRONMENT_HOSTS_ATOM
        : environmentChangeRequestHostsAtom(environmentId),
    projectRefsAtom,
    projectsAtom,
    projectConfigsReadyAtom,
    projectAtom: (ref: ScopedProjectRef) => projectAtomFamily(projectKey(ref)),
  };
}
