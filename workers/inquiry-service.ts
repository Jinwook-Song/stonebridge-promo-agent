import { WorkerEntrypoint } from "cloudflare:workers";
import { submitInquiry, type SubmitResult } from "../app/inquiry/inquiries.server";
import { kakaoConfig } from "../app/kakao/link.server";
import { notifyNewInquiry } from "../app/kakao/new-inquiry.server";
import { startQuoteGeneration } from "../app/quote/generate.server";
import { getDb } from "../app/server/db";

/**
 * RPC entrypoint for the 스톤테이블 사이트 (its Pages Function reaches it through the PROMO
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
        // Off unless the owner switched "사이트 새 문의" on in settings; never throws.
        notify: (info) =>
          notifyNewInquiry(
            { db, cfg: kakaoConfig(this.env), origin: this.env.PUBLIC_ORIGIN, fetch: (u, i) => fetch(u, i) },
            info,
            new Date(),
          ),
        // The Kakao send runs after the site has its answer.
        defer: (work) => this.ctx.waitUntil(work),
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
