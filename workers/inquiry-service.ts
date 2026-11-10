import { WorkerEntrypoint } from "cloudflare:workers";
import { submitInquiry, type SubmitResult } from "../app/inquiry/inquiries.server";
import { startQuoteGeneration } from "../app/quote/generate.server";
import { getDb } from "../app/server/db";

/**
 * RPC entrypoint for the stonetable.kr site (its Pages Function reaches it through the PROMO
 * service binding, entrypoint InquiryService). Not reachable over HTTP: fetch answers 404.
 * `raw` is validated again inside submitInquiry; nothing from the caller is trusted.
 */
export class InquiryService extends WorkerEntrypoint<Env> {
  async submit(raw: unknown, meta: { ipHash: string }): Promise<SubmitResult> {
    const db = getDb(this.env.DB);
    return submitInquiry(
      {
        db,
        startGeneration: (quoteId) => startQuoteGeneration(this.env, db, quoteId, 1),
        // The "new inquiry" Kakao alert replaces this later; until then nothing is sent.
        notify: async () => "disabled",
      },
      raw,
      meta,
      new Date(),
    );
  }

  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
}
