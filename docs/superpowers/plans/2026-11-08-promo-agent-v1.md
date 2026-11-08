# 홍보글 에이전트 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사장님이 휴대폰에서 사진(0~8장) + 메모를 올리면 블로그·인스타·당근·플레이스 초안을 한 번에 만들고, 고치고, 복사하고, 확정하는 웹 앱 (Day 4, 2026-11-11 06:00 KST).

**Architecture:** React Router 8 SSR on Cloudflare Workers, D1 (Drizzle) + R2 사진. 생성은 Cloudflare Workflow 한 단계에서 `claude-opus-5-5` 한 번 호출(구조화 출력)로 네 채널을 받는다. 꼬리말·가격표는 AI가 아닌 코드가 붙이고, 숫자 사실 확인은 화면 표시용 순수 함수.

**Tech Stack:** react-router 8.5, @cloudflare/vite-plugin, wrangler 4, drizzle-orm (d1), vitest 5 + @cloudflare/vitest-plugin, Tailwind 4 + shadcn(radix-ui), @anthropic-ai/sdk + zod.

**Spec:** `docs/superpowers/specs/2026-11-08-promo-agent-design.md`

**Reference codebase:** `~/repository/mine/web/cafe-manager` (private, same author). "copy from cafe-manager" means copy the file, then delete anything domain-specific (employees, shifts, payroll, documents, share links).

## Global Constraints

- **Public repo.** No owner data in git: no real footer, phone, prices, blog text, photos. Real data lives in D1/R2, seeded from `private/` (already gitignored). Test fixtures are synthetic.
- Model `claude-opus-5-5`, `output_config.effort: "high"`, adaptive thinking (omit `thinking`), streaming + `finalMessage()`, `max_tokens: 32000`, beta `server-side-fallback-2026-07-01` + `fallbacks: "default"`. No prefill, no forced `tool_choice`. JSON only via `output_config.format`.
- Secrets (Cloudflare secret / `.dev.vars`): `ANTHROPIC_API_KEY`, `SESSION_SECRET` (≥32 chars), `OWNER_INITIAL_PASSWORD` (≥8 chars), `IMAGE_URL_SECRET` (≥32 chars). `.dev.vars.example` lists names only.
- Channels: `"blog" | "instagram" | "daangn" | "place"`. Post kinds: `"case" | "product" | "other"` (화면 이름: 단체 주문 사례 / 상품·시즌 안내 / 기타).
- Photos: 0~8 per post, `image/jpeg|png|webp`, ≤5 MB each after client resize (long edge 1600px JPEG q0.85).
- Signed image URL TTL 600 s.
- All promo code under `app/promo/` (later merged into cafe-manager).
- UI copy in Korean, phone-first (375px wide, one-handed).
- Worker name `stonebridge-promo`, D1 `promo-agent`, R2 `promo-photos`, Workflow binding `GENERATE` class `GeneratePostWorkflow`.

## Review Focus

1. **Claude fails** (refusal, `max_tokens`, JSON that fails the schema, network) → post becomes `failed` with a Korean reason and a 다시 시도 button; never stuck on `generating`. → Task 7 tests.
2. **Double tap / reopened page** while generating → only one Workflow instance runs; a second start is refused. → Task 7 test `startGeneration refuses while generating`.
3. **Zero photos** → generation works, no image blocks sent, prompt tells model not to write `[사진 N]`. → Task 6 test.
4. **Same number, different spelling** (`20,500` vs `20500`, `70세트` vs `70 세트`) → not flagged by fact check. → Task 6 test.
5. **Settings not filled yet** (empty footer / price table) → copied text has no `undefined`, no trailing blank-line pile. → Task 6 test.

---

### Task 1: Scaffold, schema, test harness

