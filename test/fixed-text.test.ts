import { describe, expect, it } from "vitest";
import { withFixedText } from "../app/promo/fixed-text";
import type { PromoSettings } from "../app/promo/settings.server";

const S: PromoSettings = {
  footerBlog: "주소\n영업시간",
  footerShort: "짧은 꼬리말",
  priceTable: "4구 : 9,900",
  voiceRules: "v",
  channelRules: "c",
};

describe("withFixedText", () => {
  it("blog with prices and footer", () => {
    expect(
      withFixedText("blog", { body: "본문\n" }, { ...S, priceTable: "4구 : 9,900", footerBlog: "주소" }, true),
    ).toBe("본문\n\n4구 : 9,900\n\n주소");
  });

  it("blog without prices skips the table", () => {
    expect(withFixedText("blog", { body: "본문" }, { ...S, footerBlog: "주소" }, false)).toBe("본문\n\n주소");
  });

  it("empty settings leave no blank tail or undefined", () => {
    const out = withFixedText("daangn", { body: "본문" }, { ...S, priceTable: "", footerShort: "" }, true);
    expect(out).toBe("본문");
  });

  it("daangn is body, prices, short footer", () => {
    expect(withFixedText("daangn", { body: "본문" }, S, true)).toBe("본문\n\n4구 : 9,900\n\n짧은 꼬리말");
  });

  it("instagram hashtags normalized", () => {
    expect(
      withFixedText(
        "instagram",
        { body: "b", hashtags: ["#구리카페", "구리카페", "마카롱"] },
        { ...S, footerShort: "" },
        false,
      ),
    ).toBe("b\n\n#구리카페 #마카롱");
  });

  it("instagram puts the short footer before the hashtags and never the price table", () => {
    expect(withFixedText("instagram", { body: "b", hashtags: ["a"] }, S, true)).toBe("b\n\n짧은 꼬리말\n\n#a");
  });

  it("instagram drops empty hashtags and tolerates null", () => {
    expect(
      withFixedText("instagram", { body: "b", hashtags: [" # ", "", "##x ", " y"] }, { ...S, footerShort: "" }, false),
    ).toBe("b\n\n#x #y");
    expect(withFixedText("instagram", { body: "b", hashtags: null }, { ...S, footerShort: "" }, false)).toBe("b");
  });

  it("place never gets footer or prices", () => {
    expect(withFixedText("place", { body: "본문", hashtags: ["a"] }, S, true)).toBe("본문");
  });
});
