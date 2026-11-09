import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getDb } from "../app/server/db";
import { makeWatchDeps, runWatch } from "../app/watch/run.server";
import { listWatchSources } from "../app/watch/sources.server";

/** The daily competitor watch (cron WATCH_CRON): each enabled source in its own step. */
export class WatchWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep): Promise<void> {
    const deps = makeWatchDeps(this.env, getDb(this.env.DB));
    const ids = await step.do("sources", async () =>
      (await listWatchSources(deps.db)).filter((s) => s.enabled).map((s) => s.id),
    );
    // The instance's start time, the same on every replay.
    await runWatch(step, deps, ids, event.timestamp);
  }
}