**Files:**
- Create (copy from cafe-manager, strip domain bits): `package.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `react-router.config.ts`, `drizzle.config.ts`, `components.json`, `app/root.tsx`, `app/app.css`, `app/lib/utils.ts`, `app/server/db.ts`, `app/server/errors.ts`, `workers/app.ts`, `test/apply-migrations.ts`, `test/env.d.ts`, `app/components/ui/*` (only button, input, textarea, label, tabs, checkbox, card, badge, sonner/toast if present)
- Create: `wrangler.jsonc`, `database/schema.ts`, `drizzle/0000_init.sql` (via `npx drizzle-kit generate`), `.dev.vars.example`, `app/promo/types.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Produces: `getDb(d1: D1Database): Db`, `withD1Session` (as cafe-manager); `DomainError(code, message)`; tables below; types `Channel`, `PostKind`, `PostStatus = "draft" | "generating" | "ready" | "failed"`, `CHANNELS: readonly Channel[]` in order blog, instagram, daangn, place.

Tables (`database/schema.ts`, sqlite, ISO-string timestamps like cafe-manager):
- `settings(key text pk, value text not null)`
- `login_attempts(id int pk auto, ip text, at text, ok int bool)`
- `posts(id int pk auto, kind text, memo text, private_customer int bool, attach_prices int bool, status text, workflow_id text null, error text null, input_tokens int null, output_tokens int null, created_at text, generated_at text null)`
- `photos(id int pk auto, post_id int fk cascade, r2_key text unique, position int, width int, height int)`; unique `(post_id, position)`
- `drafts(id int pk auto, post_id int fk cascade, channel text, version int, title text null, body text, hashtags text null /* JSON array */, source text /* ai|edit */, confirmed_at text null, edit_ratio real null, created_at text)`; unique `(post_id, channel, version)`
- `examples(id int pk auto, channel text, kind text, title text null, body text, source text /* blog_import|owner_final */, enabled int bool default 1, source_url text null, created_at text)`

`wrangler.jsonc`: name `stonebridge-promo`, `compatibility_flags: ["nodejs_als"]`, `main: ./workers/app.ts`, `secrets.required` = the four secrets, D1 `DB` → `promo-agent` (`database_id` placeholder `"TBD-after-d1-create"` until Task 9), R2 `PHOTOS` → `promo-photos`, `workflows: [{ name: "generate-post", binding: "GENERATE", class_name: "GeneratePostWorkflow" }]`, observability on.

`package.json` deps: cafe-manager's set minus `react-day-picker`, `date-fns`; plus `@anthropic-ai/sdk`, `zod`.

- [ ] **Step 1: Copy/scaffold files above; `npm install`; `npx drizzle-kit generate --name init`**
- [ ] **Step 2: Write `test/schema.test.ts`**

```ts
it("stores a post with photos and drafts", async () => {
  const db = getDb(env.DB);
  const [p] = await db.insert(posts).values({ kind: "case", memo: "m", privateCustomer: false,
    attachPrices: false, status: "ready", createdAt: "2026-11-08T00:00:00Z" }).returning();
  await db.insert(drafts).values({ postId: p.id, channel: "blog", version: 1, body: "b",
    source: "ai", createdAt: "2026-11-08T00:00:00Z" });
  await expect(db.insert(drafts).values({ postId: p.id, channel: "blog", version: 1, body: "x",
    source: "ai", createdAt: "2026-11-08T00:00:00Z" })).rejects.toThrow();
});
```

- [ ] **Step 3: Run `npx vitest run test/schema.test.ts`** — Expected: PASS. Also `npm run typecheck` passes (workers/app.ts may temporarily export a stub `GeneratePostWorkflow extends WorkflowEntrypoint` with an empty `run` so wrangler types resolve).
- [ ] **Step 4: Commit** `chore: scaffold RR8 worker, D1 schema, test harness`

---

### Task 2: Owner login

**Files:**
- Create (copy from cafe-manager): `app/lib/crypto.ts`, `app/server/session.server.ts` (admin storage only, cookie `__owner`), `app/server/auth.server.ts`, `app/routes/login.tsx`, `app/routes/logout.tsx`, `app/routes/owner-layout.tsx` (cafe-manager `admin-layout.tsx` auth middleware + phone header with links 글 목록 / 설정), `app/routes.ts`
- Test: `test/auth.test.ts`, `test/crypto.test.ts` (copy, adapt names)

**Interfaces:**
- Produces: `requireOwner(request: Request, env: Env): Promise<void>` (redirects to `/login`); `ensureOwnerPassword(db, initial)`; `attemptLogin(db, ip, pw, now): Promise<boolean>`; settings key `owner_password_hash`. Rate limit unchanged: 5 failures / 10 min / IP.

- [ ] **Step 1: Copy tests; rename admin→owner; run** `npx vitest run test/auth.test.ts` — Expected: FAIL (module missing)
- [ ] **Step 2: Copy implementation; `ensureOwnerPassword` reads `env.OWNER_INITIAL_PASSWORD`**
- [ ] **Step 3: Run tests** — Expected: PASS (wrong pw false, right pw true, 6th failure → `RATE_LIMITED`)
- [ ] **Step 4: Commit** `feat: owner password login`

---

### Task 3: Settings and examples store

**Files:**
- Create: `app/promo/default-rules.ts`, `app/promo/settings.server.ts`, `app/promo/examples.server.ts`, `app/routes/settings.tsx`
- Test: `test/settings.test.ts`, `test/examples.test.ts`

**Interfaces:**
- Produces:
  - `type PromoSettings = { footerBlog: string; footerShort: string; priceTable: string; voiceRules: string; channelRules: string }`
  - `getSettings(db: Db): Promise<PromoSettings>` — missing keys fall back to `DEFAULT_VOICE_RULES` / `DEFAULT_CHANNEL_RULES` (from `default-rules.ts`) and `""` for footers/prices.
  - `saveSettings(db: Db, patch: Partial<PromoSettings>): Promise<void>` (upsert; keys `footer_blog`, `footer_short`, `price_table`, `voice_rules`, `channel_rules`).
  - `type Example = { id: number; channel: Channel; kind: PostKind; title: string | null; body: string; source: "blog_import" | "owner_final" }`
  - `pickExamples(db: Db, channel: Channel, kind: PostKind, limit: number): Promise<Example[]>` — enabled only; order: `owner_final` before `blog_import`, same `kind` before other kinds, newest first.
  - `addExample(db, ex: Omit<Example,"id"> & { sourceUrl?: string }, now: Date): Promise<number>`; `setExampleEnabled(db, id, enabled)`; `listExamples(db): Promise<(Example & {enabled:boolean})[]>`.
- `DEFAULT_VOICE_RULES` / `DEFAULT_CHANNEL_RULES`: spec §5.7 text verbatim (공통 + 블로그 + 인스타/당근/플레이스). These are style rules, not owner data — fine in repo.
- No seed migration: footers/prices stay unset until the owner fills them; the settings page shows an amber `아직 비어 있음` note on empty fields.

- [ ] **Step 1: Tests**

```ts
it("falls back to default rules and empty footers", async () => {
  const s = await getSettings(db);
  expect(s.footerBlog).toBe(""); expect(s.voiceRules).toBe(DEFAULT_VOICE_RULES);
});
it("saveSettings upserts", async () => {
  await saveSettings(db, { footerBlog: "A" }); await saveSettings(db, { footerBlog: "B" });
  expect((await getSettings(db)).footerBlog).toBe("B");
});
it("pickExamples: owner_final first, then same kind, newest, enabled only", async () => {
  // seed: blog_import case (old), blog_import case (new), blog_import product (newest),
  //       owner_final product (old), blog_import case disabled
  const got = await pickExamples(db, "blog", "case", 3);
  expect(got.map(e => [e.source, e.kind])).toEqual([
    ["owner_final", "product"], ["blog_import", "case"], ["blog_import", "case"]]);
  expect(got[1].id).toBe(newCaseId);
});
it("pickExamples returns [] for a channel with no examples", async () => {
  expect(await pickExamples(db, "place", "case", 2)).toEqual([]);
});
```

- [ ] **Step 2: Run** `npx vitest run test/settings.test.ts test/examples.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement the functions above**
- [ ] **Step 4: Settings page** (`/settings`): five textareas (꼬리말 블로그 / 꼬리말 짧은 판 / 가격표 / 말투 규칙 / 채널 규칙) with 저장; below, example list (channel, kind, title, 켜기/끄기 toggle). Kind is editable per example (select).
- [ ] **Step 5: Run tests** — Expected: PASS
- [ ] **Step 6: Commit** `feat: settings and example store`

