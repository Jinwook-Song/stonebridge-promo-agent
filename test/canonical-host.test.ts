import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "../app/server/canonical-host";

const FRONT = "https://stonebridge-promo.pages.dev";
const OLD = "https://stonebridge-promo.wlsdnr129.workers.dev";

describe("canonicalRedirect", () => {
  it("sends the workers.dev host to the front, keeping path and query", () => {
    expect(canonicalRedirect(`${OLD}/posts/3?tab=blog`, FRONT)).toBe(`${FRONT}/posts/3?tab=blog`);
    expect(canonicalRedirect(`${OLD}/`, `${FRONT}/`)).toBe(`${FRONT}/`);
  });

  it("leaves the front host, local dev and a workers.dev PUBLIC_ORIGIN alone", () => {
    expect(canonicalRedirect(`${FRONT}/posts`, FRONT)).toBeNull();
    expect(canonicalRedirect("http://localhost:5173/", "http://localhost:5173")).toBeNull();
    expect(canonicalRedirect(`${OLD}/posts`, OLD)).toBeNull();
    expect(canonicalRedirect(`${OLD}/posts`, "http://insecure.example")).toBeNull();
    expect(canonicalRedirect(`${OLD}/posts`, "not a url")).toBeNull();
  });
});
