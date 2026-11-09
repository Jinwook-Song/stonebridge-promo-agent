import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getDb } from "../app/server/db";
import { makeWatchDeps, runWatch } from "../app/watch/run.server";
import { listWatchSources } from "../app/watch/sources.server";

/** The daily competitor watch (cron WATCH_CRON): each enabled source in its own step. */
export class WatchWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep): Promise<void> {
    const deps = makeWatchDeps(this.env, getDb(this.env.DB));
    // Named apart from the old "sources" step (ids only), so an instance started before this
    // shape existed does not replay a cached list of plain ids.
    const sources = await step.do("source-list", async () =>
      (await listWatchSources(deps.db)).filter((s) => s.enabled).map((s) => ({ id: s.id, kind: s.kind })),
    );
    // The instance's start time, the same on every replay.
    await runWatch(step, deps, sources, event.timestamp);
  }
}