---

### Task 4: Blog import script

**Files:**
- Create: `scripts/blog/parse.ts`, `scripts/import-blog.ts`, `test/fixtures/se-post.html` (synthetic, ~15 lines of Naver SmartEditor markup, invented text)
- Test: `test/blog-parse.test.ts`

**Interfaces:**
- Produces:
  - `parseRss(xml: string): { title: string; url: string; logNo: string; pubDate: string }[]` — handles `<![CDATA[...]]>` in `title` and `link`, strips `?fromRss...` query.
  - `parsePostHtml(html: string): string` — walks the SmartEditor body in document order: each `<p class="se-text-paragraph...">` → its text (HTML-unescaped, tags stripped, zero-width `​` → empty line); each `se-image-resource` image → `[사진 N]` (N counts from 1). Joined with `\n`; runs of 3+ newlines collapsed to 2. The post title paragraph (first `se-title-text` / first paragraph equal to RSS title) is dropped.
  - `classifyKind(title: string): PostKind` — `"case"` if `/단체\s?주문|\d+\s?(세트|인분)|\d{3,}\s?개/` matches, else `"product"`.
- `scripts/import-blog.ts` (run `npx tsx scripts/import-blog.ts --blog stone_bridge_ --limit 50`): fetch `https://rss.blog.naver.com/<blog>.xml`, then each `https://m.blog.naver.com/PostView.naver?blogId=<blog>&logNo=<logNo>` (User-Agent mobile, 500 ms between requests), write `private/examples.json` and `private/seed-examples.sql` (`INSERT INTO examples (channel, kind, title, body, source, enabled, source_url, created_at) VALUES ('blog', ...)`, single quotes doubled). Footer block is NOT stripped by the script (settings page lets owner disable; prompt says footers are added by code) — **exception:** strip text from the line starting with the configured `--footer-start` string (default `30만원 이상 구매시`) to the end, so examples don't teach the model to write footers.

- [ ] **Step 1: Tests**

