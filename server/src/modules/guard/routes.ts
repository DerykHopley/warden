// Guard's own routes, mounted by the app through `moduleRoutes` (ADR 0005: the app imports no module). The Team is
// always the session's, never the request's.
import type { ReposBody } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import type { RepoAssets } from "./repo-assets.ts";

export function guardRoutes({ repoAssets }: { repoAssets: RepoAssets }): MountRoutes {
  return (app, requireRole) => {
    // Any person in the Team reads its Repo Assets, by ref (story 1).
    app.get("/api/repos", requireRole("member"), async (c) => {
      const repos = await repoAssets.list(c.get("team"));
      return c.json({
        repos: repos.map((repo) => ({
          asset: { kind: "repo", ref: repo.ref },
          installation_id: repo.installationId,
          listed_at: repo.listedAt.toISOString(),
        })),
      } satisfies ReposBody);
    });
  };
}
