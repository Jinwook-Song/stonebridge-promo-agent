import { describe, expect, it, vi } from "vitest";
import { GenerationError, makeFakeClaudeCalls, type PickCall } from "../app/promo/claude.server";
import { buildPickRequest, cleanPicks, pickPhotos, type PhotoPickOutput } from "../app/promo/photo-pick.server";
import { MAX_PICK_CANDIDATES, MAX_THUMB_BYTES } from "../app/promo/types";
import { handlePhotoPick } from "../app/promo/photo-pick-route.server";

// Synthetic bytes labelled as JPEG: the stub calls never decode them.
const TINY = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const thumb = (bytes: Uint8Array<ArrayBuffer> = TINY, type = "image/jpeg") => new File([bytes], "t.jpg", { type });

function pickForm(files: File[], fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("kind", fields.kind ?? "case");
  form.set("memo", fields.memo ?? "샌드위치 30인분 단체 주문");
  if (fields.privateCustomer) form.set("privateCustomer", fields.privateCustomer);
  for (const f of files) form.append("thumbs", f);
  return new Request("http://localhost/api/photo-pick", { method: "POST", body: form });
}

const stub =
  (output: PhotoPickOutput): PickCall =>
  async () => ({ output, inputTokens: 100, outputTokens: 10 });

const never: PickCall = async () => {
  throw new Error("pick must not be called");
};

const thumbs3 = [1, 2, 3].map((i) => ({ media_type: "image/jpeg" as const, data: `AAA${i}` }));

describe("cleanPicks", () => {
  it("drops out-of-range, duplicate and extra picks", () => {
    const raw = { picks: [3, 0, 3, 11, 1, 2, 4, 5, 6, 7, 8, 9].map((n) => ({ n, reason: "r" })) };
    expect(cleanPicks(raw, 10).map((p) => p.n)).toEqual([3, 1, 2, 4, 5, 6, 7, 8]);
  });

  it("trims and caps reasons", () => {
    const long = "가".repeat(50);
    const [p] = cleanPicks({ picks: [{ n: 1, reason: `  ${long}  ` }] }, 2);
    expect(p.reason).toBe("가".repeat(40));
    expect(cleanPicks({ picks: [{ n: 1, reason: "  상자 포장  " }] }, 2)[0].reason).toBe("상자 포장");
  });
});

