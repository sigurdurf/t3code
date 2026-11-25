import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type ServerConfig,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { createEnvironmentProjectAtoms } from "./projectEntities.ts";
import { v2Project, v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");

function makeHarness(withConfig = true) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make({
      ...v2ShellSnapshot,
      projects: [
        { ...v2Project, title: "No project" },
        {
          ...v2Project,
          title: "No project",
          id: ProjectId.make("ordinary"),
          workspaceRoot: "/repo",
        },
      ],
    }),
  );
  const configAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<(Pick<ServerConfig, "scratchWorkspaceRoot"> & { revision?: number }) | null>(null),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      [environmentId, remoteEnvironmentId].map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: id,
            httpBaseUrl: `https://${id}.example.test`,
            wsBaseUrl: `wss://${id}.example.test`,
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  const projects = createEnvironmentProjectAtoms({
    catalogValueAtom,
    snapshotAtom,
    ...(withConfig ? { serverConfigValueAtom: configAtom } : {}),
  });
  return { registry: AtomRegistry.make(), projects, configAtom, snapshotAtom, catalogValueAtom };
}

describe("project scratch identity", () => {
  it("waits for enabled project configs and ignores a disabled environment with no config", () => {
    const { registry, projects, configAtom, catalogValueAtom } = makeHarness();
    try {
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
      registry.set(configAtom(environmentId), { scratchWorkspaceRoot: v2Project.workspaceRoot });
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
      const catalog = registry.get(catalogValueAtom);
      registry.set(catalogValueAtom, {
        ...catalog,
        entries: new Map(
          [...catalog.entries].map(([id, entry]) => [
            id,
            { ...entry, enabled: id === environmentId },
          ]),
        ),
      });
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(true);
      registry.set(catalogValueAtom, catalog);
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
      registry.set(configAtom(remoteEnvironmentId), {});
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(true);
      registry.set(catalogValueAtom, { ...catalog, isReady: false });
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it("updates a loaded project when config arrives, preserving unrelated projects and snapshots", () => {
    const { registry, projects, configAtom, snapshotAtom } = makeHarness();
    try {
      const initial = registry.get(projects.projectsAtom);
      const source = registry.get(snapshotAtom(environmentId));
      registry.set(configAtom(environmentId), {
        scratchWorkspaceRoot: `${v2Project.workspaceRoot}/`,
      });
      const next = registry.get(projects.projectsAtom);

      expect(next[0]?.isScratch).toBe(true);
      expect(next[0]).not.toBe(initial[0]);
      expect(next.slice(1)).toEqual(initial.slice(1));
      for (let index = 1; index < initial.length; index++) {
        expect(next[index]).toBe(initial[index]);
      }
      expect(registry.get(snapshotAtom(environmentId))).toBe(source);
      expect(v2Project).not.toHaveProperty("isScratch");

      registry.set(configAtom(environmentId), {
        scratchWorkspaceRoot: v2Project.workspaceRoot,
        revision: 1,
      });
      expect(registry.get(projects.projectsAtom)).toBe(next);

      registry.set(configAtom(environmentId), { scratchWorkspaceRoot: "/repo" });
      const changedRoot = registry.get(projects.projectsAtom);
      expect(changedRoot[0]).not.toHaveProperty("isScratch");
      expect(changedRoot[1]?.isScratch).toBe(true);
      expect(changedRoot[2]).toBe(initial[2]);

      registry.set(configAtom(environmentId), null);
      expect(registry.get(projects.projectsAtom).every((project) => !project.isScratch)).toBe(true);
    } finally {
      registry.dispose();
    }
  });
});

describe("environment change request hosts", () => {
  it("keeps one host map while the projects' servers stay the same", () => {
    const { registry, projects, snapshotAtom } = makeHarness();
    const onServer = (title: string, provider: string) => ({
      ...v2Project,
      title,
      repositoryIdentity: {
        canonicalKey: "git.example.com/team/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@git.example.com:team/repo.git",
        },
        provider: SourceControlProviderKind.make(provider),
      },
    });
    const setProjects = (next: Array<ReturnType<typeof onServer>>) =>
      registry.set(snapshotAtom(environmentId), {
        ...registry.get(snapshotAtom(environmentId)),
        projects: next,
      });
    try {
      setProjects([onServer("Repo", "gice")]);
      const hosts = registry.get(projects.changeRequestHostsAtom(environmentId));
      expect([...hosts]).toEqual([["git.example.com", "gice"]]);
      setProjects([onServer("Renamed", "gice")]);
      expect(registry.get(projects.changeRequestHostsAtom(environmentId))).toBe(hosts);
      setProjects([onServer("Renamed", "gice"), onServer("Other", "forgejo")]);
      expect([...registry.get(projects.changeRequestHostsAtom(environmentId))]).toEqual([
        ["git.example.com", null],
      ]);
      expect(registry.get(projects.changeRequestHostsAtom(null)).size).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it("includes tracked repository identities of multi-repository projects", () => {
    const { registry, projects, snapshotAtom } = makeHarness();
    try {
      registry.set(snapshotAtom(environmentId), {
        ...registry.get(snapshotAtom(environmentId)),
        projects: [
          {
            ...v2Project,
            title: "Workspace",
            repositoryIdentity: null,
            trackedFolders: [{ path: "/workspace/api", name: "api", discovered: true }],
            trackedRepositoryIdentities: [
              {
                canonicalKey: "code.example.com/team/api",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "git@code.example.com:team/api.git",
                },
                provider: SourceControlProviderKind.make("gice"),
              },
            ],
          },
        ],
      });
      expect([...registry.get(projects.changeRequestHostsAtom(environmentId))]).toEqual([
        ["code.example.com", "gice"],
      ]);
    } finally {
      registry.dispose();
    }
  });
});
