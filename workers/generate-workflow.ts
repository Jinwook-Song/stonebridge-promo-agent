import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { permanentApiFailure } from "../app/promo/claude.server";
import {
  failIfStillGenerating,
  isFinalAttempt,
  makeGenDeps,
  runGeneration,
  runRewrite,
  type GenerateParams,
  type RunRef,
} from "../app/promo/generate.server";
import { getDb } from "../app/server/db";

const RETRY_LIMIT = 2;

/**
 * Runs one generation (all four channels, or one channel's rewrite) apart from the HTTP request,
 * so it finishes even when the owner's phone locks and the page request is cancelled.
 */
export class GeneratePostWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  async run(event: Readonly<WorkflowEvent<GenerateParams>>, step: WorkflowStep): Promise<void> {
    const { postId, channel, instruction } = event.payload;
    // startGeneration creates the instance with the id it stored as posts.workflow_id.
    const run: RunRef = { postId, workflowId: event.instanceId };
    const db = getDb(this.env.DB);
    try {
      await step.do(
        "generate",
        { retries: { limit: RETRY_LIMIT, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async (ctx) => {
          const opts = { final: isFinalAttempt(ctx.attempt, RETRY_LIMIT) };
          const deps = makeGenDeps(this.env, db);
          try {
            if (channel) await runRewrite(deps, run, channel, instruction ?? "", opts);
            else await runGeneration(deps, run, opts);
          } catch (e) {
            // A bad key or a rejected request fails the same way every time: stop now. The
            // runner has already recorded the reason on the post.
            const permanent = permanentApiFailure(e);
            if (permanent) throw new NonRetryableError(permanent.message);
            throw e;
          }
          // Nothing big crosses the step boundary; drafts are already in D1.
          return null;
        },
      );
    } catch (e) {
      // Retries used up, or a step timed out before the runner could record anything.
      await failIfStillGenerating(db, run, channel !== undefined);
      throw e;
    }
  }
}