```ts
it("parseRss reads CDATA title and link", () => {
  expect(parseRss(RSS_FIXTURE)[0]).toEqual({ title: "[OO초등학교] 샌드위치 30인분 단체주문",
    url: "https://blog.naver.com/demo/123", logNo: "123", pubDate: "Sun, 01 Nov 2026 10:00:00 +0900" });
});
it("parsePostHtml keeps line order and numbers photos", () => {
  expect(parsePostHtml(fixture)).toBe("여는 줄입니다!\n\n[사진 1]\n주문 주셨어요 ˶ˆᗜˆ˵\n[사진 2]");
});
it.each([
  ["[OO초등학교] 샌드위치 + 음료 단체주문", "case"],
  ["[결혼식 답례품] 마카롱3구 + 쿠키 2개 120세트", "case"],
  ["[OO관리소] 마카롱900개 | 마카롱 12구 75세트", "case"],
  ["[단체메뉴] 마카롱 4구 세트 10,500", "product"],
  ["스톤브릿지 2026 수능 마카롱 선물세트", "product"],
])("classifyKind(%s) = %s", (t, k) => expect(classifyKind(t)).toBe(k));
```

- [ ] **Step 2: Run** `npx vitest run test/blog-parse.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement parse functions (regex is fine; no DOM in Workers test pool) and the CLI**
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Run the CLI locally once**; check `private/examples.json` has ≈50 entries, bodies contain `[사진 N]`, none contain the footer start string. `git status` shows nothing under `private/`.
- [ ] **Step 6: Commit** `feat: blog example importer`

---

### Task 5: Posts, photo upload, signed image URLs

**Files:**
- Create: `app/promo/image-url.ts`, `app/promo/posts.server.ts`, `app/promo/resize-image.client.ts`, `app/routes/img.ts` (route `img/*`, key = splat param), `app/routes/post-new.tsx`
- Test: `test/image-url.test.ts`, `test/posts.test.ts`

**Interfaces:**
- Produces:
  - `signImageUrl(origin: string, key: string, secret: string, now: Date, ttlSec = 600): Promise<string>` → `${origin}/img/${key}?exp=<unix>&sig=<base64url HMAC-SHA256 of "key\nexp">`
  - `verifyImageSig(key: string, exp: string, sig: string, secret: string, now: Date): Promise<boolean>` (constant-time compare via `crypto.subtle.verify`)
  - `type NewPostInput = { kind: PostKind; memo: string; privateCustomer: boolean; attachPrices: boolean; photos: File[] }`
  - `createPost(db: Db, bucket: R2Bucket, input: NewPostInput, now: Date): Promise<number>` — memo trimmed 1..500 chars; photos 0..8; type in jpeg/png/webp; size ≤ 5 MB; else `DomainError("INVALID_INPUT", <Korean message>)`. R2 key `posts/<postId>/<position>.jpg` (position 1-based, upload order). Width/height from form fields `photoWidth[]`/`photoHeight[]` sent by the client (0 if missing). Status starts `"draft"`; the route calls `startGeneration` (Task 7) right after creating. Until Task 7 lands, the route only creates and redirects to `/posts/:id`.
  - `getPost(db, id): Promise<PostView | null>` where `PostView = { post; photos: {id, position, r2Key, width, height}[]; drafts: Record<Channel, DraftRow | null> /* latest version each */ }`
  - `listPosts(db, limit = 50)` newest first with first 40 chars of memo + status.
- `/img/*` route: allow if `verifyImageSig` passes **or** owner session valid; stream `PHOTOS.get(key)` with `Content-Type: image/jpeg`, `Cache-Control: private, max-age=600`; 404 if missing, 403 otherwise.
- `resizeToJpeg(file: File, maxEdge = 1600, quality = 0.85): Promise<{ blob: Blob; width: number; height: number }>` — `createImageBitmap` + `OffscreenCanvas`/canvas fallback. Browser only, verified manually.
- `post-new.tsx`: photo picker (`accept="image/*" multiple`, thumbnails, remove ×, max 8 enforced client-side), memo textarea (placeholder `예) 구리 OO고등학교 마카롱 6구 40세트, 리본+쇼핑백, 선생님 선물용`), kind radio (3), 개인 고객 checkbox, 가격표 붙이기 checkbox, submit `초안 만들기`. Client resizes then posts `multipart/form-data`.

- [ ] **Step 1: Tests**

```ts
it("signed url verifies until expiry", async () => {
  const url = new URL(await signImageUrl("https://x.dev", "posts/1/1.jpg", SECRET, T0));
  const [exp, sig] = [url.searchParams.get("exp")!, url.searchParams.get("sig")!];
  expect(await verifyImageSig("posts/1/1.jpg", exp, sig, SECRET, T0)).toBe(true);
  expect(await verifyImageSig("posts/1/2.jpg", exp, sig, SECRET, T0)).toBe(false);
  expect(await verifyImageSig("posts/1/1.jpg", exp, sig, SECRET, new Date(T0.getTime() + 601_000))).toBe(false);
});
it("createPost rejects 9 photos, empty memo, gif", async () => { /* 3 expects: rejects.toThrow(DomainError) */ });
it("createPost stores rows and R2 objects in order", async () => {
  const id = await createPost(db, env.PHOTOS, { kind: "case", memo: " 메모 ", privateCustomer: true,
    attachPrices: false, photos: [jpg("a"), jpg("b")] }, T0);
  const v = await getPost(db, id);
  expect(v!.post.memo).toBe("메모");
  expect(v!.photos.map(p => p.r2Key)).toEqual([`posts/${id}/1.jpg`, `posts/${id}/2.jpg`]);
  expect(await env.PHOTOS.get(`posts/${id}/2.jpg`)).not.toBeNull();
});
it("createPost allows zero photos", async () => { /* resolves to a number */ });
```

- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npx vitest run test/image-url.test.ts test/posts.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** `feat: create post with photos, signed image urls`

---

### Task 6: Prompt, output schema, fixed text, fact check (pure)

**Files:**
- Create: `app/promo/prompt.ts`, `app/promo/fixed-text.ts`, `app/promo/fact-check.ts`
- Test: `test/prompt.test.ts`, `test/fixed-text.test.ts`, `test/fact-check.test.ts`

**Interfaces:**
- Produces:
  - `DraftOutput` (zod): `{ blog: { title: string; body: string }, instagram: { body: string; hashtags: string[] }, daangn: { title: string; body: string }, place: { body: string }, photos: { n: number; note: string }[] }`
  - `ChannelRewrite` (zod): `{ title: string | null; body: string; hashtags: string[] | null }`
  - `buildSystem(s: PromoSettings, ex: { blog: Example[]; instagram: Example[]; daangn: Example[]; place: Example[] }): string` — sections in this fixed order (cache-stable): role line → `## 말투 규칙` (voiceRules) → `## 채널 규칙` (channelRules) → `## 절대 규칙` → `## 예시 글` grouped by channel (`### 블로그 예시 1 (단체 주문 사례)` + title + body). 절대 규칙 text (exact):
    ```
    - 메모, 사진, 사장님이 준 정보에 없는 숫자·가격·날짜·기관 이름·사람 이름은 쓰지 않는다. 모르면 그 문장을 빼거나 "문의 주세요"로 쓴다.
    - 꼬리말(배송 정책, 주소, 영업시간, 연락처)과 가격표는 쓰지 않는다. 프로그램이 따로 붙인다.
    - 일반 이모지(😊🎉👍 등)는 쓰지 않는다. 얼굴 문자만 쓴다.
    - 개인 고객 주문이면 이름·연락처·사는 곳을 쓰지 않는다.
    ```
  - `buildUserContent(post: { kind; memo; privateCustomer; attachPrices }, photoUrls: string[]): Anthropic.ContentBlockParam[]` — one `{type:"image", source:{type:"url", url}}` per photo, preceded by a text block `사진 N` label each; then a final text block: 글 종류 (Korean label), 메모, 개인 고객 여부, and either `블로그 본문에 사진 위치를 [사진 1]~[사진 K]로 표시하세요.` or (0 photos) `사진이 없습니다. [사진] 표시를 쓰지 마세요.`
  - `pickExampleSet(db, kind): Promise<{blog; instagram; daangn; place}>` — blog 3, others 2 each, via `pickExamples` (lives here, uses Task 3).
  - `withFixedText(channel: Channel, d: { body: string; hashtags?: string[] | null }, s: PromoSettings, attachPrices: boolean): string` — joins non-empty parts with `\n\n`, trims each part:
    - blog: body, (attachPrices ? priceTable : ""), footerBlog
    - instagram: body, footerShort, hashtags as `#a #b` (strip leading `#` from input, dedupe)
    - daangn: body, (attachPrices ? priceTable : ""), footerShort
    - place: body
  - `findUnsupportedNumbers(text: string, sources: string[]): string[]` — tokens matching `/\d[\d,]*(?:\.\d+)?\s?(?:원|구|세트|인분|개|명|시|분|일|월|%)?/g`, ignoring those inside `[사진 N]`; normalize by removing `,` and whitespace; supported if its digit run (commas removed) equals some digit run in the sources (commas removed) — exact run match, not substring, so `20,500` ≈ `20500원` but `0` is not supported by `70`. Returns original tokens, deduped, in order.
  - `findPossibleNames(text: string): string[]` — `/([가-힣]{2,3})\s?(님|씨)/g`, excluding `사장|손님|고객|선생|여러분|담당자|직원|원장|부장|팀장|과장|대리`.

