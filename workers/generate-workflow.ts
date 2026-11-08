import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  failIfStillGenerating,
  makeGenDeps,
  runGeneration,
  runRewrite,
  type GenerateParams,
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
    const db = getDb(this.env.DB);
    try {
      await step.do(
        "generate",
        { retries: { limit: RETRY_LIMIT, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async (ctx) => {
          // ctx.attempt is 1-based: attempts 1..RETRY_LIMIT+1.
          const opts = { final: ctx.attempt > RETRY_LIMIT };
          const deps = makeGenDeps(this.env, db);
          if (channel) await runRewrite(deps, postId, channel, instruction ?? "", opts);
          else await runGeneration(deps, postId, opts);
          // Nothing big crosses the step boundary; drafts are already in D1.
          return null;
        },
      );
    } catch (e) {
      // Retries used up, or a step timed out before the runner could record anything.
      await failIfStillGenerating(db, postId, channel !== undefined);
      throw e;
    }
  }
}
