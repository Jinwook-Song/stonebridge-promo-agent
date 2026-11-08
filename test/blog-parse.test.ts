import { describe, expect, it } from "vitest";
import {
  buildSeedSql,
  classifyKind,
  parsePostHtml,
  parseRss,
  stripFooter,
} from "../scripts/blog/parse";
import fixture from "./fixtures/se-post.html?raw";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title><![CDATA[demo]]></title>
<item>
<title><![CDATA[[OO초등학교] 샌드위치 30인분 단체주문]]></title>
<link><![CDATA[https://blog.naver.com/demo/123?fromRss=true&trackingCode=rss]]></link>
<pubDate>Sun, 01 Nov 2026 10:00:00 +0900</pubDate>
</item>
<item>
<title><![CDATA[두번째 글]]></title>
<link><![CDATA[https://blog.naver.com/demo/124?fromRss=true&trackingCode=rss]]></link>
<pubDate>Sat, 31 Oct 2026 09:00:00 +0900</pubDate>
</item>
</channel></rss>`;

describe("parseRss", () => {
  it("reads CDATA title and link", () => {
    expect(parseRss(RSS_FIXTURE)[0]).toEqual({
      title: "[OO초등학교] 샌드위치 30인분 단체주문",
      url: "https://blog.naver.com/demo/123",
      logNo: "123",
      pubDate: "Sun, 01 Nov 2026 10:00:00 +0900",
    });
  });
  it("returns every item", () => {
    expect(parseRss(RSS_FIXTURE).map((i) => i.logNo)).toEqual(["123", "124"]);
  });
});

describe("parsePostHtml", () => {
  it("keeps line order and numbers photos", () => {
    expect(parsePostHtml(fixture)).toBe(
      "여는 줄입니다!\n\n[사진 1]\n주문 주셨어요 ˶ˆᗜˆ˵\n[사진 2]",
    );
  });
  it("unescapes entities and collapses blank runs", () => {
    const html =
      '<p class="se-text-paragraph"><span>A &amp; B &lt;c&gt; &#39;d&#39;</span></p>' +
      '<p class="se-text-paragraph"><span>​</span></p>' +
      '<p class="se-text-paragraph"><span>​</span></p>' +
      '<p class="se-text-paragraph"><span>​</span></p>' +
      '<p class="se-text-paragraph"><span>끝</span></p>';
    expect(parsePostHtml(html)).toBe("A & B <c> 'd'\n\n끝");
  });
});

describe("invisible characters", () => {
  it("strips zero-width, directional and BOM characters from paragraphs", () => {
    const junk = "\u200b\u200c\u200d\u200e\u200f\u2060\u202a\u202e\ufeff";
    const html =
      `<p class="se-text-paragraph"><span>가${junk}나</span></p>` +
      `<p class="se-text-paragraph"><span>${junk}</span></p>` +
      `<p class="se-text-paragraph"><span>다</span></p>`;
    expect(parsePostHtml(html)).toBe("가나\n\n다");
  });
});

describe("classifyKind", () => {
  it.each([
    ["[OO초등학교] 샌드위치 + 음료 단체주문", "case"],
    ["[OO 답례품] 쿠키 2개 + 마카롱 3구 50세트", "case"],
    ["[OO관리소] 쿠키 500개 | 단체 간식", "case"],
    ["[단체메뉴] 쿠키 6개 세트 9,000", "product"],
    ["OO카페 2026 연말 쿠키 선물세트", "product"],
  ])("classifyKind(%s) = %s", (title, kind) => {
    expect(classifyKind(title)).toBe(kind);
  });
});

describe("stripFooter", () => {
  it("cuts from the first line starting with the marker", () => {
    expect(stripFooter("본문\n\n[사진 1]\n안내 시작 here\n더 많은 안내", ["안내 시작"])).toBe(
      "본문\n\n[사진 1]",
    );
  });
  it("leaves the body alone when no marker matches", () => {
    expect(stripFooter("본문\n끝", ["안내 시작", "다른 안내"])).toBe("본문\n끝");
  });
  it("cuts at the earliest matching line whichever marker it is", () => {
    const body = "본문\n[사진 1]\n두번째 안내\n중간\n첫번째 안내\n끝";
    expect(stripFooter(body, ["첫번째 안내", "두번째 안내"])).toBe("본문\n[사진 1]");
    expect(stripFooter(body, ["두번째 안내", "첫번째 안내"])).toBe("본문\n[사진 1]");
  });
  it("matches trimmed line starts only, not mid-line text", () => {
    expect(stripFooter("본문\n  안내 시작\n끝", ["안내 시작"])).toBe("본문");
    expect(stripFooter("본문 안내 시작\n끝", ["안내 시작"])).toBe("본문 안내 시작\n끝");
  });
  it("ignores empty markers", () => {
    expect(stripFooter("본문\n끝", [""])).toBe("본문\n끝");
  });
});

describe("buildSeedSql", () => {
  it("doubles single quotes and writes snake_case columns with ISO dates", () => {
    const sql = buildSeedSql([
      {
        channel: "blog",
        kind: "case",
        title: "It's a title",
        body: "line1\nit's",
        source: "blog_import",
        enabled: true,
        sourceUrl: "https://blog.naver.com/demo/1",
        createdAt: "2026-11-01T01:00:00.000Z",
      },
    ]);
    expect(sql).toContain(
      "INSERT INTO examples (channel, kind, title, body, source, enabled, source_url, created_at) VALUES",
    );
    expect(sql).toContain("'It''s a title'");
    expect(sql).toContain("'line1\nit''s'");
    expect(sql).toContain("'2026-11-01T01:00:00.000Z'");
  });
});
