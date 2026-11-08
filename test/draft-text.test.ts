import { describe, expect, it } from "vitest";
import { composeCopy, formatHashtags, parseHashtags, warningsFor } from "../app/promo/draft-text";
import type { PromoSettings } from "../app/promo/settings.server";

const S: PromoSettings = {
  footerBlog: "주소 테스트로 1",
  footerShort: "짧은 꼬리말",
  priceTable: "6구 : 15,000",
  voiceRules: "v",
  channelRules: "c",
};

describe("parseHashtags / formatHashtags", () => {
  it("splits on whitespace, drops #, empties and duplicates", () => {
    expect(parseHashtags(" #마카롱  단체주문 ## #마카롱\n선물 ")).toEqual(["마카롱", "단체주문", "선물"]);
    expect(formatHashtags(["마카롱", "선물"])).toBe("#마카롱 #선물");
    expect(parseHashtags(formatHashtags(["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("composeCopy", () => {
  it("blog: title line, blank line, body + prices + footer; tail is the appended part", () => {
    const { full, tail } = composeCopy("blog", { title: "제목", body: "본문\n", hashtags: [] }, S, true);
    expect(full).toBe("제목\n\n본문\n\n6구 : 15,000\n\n주소 테스트로 1");
    expect(tail).toBe("6구 : 15,000\n\n주소 테스트로 1");
  });

  it("daangn prefixes its title; instagram ends with hashtags; place is body only", () => {
    expect(composeCopy("daangn", { title: "당근 제목", body: "본문", hashtags: [] }, S, false).full).toBe(
      "당근 제목\n\n본문\n\n짧은 꼬리말",
    );
    const insta = composeCopy("instagram", { title: "무시", body: "본문", hashtags: ["마카롱"] }, S, true);
    expect(insta.full).toBe("본문\n\n짧은 꼬리말\n\n#마카롱");
    expect(insta.tail).toBe("짧은 꼬리말\n\n#마카롱");
    expect(composeCopy("place", { title: "무시", body: "본문", hashtags: [] }, S, true)).toEqual({
      full: "본문",
      tail: "",
    });
  });

  it("an empty title adds no blank first line", () => {
    expect(composeCopy("blog", { title: "  ", body: "본문", hashtags: [] }, { ...S, footerBlog: "" }, false).full).toBe(
      "본문",
    );
  });
});

describe("warningsFor", () => {
  const post = { memo: "마카롱 40세트", privateCustomer: false };

  it("flags numbers in title and body that no source backs", () => {
    const w = warningsFor({ title: "40세트 30세트", body: "15,000원, 7월 3일", hashtags: [] }, post, S);
    expect(w.numbers).toEqual(["30세트", "7월", "3일"]);
    expect(w.names).toEqual([]);
  });

  it("checks names only for a private customer", () => {
    const d = { title: null, body: "김민수님 감사합니다", hashtags: [] };
    expect(warningsFor(d, post, S).names).toEqual([]);
    expect(warningsFor(d, { ...post, privateCustomer: true }, S).names).toEqual(["김민수님"]);
  });
});
