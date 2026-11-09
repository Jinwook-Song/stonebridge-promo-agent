import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { permanentApiFailure } from "../app/promo/claude.server";
import {
  isFinalAttempt,
  STEP_RETRY_DELAY_SECONDS,
  STEP_RETRY_LIMIT,
  STEP_TIMEOUT_MINUTES,
} from "../app/promo/generate.server";
import {
  failQuoteIfStillGenerating,
  makeQuoteGenDeps,
  runQuoteGeneration,
  type QuoteGenParams,
  type QuoteRunRef,
} from "../app/quote/generate.server";
import { getDb } from "../app/server/db";

/** Makes one quote version apart from the HTTP request, so it finishes after the page is left. */
export class QuoteGenerateWorkflow extends WorkflowEntrypoint<Env, QuoteGenParams> {
  async run(event: Readonly<WorkflowEvent<QuoteGenParams>>, step: WorkflowStep): Promise<void> {
    const { quoteId, version } = event.payload;
    // startQuoteGeneration creates the instance with the id it stored as quote_versions.workflow_id.
    const run: QuoteRunRef = { quoteId, version, workflowId: event.instanceId };
    const db = getDb(this.env.DB);
    try {
      await step.do(
        "generate",
        {
          // Same timing as drafts, so STALE_CLAIM_MS (derived from it) covers this run too.
          retries: { limit: STEP_RETRY_LIMIT, delay: `${STEP_RETRY_DELAY_SECONDS} seconds`, backoff: "exponential" },
          timeout: `${STEP_TIMEOUT_MINUTES} minutes`,
        },
        // Nothing big crosses the step boundary: the version is already in D1.
        async (ctx) => {
          try {
            await runQuoteGeneration(makeQuoteGenDeps(this.env, db), run, {
              final: isFinalAttempt(ctx.attempt, STEP_RETRY_LIMIT),
            });
          } catch (e) {
            // A bad key or a rejected request fails the same way every time: stop now. The
            // runner has already recorded the reason on the version.
            const permanent = permanentApiFailure(e);
            if (permanent) throw new NonRetryableError(permanent.message);
            throw e;
          }
        },
      );
    } catch (e) {
      // Retries used up, or a step timed out before the runner could record anything.
      await failQuoteIfStillGenerating(db, run);
      throw e;
    }
  }
}
