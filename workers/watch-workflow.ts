import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getDb } from "../app/server/db";
import { makeWatchDeps, runWatchSource, WATCH_RUN_BUDGET } from "../app/watch/run.server";
import { listWatchSources } from "../app/watch/sources.server";

/** The daily competitor watch (cron WATCH_CRON): each enabled source in its own step. */
export class WatchWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep): Promise<void> {
    const db = getDb(this.env.DB);
    const ids = await step.do("sources", async () =>
      (await listWatchSources(db)).filter((s) => s.enabled).map((s) => s.id),
    );

    let remaining = WATCH_RUN_BUDGET;
    for (const id of ids) {
      try {
        // runWatchSource records a broken source and returns; the retry covers a timed-out step.
        const result = await step.do(
          `source-${id}`,
          { retries: { limit: 1, delay: "30 seconds" }, timeout: "5 minutes" },
          () => {
            const deps = makeWatchDeps(this.env, db);
            return runWatchSource(deps, id, remaining, deps.now());
          },
        );
        remaining = Math.max(0, remaining - result.claudeCalls);
        console.log(`watch source ${id}: ${result.status}, ${result.claudeCalls} calls, ${result.added} added`);
      } catch (e) {
        // One source failing for good must not stop the others.
        console.error("watch source step failed", { sourceId: id, error: e });
      }
    }
  }
}
