import { env } from "cloudflare:workers";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { examples as examplesTable } from "../database/schema";
import { addExample, type Example } from "../app/promo/examples.server";
import { getDb } from "../app/server/db";
import {
  buildSystem,
  buildUserContent,
  ChannelRewrite,
  DraftOutput,
  type ImageSource,
  pickExampleSet,
} from "../app/promo/prompt";
import { DEFAULT_CHANNEL_RULES } from "../app/promo/default-rules";
import type { PromoSettings } from "../app/promo/settings.server";

const S: PromoSettings = {
  footerBlog: "주소",
  footerShort: "짧은 꼬리말",
  priceTable: "4구 : 9,900",
  voiceRules: "VOICE-RULES-MARK",
  channelRules: "CHANNEL-RULES-MARK",
};

const ex = (id: number, channel: Example["channel"], kind: Example["kind"], title: string | null): Example => ({
  id,
  channel,
  kind,
  title,
  body: `본문 ${id}`,
  source: "blog_import",
});

const EX = {
  // Deliberately not in id / kind / title order: buildSystem must keep the given order.
  blog: [ex(9, "blog", "product", "시즌 상품"), ex(2, "blog", "case", "[장소] 단체 주문")],
  instagram: [ex(3, "instagram", "other", null)],
  daangn: [ex(4, "daangn", "product", "이웃 소식")],
  place: [],
};

const urlSrc = (url: string): ImageSource => ({ type: "url", url });
const base = { kind: "product", memo: "크리스마스 마카롱", privateCustomer: false, attachPrices: true } as const;

describe("buildUserContent", () => {
  it("zero photos → no image blocks and no-marker instruction", () => {
    const c = buildUserContent(base, []);
    expect(c.filter((b) => b.type === "image")).toHaveLength(0);
    expect(JSON.stringify(c)).toContain("[사진] 표시를 쓰지 마세요");
    expect(JSON.stringify(c)).toContain("크리스마스 마카롱");
  });

  it("two photos → labelled url images in order", () => {
    const c = buildUserContent(base, [urlSrc("https://x/a"), urlSrc("https://x/b")]);
    expect(c.map((b) => (b.type === "text" ? b.text.split("\n")[0] : b.type))).toEqual([
      "사진 1",
      "image",
      "사진 2",
      "image",
      expect.stringContaining("글 종류"),
    ]);
    expect(c[1]).toEqual({ type: "image", source: { type: "url", url: "https://x/a" } });
    expect(c[3]).toEqual({ type: "image", source: { type: "url", url: "https://x/b" } });
    expect(JSON.stringify(c.at(-1))).toContain("[사진 1]~[사진 2]");
  });

  it("passes base64 sources through untouched", () => {
    const src: ImageSource = { type: "base64", media_type: "image/jpeg", data: "AAAA" };
    const c = buildUserContent(base, [src]);
    expect(c[1]).toEqual({ type: "image", source: src });
  });

  it("one photo names just [사진 1]", () => {
    const last = JSON.stringify(buildUserContent(base, [urlSrc("https://x/a")]).at(-1));
    expect(last).toContain("블로그 본문에 [사진 1] 위치를 표시하세요.");
    expect(last).not.toContain("~");
  });

  it("tells the model a price table follows only when attachPrices is on", () => {
    const on = JSON.stringify(buildUserContent({ ...base, attachPrices: true }, []).at(-1));
    const off = JSON.stringify(buildUserContent({ ...base, attachPrices: false }, []).at(-1));
    expect(on).toContain("가격표가 따로 붙습니다");
    expect(on).toContain("가격은 아래를 참고해 주세요");
    expect(off).not.toContain("가격표");
  });

  it("says the price table goes under the 블로그·당근 bodies only", () => {
    const on = JSON.stringify(buildUserContent({ ...base, attachPrices: true }, []).at(-1));
    expect(on).toContain("블로그·당근 본문 아래에 가격표가 따로 붙습니다");
    expect(on).toContain("인스타·플레이스 본문에는 '아래'를 가리키는 말을 쓰지 마세요.");
  });

  it("states kind and private-customer flag in Korean", () => {
    const last = JSON.stringify(
      buildUserContent({ ...base, kind: "case", privateCustomer: true }, []).at(-1),
    );
    expect(last).toContain("단체 주문 사례");
    expect(last).toContain("개인 고객");
  });
});