- [ ] **Step 1: Tests**

```ts
// prompt
it("zero photos → no image blocks and no-marker instruction", () => {
  const c = buildUserContent({ kind: "product", memo: "크리스마스 마카롱", privateCustomer: false, attachPrices: true }, []);
  expect(c.filter(b => b.type === "image")).toHaveLength(0);
  expect(JSON.stringify(c)).toContain("[사진] 표시를 쓰지 마세요");
});
it("two photos → labelled url images in order", () => { /* image urls a,b; text "사진 1" before a */ });
it("system prompt is byte-identical for identical inputs and contains 절대 규칙", () => {
  expect(buildSystem(S, EX)).toBe(buildSystem(S, EX)); expect(buildSystem(S, EX)).toContain("## 절대 규칙");
});
// fixed text
it("blog with prices and footer", () => {
  expect(withFixedText("blog", { body: "본문\n" }, { ...S, priceTable: "4구 : 10,500", footerBlog: "주소" }, true))
    .toBe("본문\n\n4구 : 10,500\n\n주소");
});
it("empty settings leave no blank tail or undefined", () => {
  const out = withFixedText("daangn", { body: "본문" }, { ...S, priceTable: "", footerShort: "" }, true);
  expect(out).toBe("본문");
});
it("instagram hashtags normalized", () => {
  expect(withFixedText("instagram", { body: "b", hashtags: ["#구리카페", "구리카페", "마카롱"] }, { ...S, footerShort: "" }, false))
    .toBe("b\n\n#구리카페 #마카롱");
});
it("place never gets footer or prices", () => { /* === body */ });
// fact check
it("comma and unit spelling differences are supported", () => {
  expect(findUnsupportedNumbers("8구 20,500원 70 세트", ["8구 20500", "70세트"])).toEqual([]);
});
it("invented numbers are flagged, photo markers ignored", () => {
  expect(findUnsupportedNumbers("[사진 3] 100세트 주문! 5~7일 전", ["70세트"])).toEqual(["100세트", "5", "7일"]);
});
it("names flagged except role words", () => {
  expect(findPossibleNames("김민수님 감사합니다 사장님 손님")).toEqual(["김민수님"]);
});
```