describe("buildPickRequest", () => {
  it("labels every photo in order", () => {
    const req = buildPickRequest({ memo: "  샌드위치 30인분  ", kind: "case", privateCustomer: false, thumbs: thumbs3 });
    expect(req.user.map((b) => b.type)).toEqual(["text", "image", "text", "image", "text", "image", "text"]);
    expect(req.user.filter((b) => b.type === "text").slice(0, 3)).toEqual([
      { type: "text", text: "사진 1" },
      { type: "text", text: "사진 2" },
      { type: "text", text: "사진 3" },
    ]);
    expect(req.user[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA1" } });
    expect(req.user[5]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA3" } });
    const last = req.user[6] as { type: "text"; text: string };
    expect(last.text).toContain("샌드위치 30인분");
    expect(last.text).toContain("단체 주문 사례");
    expect(last.text).not.toContain("얼굴");
    expect(req.system.length).toBeGreaterThan(0);
  });

  it("says (메모 없음) for an empty memo", () => {
    const req = buildPickRequest({ memo: "  ", kind: "product", privateCustomer: false, thumbs: thumbs3 });
    expect((req.user.at(-1) as { text: string }).text).toContain("(메모 없음)");
  });

  it("asks to skip faces for a private customer", () => {
    const req = buildPickRequest({ memo: "케이크", kind: "case", privateCustomer: true, thumbs: thumbs3 });
    expect((req.user.at(-1) as { text: string }).text).toContain("얼굴");
  });
});

describe("pickPhotos", () => {
  it("returns cleaned picks and token counts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const out = await pickPhotos(stub({ picks: [{ n: 3, reason: "전체" }, { n: 9, reason: "x" }] }), {
        memo: "",
        kind: "other",
        privateCustomer: false,
        thumbs: thumbs3,
      });
      expect(out).toEqual({ picks: [{ n: 3, reason: "전체" }], inputTokens: 100, outputTokens: 10 });
      expect(info).toHaveBeenCalledWith(
        "photo pick",
        expect.objectContaining({ count: 3, inputTokens: 100, outputTokens: 10 }),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe("fake pick", () => {
  it("returns the first min(8, N) photos in order", async () => {
    const { pick } = makeFakeClaudeCalls();
    const twelve = Array.from({ length: 12 }, () => ({ media_type: "image/jpeg" as const, data: "AA" }));
    vi.useFakeTimers();
    try {
      const p = pick(buildPickRequest({ memo: "", kind: "case", privateCustomer: false, thumbs: twelve }));
      await vi.runAllTimersAsync();
      const { output } = await p;
      expect(output.picks.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(output.picks[0].reason).toBe("테스트 사진");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/photo-pick", () => {
  it("exports the shared limits", () => {
    expect(MAX_PICK_CANDIDATES).toBe(40);
    expect(MAX_THUMB_BYTES).toBe(300 * 1024);
  });

  it("rejects 1 photo and 41 photos with 400", async () => {
    for (const n of [1, 41]) {
      const res = await handlePhotoPick(pickForm(Array.from({ length: n }, () => thumb())), { pick: never });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/사진/);
    }
  });

  it("rejects a 301 KB thumb", async () => {
    const res = await handlePhotoPick(pickForm([thumb(), thumb(new Uint8Array(301 * 1024))]), { pick: never });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/사진/);
  });

  it("rejects a wrong type, a bad kind and a too-long memo", async () => {
    const bad = [
      pickForm([thumb(), thumb(TINY, "image/gif")]),
      pickForm([thumb(), thumb()], { kind: "nope" }),
      pickForm([thumb(), thumb()], { memo: "가".repeat(501) }),
    ];
    for (const req of bad) {
      const res = await handlePhotoPick(req, { pick: never });
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
  });

  it("returns cleaned picks", async () => {
    let seen: { images: number; last: string } | null = null;
    const pick: PickCall = async (req) => {
      seen = {
        images: req.user.filter((b) => b.type === "image").length,
        last: (req.user.at(-1) as { text: string }).text,
      };
      return { output: { picks: [{ n: 2, reason: "포장 상자" }, { n: 2, reason: "중복" }, { n: 1, reason: "전체 모습" }] }, inputTokens: 1, outputTokens: 1 };
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const res = await handlePhotoPick(pickForm([thumb(), thumb(TINY, "image/png")], { privateCustomer: "on" }), {
        pick,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        picks: [
          { n: 2, reason: "포장 상자" },
          { n: 1, reason: "전체 모습" },
        ],
      });
      expect(seen).toEqual({ images: 2, last: expect.stringContaining("얼굴") });
    } finally {
      info.mockRestore();
    }
  });

  it("maps a GenerationError(refusal) to 502 with its Korean message", async () => {
    const pick: PickCall = async () => {
      throw new GenerationError("refusal");
    };
    const res = await handlePhotoPick(pickForm([thumb(), thumb()]), { pick });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: new GenerationError("refusal").message });
  });

  it("returns 502 with the manual-pick message when no pick is usable", async () => {
    const pick = stub({ picks: [{ n: 0, reason: "x" }, { n: 3, reason: "y" }] });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handlePhotoPick(pickForm([thumb(), thumb()]), { pick });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "사진 고르기에 실패했어요. 직접 골라 주세요." });
    } finally {
      info.mockRestore();
      err.mockRestore();
    }
  });

  it("maps an unknown failure to 502 with the manual-pick message", async () => {
    const pick: PickCall = async () => {
      throw new Error("boom");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handlePhotoPick(pickForm([thumb(), thumb()]), { pick });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "사진 고르기에 실패했어요. 직접 골라 주세요." });
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});