describe("buildSystem", () => {
  it("system prompt is byte-identical for identical inputs and contains 절대 규칙", () => {
    expect(buildSystem(S, EX)).toBe(buildSystem(S, EX));
    expect(buildSystem(S, EX)).toContain("## 절대 규칙");
  });

  it("sections come in the fixed order, examples keep the given order", () => {
    const out = buildSystem(S, EX);
    const at = (s: string) => out.indexOf(s);
    const order = ["## 말투 규칙", "## 채널 규칙", "## 절대 규칙", "## 예시 글"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("VOICE-RULES-MARK");
    expect(out).toContain("CHANNEL-RULES-MARK");
    expect(at("### 블로그 예시 1 (상품·시즌 안내)")).toBeGreaterThan(0);
    expect(at("### 블로그 예시 2 (단체 주문 사례)")).toBeGreaterThan(at("### 블로그 예시 1"));
    expect(at("시즌 상품")).toBeLessThan(at("[장소] 단체 주문"));
    expect(at("본문 9")).toBeLessThan(at("본문 2"));
    expect(out).toContain("### 인스타 예시 1");
    expect(out).toContain("[장소] 단체 주문");
  });

  it("says examples are for voice only, when examples exist", () => {
    const note = "예시 글은 말투와 구성만 참고한다. 예시 속 숫자·가격·기관 이름·사실은 이번 글에 가져오지 않는다.";
    expect(buildSystem(S, EX)).toContain(note);
    expect(buildSystem(S, { blog: [], instagram: [], daangn: [], place: [] })).not.toContain("## 예시 글");
  });

  it("bans ad copy and long sentences, and avoids marketing framing", () => {
    const out = buildSystem(S, EX);
    expect(out).toContain('광고 문구("~해 보세요!", "놓치지 마세요"), 과한 칭찬, 긴 문장은 쓰지 않는다. 한 줄에 한 문장, 짧게.');
    expect(out).not.toContain("마케팅");
  });

  it("makes clear the ad-copy ban is about phrasing, not exclamation marks", () => {
    expect(buildSystem(S, EX)).toContain(
      "광고 문구를 피하라는 것은 표현 이야기다. 느낌표는 사장님 말투대로 써도 된다.",
    );
  });

  it("states the owner voice and the no-fixed-text rules", () => {
    const out = buildSystem(S, EX);
    expect(out).toContain("저희");
    expect(out).toContain("- 꼬리말(배송 정책, 주소, 영업시간, 연락처)과 가격표는 쓰지 않는다. 프로그램이 따로 붙인다.");
  });
});

describe("role and default rules", () => {
  it("the role paragraph uses the same plain ~한다 register as the rules", () => {
    const role = buildSystem(S, EX).split("\n\n")[0];
    expect(role.startsWith("당신은 실제로 운영 중인 카페의 사장님이 되어 소식 글을 쓴다.")).toBe(true);
    expect(role).not.toMatch(/니다[.!]/);
    for (const sentence of [
      "글은 모두 사장님이 직접 쓴 것처럼 1인칭(\"저희\")으로 쓴다.",
      "네 채널(블로그, 인스타그램, 당근, 플레이스)에 같은 내용을 쓰되 채널마다 말투와 분량을 맞춘다.",
      "아래 예시 글의 말투와 구성을 가깝게 따라 하고, 일반적인 글쓰기 투로 바꾸지 않는다.",
    ]) {
      expect(role).toContain(sentence);
    }
  });

  it("the 절대 규칙 block is unchanged", () => {
    expect(buildSystem(S, EX)).toContain(`## 절대 규칙
- 메모, 사진, 사장님이 준 정보에 없는 숫자·가격·날짜·기관 이름·사람 이름은 쓰지 않는다. 모르면 그 문장을 빼거나 "문의 주세요"로 쓴다.
- 꼬리말(배송 정책, 주소, 영업시간, 연락처)과 가격표는 쓰지 않는다. 프로그램이 따로 붙인다.
- 일반 이모지(😊🎉👍 등)는 쓰지 않는다. 얼굴 문자만 쓴다.
- 개인 고객 주문이면 이름·연락처·사는 곳을 쓰지 않는다.`);
  });

  it("the default blog title rule covers every post kind, 기타 included", () => {
    const titleLine = DEFAULT_CHANNEL_RULES.split("\n").find((l) => l.startsWith("- 제목:"))!;
    expect(titleLine).toContain("사례 = ");
    expect(titleLine).toContain("상품 = ");
    expect(titleLine).toContain("기타 = `가게 이름 + 주제`");
  });
});

describe("output schemas", () => {
  it("DraftOutput accepts the documented shape", () => {
    const ok = DraftOutput.safeParse({
      blog: { title: "t", body: "b" },
      instagram: { body: "b", hashtags: ["a"] },
      daangn: { title: "t", body: "b" },
      place: { body: "b" },
      photos: [{ n: 1, note: "n" }],
    });
    expect(ok.success).toBe(true);
  });

  it("ChannelRewrite allows null title and hashtags", () => {
    expect(ChannelRewrite.safeParse({ title: null, body: "b", hashtags: null }).success).toBe(true);
  });

  it("SDK output format carries no keywords structured outputs rejects", () => {
    for (const schema of [DraftOutput, ChannelRewrite]) {
      const json = JSON.stringify(zodOutputFormat(schema).schema);
      expect(json).not.toMatch(/"(minimum|maximum|minLength|maxLength|pattern|default)"/);
    }
  });
});

describe("pickExampleSet", () => {
  it("takes 3 blog and 2 of each other channel", async () => {
    const db = getDb(env.DB);
    await db.delete(examplesTable);
    const now = new Date(Date.UTC(2026, 10, 1));
    for (const channel of ["blog", "instagram", "daangn", "place"] as const) {
      for (let i = 0; i < 4; i++) {
        await addExample(db, { channel, kind: "product", title: null, body: `${channel}${i}`, source: "blog_import" }, now);
      }
    }
    const set = await pickExampleSet(db, "product");
    expect(Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v.length]))).toEqual({
      blog: 3,
      instagram: 2,
      daangn: 2,
      place: 2,
    });
    expect(set.blog.every((e) => e.channel === "blog")).toBe(true);
    await db.delete(examplesTable);
  });
});