- [ ] **Step 2: Run** `npx vitest run test/prompt.test.ts test/fixed-text.test.ts test/fact-check.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `feat: prompt builder, fixed text, fact check`

---

### Task 7: Claude call, generation runner, Workflow

**Files:**
- Create: `app/promo/claude.server.ts`, `app/promo/generate.server.ts`, `workers/generate-workflow.ts`; Modify: `workers/app.ts` (export the class), `app/routes/post-new.tsx` (start after create)
- Test: `test/generate.test.ts`

**Interfaces:**
- Consumes: Task 3 `getSettings`, Task 5 `getPost`, `signImageUrl`, Task 6 everything.
- Produces:
  - `class GenerationError extends Error { constructor(reason: "refusal" | "max_tokens" | "invalid_output"); reason }` — `message` is a fixed Korean string per reason (e.g. refusal → `AI가 이 요청을 거절했어요. 메모를 바꿔 다시 시도해 주세요.`).
  - `type DraftCall = (req: { system: string; user: Anthropic.ContentBlockParam[] }) => Promise<{ output: DraftOutput; inputTokens: number; outputTokens: number }>`
  - `type RewriteCall = (req: { system: string; user: Anthropic.ContentBlockParam[] }) => Promise<{ output: ChannelRewrite; inputTokens: number; outputTokens: number }>`
  - `makeClaudeCalls(apiKey: string): { drafts: DraftCall; rewrite: RewriteCall }` — `client.beta.messages.stream({ model: "claude-opus-5-5", max_tokens: 32000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "high", format: zodOutputFormat(Schema) }, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] })` → `finalMessage()`; check `stop_reason` (`refusal`, `max_tokens`) before reading; take the text block, `JSON.parse` + `Schema.safeParse`; failures → `GenerationError`. If the SDK's beta stream typing rejects `output_config.format` with a zod helper, pass the JSON schema object (`{ type: "json_schema", schema: z.toJSONSchema(Schema) }`) — let the compiler decide.
  - `type GenDeps = { db: Db; drafts: DraftCall; rewrite: RewriteCall; signUrl: (key: string) => Promise<string>; now: () => Date }`
  - `runGeneration(deps: GenDeps, postId: number): Promise<void>` — load post/photos/settings/examples → `buildSystem` + `buildUserContent` → call → insert 4 drafts (`version` = max+1 per channel, `source: "ai"`, body without fixed text, blog title, instagram hashtags JSON) → post `status: "ready"`, `generated_at`, tokens. On `GenerationError` or any error: `status: "failed"`, `error: message` (non-GenerationError → `잠시 후 다시 시도해 주세요.`), then rethrow only non-GenerationError (so Workflow retries transient errors).
  - `runRewrite(deps, postId, channel: Channel, instruction: string): Promise<void>` — same system; user = photos + memo + `현재 ${label} 초안:\n${body}\n\n사장님 요청: ${instruction || "다시 써 주세요"}\n이 채널 글만 다시 쓰세요.` → insert new version for that channel only; post status back to `ready`.
  - `startGeneration(env: Env, db: Db, postId: number, job: { channel?: Channel; instruction?: string }): Promise<void>` — conditional update `status → "generating"` **only if current status ≠ "generating"** (single SQL `UPDATE ... WHERE id=? AND status != 'generating'`; zero rows changed → `DomainError("BUSY", "이미 만드는 중이에요.")`), then `env.GENERATE.create({ id: \`post-${postId}-${Date.now()}\`, params: { postId, ...job } })`, store `workflow_id`.
  - `GeneratePostWorkflow.run(event, step)`: `await step.do("generate", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, () => job.channel ? runRewrite(...) : runGeneration(...))`. Wrap in try/catch: after retries exhausted, set `status: "failed"` if still `generating`. `signUrl` uses origin from `env.PUBLIC_ORIGIN` (add to `wrangler.jsonc` `vars`, e.g. `https://stonebridge-promo.<subdomain>.workers.dev`).

- [ ] **Step 1: Tests (fake `drafts`/`rewrite` calls; real D1)**

```ts
it("runGeneration saves 4 drafts and marks ready", async () => {
  await runGeneration(deps({ drafts: async () => ({ output: OUT, inputTokens: 10, outputTokens: 20 }) }), postId);
  const v = await getPost(db, postId);
  expect(v!.post.status).toBe("ready"); expect(v!.post.outputTokens).toBe(20);
  expect(Object.values(v!.drafts).every(d => d?.version === 1 && d.source === "ai")).toBe(true);
  expect(v!.drafts.blog!.title).toBe(OUT.blog.title);
});
it("refusal marks failed with Korean reason and does not throw", async () => {
  await runGeneration(deps({ drafts: async () => { throw new GenerationError("refusal"); } }), postId);
  const v = await getPost(db, postId);
  expect(v!.post.status).toBe("failed"); expect(v!.post.error).toContain("거절");
});
it("transient error marks failed and rethrows for workflow retry", async () => {
  await expect(runGeneration(deps({ drafts: async () => { throw new Error("ECONNRESET"); } }), postId)).rejects.toThrow();
  expect((await getPost(db, postId))!.post.status).toBe("failed");
});
it("runRewrite adds version 2 for one channel only", async () => { /* blog v2, instagram still v1 */ });
it("startGeneration refuses while generating", async () => {
  await startGeneration(fakeEnv, db, postId, {});
  await expect(startGeneration(fakeEnv, db, postId, {})).rejects.toThrow("이미 만드는 중");
  expect(fakeEnv.GENERATE.create).toHaveBeenCalledTimes(1);
});
it("runGeneration passes signed urls, not base64", async () => { /* captured user blocks have source.type "url" */ });
```

- [ ] **Step 2: Run** `npx vitest run test/generate.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** (claude.server.ts is not unit-tested; covered by Task 9 live check)
- [ ] **Step 4: Run** — Expected: PASS; `npm run typecheck` PASS
- [ ] **Step 5: Commit** `feat: draft generation via Claude in a Workflow`

---

### Task 8: Result screen, edit, confirm, post list

**Files:**
- Create: `app/promo/drafts.server.ts`, `app/promo/edit-ratio.ts`, `app/routes/posts.tsx` (index), `app/routes/post-detail.tsx`, `app/routes/api.post-status.ts`
- Modify: `app/routes.ts`
- Test: `test/drafts.test.ts`, `test/edit-ratio.test.ts`

**Interfaces:**
- Produces:
  - `editRatio(before: string, after: string): number` — line-level Levenshtein distance ÷ max(line count, 1), rounded to 2 decimals; identical → 0, fully different → 1.
  - `saveDraftEdit(db, postId, channel, patch: { title?: string | null; body: string; hashtags?: string[] | null }, now): Promise<number>` → new version, `source: "edit"`; no-op (returns current version) if unchanged.
  - `confirmDraft(db, postId, channel, now): Promise<void>` — latest version gets `confirmed_at`, `edit_ratio = editRatio(firstAiVersion.body, latest.body)`; `addExample({ channel, kind: post.kind, title, body: latest.body, source: "owner_final" })`. Confirming twice does not add a second example.
- Routes (`routes.ts` inside owner layout): `index` → posts.tsx, `posts/new` → post-new.tsx, `posts/:id` → post-detail.tsx, `api/posts/:id/status` → `{ status, error }` JSON, `settings`. Outside layout: `login`, `logout`, `img/*`.
- `post-detail.tsx`:
  - `generating`: spinner + `초안을 만드는 중이에요 (1~2분). 화면을 닫아도 계속 만들어요.`; poll status every 2 s; on `ready`/`failed` revalidate.
  - `failed`: error text + `다시 시도` (calls `startGeneration`).
  - `ready`: tabs 블로그 / 인스타 / 당근 / 플레이스. Per tab: title input (blog, daangn), body textarea (auto-grow), hashtags input (instagram, space-separated), read-only grey box showing fixed text that will be appended, amber chips from `findUnsupportedNumbers(body, [memo, priceTable, footers])` and (if privateCustomer) `findPossibleNames`, buttons `복사` (copies `withFixedText(...)`, plus blog title on its own first line; toast `복사했어요`), `다시 쓰기` (opens one-line instruction input → `startGeneration` with channel), `확정` (saves edit if dirty, then `confirmDraft`; shows `확정됨 · 고친 정도 23%`). Blog tab also shows the numbered photo strip (thumbnails via `/img/...`, number badge, `photos[n].note` caption) with per-photo `저장` link for re-uploading to Naver.
  - Edits autosave on blur via `saveDraftEdit`.
- `posts.tsx`: `새 글` primary button + list (date, kind label, memo preview, status badge, ✓ count of confirmed channels).

- [ ] **Step 1: Tests**

```ts
it("editRatio", () => {
  expect(editRatio("a\nb\nc", "a\nb\nc")).toBe(0);
  expect(editRatio("a\nb\nc\nd", "a\nX\nc\nd")).toBe(0.25);
  expect(editRatio("a", "b\nc")).toBe(1);
});
it("saveDraftEdit makes a new version only when changed", async () => { /* v1 → same body → 1; new body → 2, source edit */ });
it("confirmDraft stores ratio against first ai version and adds one example", async () => {
  await saveDraftEdit(db, postId, "blog", { title: "t", body: EDITED }, T0);
  await confirmDraft(db, postId, "blog", T0); await confirmDraft(db, postId, "blog", T0);
  const ex = (await listExamples(db)).filter(e => e.source === "owner_final");
  expect(ex).toHaveLength(1); expect(ex[0].body).toBe(EDITED);
  expect((await getPost(db, postId))!.drafts.blog!.editRatio).toBe(editRatio(AI_BODY, EDITED));
});
```

- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement server functions, then the three routes**
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS
- [ ] **Step 5: Manual check** `npm run dev` with `.dev.vars` (real `ANTHROPIC_API_KEY`), Chrome devtools iPhone 12 Pro size: log in → 새 글 with 2 photos + memo `크리스마스 마카롱 주문 안내, 기본 세트 가격 그대로` + 가격표 붙이기 → wait → 4 tabs filled, blog shows `[사진 1]` `[사진 2]`, copy pastes body+prices+footer, 다시 쓰기 `더 짧게` gives v2 on that tab only, 확정 shows ratio. Lock-screen test: start generation, close tab, reopen after 2 min → ready.
- [ ] **Step 6: Commit** `feat: draft review, edit, copy, confirm`

---

### Task 9: Deploy, seed, backtest, README

**Files:**
- Create: `scripts/backtest.ts`
- Modify: `wrangler.jsonc` (real `database_id`, `PUBLIC_ORIGIN`), `README.md`

**Interfaces:**
- Consumes: Task 4 `private/examples.json`, Task 6 builders, Task 7 `makeClaudeCalls`.
- `scripts/backtest.ts --logNo <id>`: loads examples.json, removes that post from the example pool, memo = its title, kind = `classifyKind(title)`, zero photos, calls `drafts` with `ANTHROPIC_API_KEY` from env, writes `private/backtest/<logNo>.md` with `## 실제 글` / `## 에이전트 블로그 초안` / `## 숫자 경고` (from `findUnsupportedNumbers`) and token cost (`input*4 + output*20` / 1e6 USD).

