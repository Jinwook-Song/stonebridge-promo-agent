import { describe, expect, it } from "vitest";
import { datesIn, sendChecks, type SendCheckInput } from "../app/quote/send-check";
import type { QuoteEvent, QuoteLine } from "../app/quote/types";

const event: QuoteEvent = {
  customerName: "예시 학원",
  contactName: "",
  contact: "",
  email: "",
  eventDate: "2026-12-01",
  headcount: 40,
  venue: "예시 강당",
  eventType: "세미나",
  budget: "",
  requests: "",
  missing: [],
};

const line = (over: Partial<QuoteLine>): QuoteLine => ({
  itemId: 1,
  label: "다과",
  content: "",
  qty: 40,
  unitPrice: 9000,
  priceSource: "sheet",
  svc: false,
  menu: "",
  note: "",
  ...over,
});

const ok: SendCheckInput = {
  event,
  lines: [line({})],
  emailSubject: "견적서 보내 드립니다",
  emailBody: "안녕하세요.\n12월 1일 40명 행사 견적서를 첨부해 드립니다.\n감사합니다!",
};

describe("sendChecks", () => {
  it("nothing to say when the quote and the mail agree", () => {
    expect(sendChecks(ok)).toEqual([]);
  });

  it("flags a mail headcount that no longer matches the event", () => {
    const checks = sendChecks({ ...ok, event: { ...event, headcount: 60 } });
    expect(checks).toEqual([
      { kind: "warn", text: "회신 메일에는 40명, 행사 정보에는 60명이에요. 보내실 때 메일을 고쳐 주세요." },
    ]);
  });

  it("does not flag other counts when the right headcount is also in the mail", () => {
    const body = "안녕하세요.\n40명 행사에 직원 2명이 함께 갑니다.\n감사합니다!";
    expect(sendChecks({ ...ok, emailBody: body })).toEqual([]);
  });

  it("flags a mail date that no longer matches the event, across date formats", () => {
    const checks = sendChecks({ ...ok, event: { ...event, eventDate: "12월 2일 (화)" } });
    expect(checks.map((c) => c.text)).toEqual([
      "회신 메일의 날짜(12월 1일)가 행사 날짜(12월 2일)와 달라요. 보내실 때 메일을 고쳐 주세요.",
    ]);
  });

  it("flags an amount in the mail", () => {
    for (const body of ["총 360,000원입니다.", "1인 9000원", "약 36만 원"]) {
      expect(sendChecks({ ...ok, emailBody: body }).map((c) => c.text)).toContain(
        "회신 메일에 금액이 적혀 있어요. 금액은 견적서로만 안내해요.",
      );
    }
  });

  it("flags the cafe's name in the mail or in a line", () => {
    const inMail = sendChecks({ ...ok, emailBody: ok.emailBody + "\n스톤 브릿지 드림" });
    expect(inMail[0]).toEqual({
      kind: "warn",
      text: "'스톤브릿지' 이름이 들어 있어요 (회신 메일). 손님께 가는 글에서는 빼 주세요.",
    });
    const inLine = sendChecks({ ...ok, lines: [line({ label: "마카롱", note: "Stone Bridge 수제" })] });
    expect(inLine[0].text).toBe("'스톤브릿지' 이름이 들어 있어요 (견적 줄 마카롱). 손님께 가는 글에서는 빼 주세요.");
  });

  it("lists open work as to-dos after the warnings", () => {
    const checks = sendChecks({
      ...ok,
      emailBody: "총 1,000원",
      event: { ...event, customerName: "", venue: " ", headcount: null, missing: ["장소가 어디인가요?", "시작 시간은요?"] },
      lines: [
        line({ label: "케이터링 서비스", unitPrice: null, priceSource: "hand" }),
        line({ label: "음료", unitPrice: null, priceSource: "hand", qty: 0 }),
        line({ label: "환경부담금", unitPrice: null, svc: true, qty: 0 }),
      ],
    });
    expect(checks).toEqual([
      { kind: "warn", text: "회신 메일에 금액이 적혀 있어요. 금액은 견적서로만 안내해요." },
      { kind: "todo", text: "손님께 확인할 것이 2개 남아 있어요." },
      { kind: "todo", text: "행사 정보에 비어 있는 칸: 고객·단체, 장소, 인원" },
      { kind: "todo", text: "단가를 적을 줄 2개: 케이터링 서비스, 음료" },
      { kind: "todo", text: "수량이 0인 줄: 음료" },
    ]);
  });

  it("shortens long line lists", () => {
    const lines = ["가", "나", "다", "라", "마"].map((label) => line({ label, unitPrice: null }));
    expect(sendChecks({ ...ok, lines }).map((c) => c.text)).toContain("단가를 적을 줄 5개: 가, 나, 다 외 2개");
  });

  it("an empty mail skips the mail checks", () => {
    expect(sendChecks({ ...ok, event: { ...event, headcount: 99 }, emailBody: "", emailSubject: "" })).toEqual([]);
  });
});

describe("datesIn", () => {
  it("reads Korean, dashed, dotted and slashed dates as month and day", () => {
    expect(datesIn("12월 1일, 2026-12-02, 2026.12.3, 12/4")).toEqual(["12월 1일", "12월 2일", "12월 3일", "12월 4일"]);
  });

  it("ignores impossible dates and plain numbers", () => {
    expect(datesIn("13월 40일 그리고 40명")).toEqual([]);
  });
});
