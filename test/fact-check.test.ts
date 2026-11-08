import { describe, expect, it } from "vitest";
import { findPossibleNames, findUnsupportedNumbers } from "../app/promo/fact-check";

describe("findUnsupportedNumbers", () => {
  it("comma and unit spelling differences are supported", () => {
    expect(findUnsupportedNumbers("6구 15,000원 40 세트", ["6구 15000", "40세트"])).toEqual([]);
  });

  it("invented numbers are flagged, photo markers ignored", () => {
    expect(findUnsupportedNumbers("[사진 3] 100세트 주문! 5~7일 전", ["40세트"])).toEqual([
      "100세트",
      "5",
      "7일",
    ]);
  });

  it("matches whole digit runs, not substrings", () => {
    expect(findUnsupportedNumbers("0개 4개 1500원", ["40세트", "15000원"])).toEqual(["0개", "4개", "1500원"]);
  });

  it("dedupes repeated tokens and keeps first-seen order", () => {
    expect(findUnsupportedNumbers("9월 3개, 9월 2개", [])).toEqual(["9월", "3개", "2개"]);
  });

  it("does not let the unit lookahead span a line break", () => {
    expect(findUnsupportedNumbers("40\n일주일", [])).toEqual(["40"]);
  });

  it("supports decimals and ignores a trailing sentence comma", () => {
    expect(findUnsupportedNumbers("1.5배 그리고 12, 13", ["1.5"])).toEqual(["12", "13"]);
  });

  it("reads a comma between small numbers as a list, not a thousands separator", () => {
    expect(findUnsupportedNumbers("3,4개 15,000원 1,234,567", ["3개", "15000"])).toEqual(["4개", "1,234,567"]);
    expect(findUnsupportedNumbers("3,4개", ["34"])).toEqual(["3", "4개"]);
  });

  it("flags native Korean numbers before a counter", () => {
    expect(findUnsupportedNumbers("마카롱 세 세트, 열두 개, 스무 명, 다섯가지", [])).toEqual([
      "세 세트",
      "열두 개",
      "스무 명",
      "다섯가지",
    ]);
  });

  it("native numbers are backed by digits or the same native number in the sources", () => {
    expect(findUnsupportedNumbers("세 세트 열두 개 두 상자", ["3세트", "12개", "두 상자"])).toEqual([]);
    expect(findUnsupportedNumbers("3세트", ["세 세트"])).toEqual([]);
  });

  it("ignores 한 (one), numerals inside words, and numerals without a counter", () => {
    expect(findUnsupportedNumbers("마카롱 한 상자 한 분 한 분 네 감사합니다 두근두근 세트 가게", [])).toEqual([]);
    expect(findUnsupportedNumbers("열한 개", [])).toEqual(["열한 개"]);
  });
});

describe("findPossibleNames", () => {
  it("names flagged except role words", () => {
    expect(findPossibleNames("김민수님 감사합니다 사장님 손님")).toEqual(["김민수님"]);
  });

  it("flags 씨 and dedupes", () => {
    expect(findPossibleNames("박서준 씨 고마워요 박서준 씨 담당자님")).toEqual(["박서준 씨"]);
  });

  it.each(["단골손님", "손글씨", "화창한날씨", "대표님", "점장님", "고객님", "솜씨 좋은 마음씨"])(
    "does not flag %s",
    (text) => {
      expect(findPossibleNames(`${text} 감사합니다`)).toEqual([]);
    },
  );

  it("still flags real names", () => {
    expect(findPossibleNames("김민수님 그리고 이영희 씨")).toEqual(["김민수님", "이영희 씨"]);
  });

  it("returns nothing when there are no names", () => {
    expect(findPossibleNames("고객님 감사합니다")).toEqual([]);
  });
});