- [ ] **Step 1: Create resources** (needs the user's Cloudflare login; ask before running if not already authorized): `npx wrangler d1 create promo-agent`, `npx wrangler r2 bucket create promo-photos`, put id in `wrangler.jsonc`; `npx wrangler d1 migrations apply promo-agent --remote`; `npx wrangler d1 execute promo-agent --remote --file private/seed-examples.sql`; `wrangler secret put` × 4.
- [ ] **Step 2: Deploy** `npm run deploy`; open the workers.dev URL on a phone-sized viewport; run the Task 8 manual check once against production.
- [ ] **Step 3: Settings** — enter the real footer and price table (copy from the owner's public blog posts; a transcription exists in the private cafe-manager notes `docs/ax-challenge/promo-voice-notes.md`) through the settings page, never git.
- [ ] **Step 4: Backtest** two posts (one case, one product); read the outputs; note voice gaps in `private/backtest/notes.md`.
- [ ] **Step 5: README** — update 지금 되는 것 / 아직 안 되는 것 to match what shipped; add 개발 section (`npm install`, `.dev.vars` names, `npm run dev`, `npx tsx scripts/import-blog.ts`, `npm test`); add one screenshot of the result screen with **dummy** content only.
- [ ] **Step 6: Commit** `chore: deploy config, backtest script, README for Day 4`
