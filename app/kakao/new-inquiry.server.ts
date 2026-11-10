import type { NewInquiryInfo } from "../inquiry/inquiries.server";
import { alertMessage, getAlertSettings, type ScheduledDeps } from "./alerts.server";
import { getLink, sendToMe } from "./link.server";

export type NewInquiryOutcome = "not_configured" | "disabled" | "not_linked" | "sent" | "failed";

/**
 * Tells her on Kakao that a site inquiry came in: org, date and headcount, never the customer's
 * name, phone or email. Off until she switches it on in settings. Not deduplicated: the caller
 * (submitInquiry) runs it once per stored inquiry. A failed send is logged, not retried. Never
 * throws: the inquiry is already saved, this is a bonus.
 */
export async function notifyNewInquiry(deps: ScheduledDeps, info: NewInquiryInfo, now: Date): Promise<NewInquiryOutcome> {
  try {
    const { db, cfg } = deps;
    if (!cfg) return "not_configured";
    if (!(await getAlertSettings(db)).inquiryEnabled) return "disabled";
    if (!(await getLink(db))) return "not_linked";
    // Rebuilt from the event fields so extra properties on `info` can never reach the message.
    const { quoteId, org, eventDate, headcount } = info;
    try {
      await sendToMe(
        db,
        cfg,
        alertMessage("new_inquiry", deps.origin, { quoteId, org, eventDate, headcount }),
        now,
        deps.fetch,
      );
    } catch (e) {
      console.error("kakao new-inquiry alert failed", { quoteId, error: e });
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error("kakao new-inquiry alert errored", { error: e });
    return "failed";
  }
}
