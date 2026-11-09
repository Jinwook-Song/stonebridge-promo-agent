import { describe, expect, it } from "vitest";
import { litTab, tabMatches, type TabLink } from "../app/lib/nav-tabs";

const LINKS: TabLink[] = [
  { to: "/", end: true },
  { to: "/quotes", end: false },
  { to: "/competitors", end: false },
  { to: "/settings", end: false },
];

describe("tabMatches", () => {
  it("matches the index tab only on / and other tabs on their sub-paths", () => {
    expect(tabMatches(LINKS[0], "/")).toBe(true);
    expect(tabMatches(LINKS[0], "/posts/4")).toBe(false);
    expect(tabMatches(LINKS[1], "/quotes")).toBe(true);
    expect(tabMatches(LINKS[1], "/quotes/12")).toBe(true);
    expect(tabMatches(LINKS[1], "/quotesx")).toBe(false);
    expect(tabMatches(LINKS[3], "/settings/quote")).toBe(true);
  });
});

describe("litTab", () => {
  it("lights the page on screen when nothing is loading", () => {
    expect(litTab(LINKS, "/quotes/3", null)).toBe("/quotes");
    expect(litTab(LINKS, "/posts/4", null)).toBeNull();
  });

  it("lights the tapped tab while its page loads", () => {
    expect(litTab(LINKS, "/", "/settings")).toBe("/settings");
    expect(litTab(LINKS, "/posts/4", "/")).toBe("/");
  });

  it("keeps the current tab when the page being loaded has no tab", () => {
    expect(litTab(LINKS, "/", "/posts/4")).toBe("/");
    expect(litTab(LINKS, "/quotes", "/logout")).toBe("/quotes");
  });
});
