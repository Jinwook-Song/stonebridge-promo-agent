# Photo auto-pick + draft-ready alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner adds up to 40 photos, AI picks ≤8 in blog order with reasons; she adjusts; a Kakao message tells her when a full draft is ready.

**Architecture:** Picking is one synchronous Claude call from a new owner-only resource route, fed browser-made 640 px thumbnails (no R2 for candidates). Draft-ready alert is a separate Workflow step after a successful full generation, deduped by an additive `posts.draft_notified_at` column.

**Tech Stack:** React Router 8 on Cloudflare Workers, D1 + drizzle, R2, Workflows, `@anthropic-ai/sdk` 0.100 structured outputs (zod), vitest workers pool.

**Spec:** `docs/superpowers/specs/2026-11-09-photo-pick-design.md`

## Global Constraints

- Worktree: `~/repository/mine/web/stonebridge-promo-agent/.claude/worktrees/photo-pick`, branch `feat/photo-pick`. `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH` before any npm/npx.
- Checks: `npm test` (vitest) and `npm run typecheck` must pass after every task.
- Model `claude-opus-5-5`, same fallback beta/`fallbacks: "default"` as existing calls (reuse `call()` in `app/promo/claude.server.ts`). Pick effort `low`.
- Limits: `MAX_PICK_CANDIDATES = 40`, `MAX_PHOTOS = 8` (unchanged), thumbnail 640 px long edge JPEG q 0.7, each thumbnail ≤ 300 KB server-side, memo ≤ `MAX_MEMO_CHARS` (500). Pick reason ≤ 20 Korean chars (prompt rule; server truncates to 40 chars as a guard).
- Client pick timeout 45 s (AbortController).
- UI copy is Korean, in the existing tone (해요체). Touch targets ≥ 44 px (`min-h-11`/`size-11`).
- Structured output schemas: only plain objects, strings, string arrays, integers (see comment at top of `app/promo/prompt.ts`).
- No real customer data in tests or fixtures. `private/` never committed.
- Migrations: additive only; generate with `npx drizzle-kit generate --name <name>`.
- Commits end with `Claude-Session: https://claude.ai/code/session_01KHcRieRu54FCbGTLVNDtiT`.

## Review Focus

1. **Picks with bad indices** (n out of range, duplicates, 0, more than 8) → server drops/caps; UI never shows a missing photo.
2. **AI pick returns while she already changed the selection or removed a photo** → apply picks only for candidates still present; a removed candidate's id is skipped.
3. **Pick request fails / times out / refusal** → Korean error, existing selection untouched, manual picking still works, submit still works.
4. **Generation retried or replayed by Workflows** → draft-ready Kakao message sent at most once per post; Kakao failure never marks generation failed.
5. **Rewrite or failed generation** → no draft-ready message.

---

### Task 1: Draft-ready alert (backend)

**Files:**
- Modify: `database/schema.ts` (posts: `draftNotifiedAt: text("draft_notified_at")`)
- Create: `drizzle/0003_draft_ready_alert.sql` (+ meta, via drizzle-kit)
- Modify: `app/kakao/alerts.server.ts` (settings key + message)
- Create: `app/kakao/draft-ready.server.ts`
- Modify: `app/promo/generate.server.ts` (`runGeneration` returns `Promise<boolean>`)
- Modify: `workers/generate-workflow.ts` (notify step)
- Test: `test/draft-ready.test.ts`, extend `test/generate.test.ts`, `test/kakao-alerts.test.ts`

**Interfaces:**
- Produces:
  - `AlertSettings.draftReadyEnabled: boolean` — key `alert_draft_ready_enabled`; **default true** (absent row → true; `"0"` → false). `saveAlertSettings(db, { draftReadyEnabled })` writes it.
  - `alertMessage("draft_ready", origin, { postId: number; memo: string })` → `{ text: "홍보글 초안이 준비됐어요\n" + first 30 chars of memo (code points, "…" appended if cut), url: `${origin}/posts/${postId}`, buttonTitle: "초안 보기" }`. Existing kinds keep their signature (third arg optional).
  - `notifyDraftReady(deps: ScheduledDeps, postId: number, now: Date): Promise<"not_configured" | "disabled" | "not_linked" | "not_ready" | "already_sent" | "sent" | "failed">` in `app/kakao/draft-ready.server.ts`. Order: cfg null → not_configured; disabled → disabled; no link → not_linked; claim `UPDATE posts SET draft_notified_at = now WHERE id = ? AND status = 'ready' AND draft_notified_at IS NULL RETURNING memo` (none → if post ready & notified → already_sent, else not_ready); then `sendToMe`. Send error → `console.error` + "failed" (claim kept: not retried). Never throws.
  - `runGeneration(...)`: returns `true` only when the final batch's posts update changed the row to `ready` (check via `.returning` or a follow-up select of status+workflowId); `false` on skip/failure. `runRewrite` unchanged.
  - Workflow: after the `generate` step, if `!channel && done` → `step.do("notify", { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" }, () => notifyDraftReady({ db, cfg: kakaoConfig(this.env), origin: this.env.PUBLIC_ORIGIN, fetch: (u, i) => fetch(u, i) }, postId, new Date()))`, result logged; wrapped in try/catch so it never rethrows. The `generate` step's callback must return the boolean (still small).

- [ ] **Step 1: Write failing tests** in `test/draft-ready.test.ts` (setup like `test/kakao-alerts.test.ts`: link row helper, `okFetch`):
  - `sends once for a ready post`: insert ready post (memo "구리 OO고 마카롱 40세트 리본 포장"), call twice → `["sent","already_sent"]`, fetch called once, sent body (form `template_object`) contains `홍보글 초안이 준비됐어요` and `/posts/<id>`, `draft_notified_at` set.
  - `skips a post that is not ready`: status `generating` → `"not_ready"`, fetch not called, column still null.
  - `respects the setting`: `saveAlertSettings(db,{draftReadyEnabled:false})` → `"disabled"`; with no settings row `getAlertSettings(db).draftReadyEnabled === true`.
  - `not_linked` / `not_configured` (cfg null) → no fetch.
  - `kakao failure is recorded, not thrown`: fetch returns 500 / `{code:-402}` → `"failed"`, console.error called, column stays set.
  - In `test/generate.test.ts`: `runGeneration` resolves `true` on success, `false` when the run no longer owns the post and `false` on a GenerationError.
  - In `test/kakao-alerts.test.ts`: `alertMessage("draft_ready", ORIGIN, { postId: 7, memo: "가".repeat(40) })` text = `"홍보글 초안이 준비됐어요\n" + "가".repeat(30) + "…"`, url `https://app.example/posts/7`; message text within `MEMO_TEXT_LIMIT`.
- [ ] **Step 2: Run** `npx vitest run test/draft-ready.test.ts test/generate.test.ts test/kakao-alerts.test.ts` → FAIL (missing exports).
- [ ] **Step 3: Implement** schema column, `npx drizzle-kit generate --name draft_ready_alert` (check SQL is a single `ALTER TABLE posts ADD draft_notified_at text`), alerts settings + message, `notifyDraftReady`, `runGeneration` boolean, Workflow step. Keep `beforeEach` cleanups in existing tests working (add the new settings key to the kakao-alerts cleanup list).
- [ ] **Step 4: Run** `npm test && npm run typecheck` → all pass.
- [ ] **Step 5: Commit** `feat: Kakao message when a full draft is ready`.

### Task 2: Draft-ready toggle in 설정

**Files:**
- Modify: `app/routes/settings.tsx`, `app/kakao/types.ts` (labels only)
- Test: extend `test/settings.test.ts` (or a new `test/settings-alerts.test.ts` if that file tests settings.server only — follow whatever exercises the settings action today; if none does, test `saveAlertSettings` round-trip only)

**Interfaces:**
- Consumes: `AlertSettings.draftReadyEnabled`, `saveAlertSettings` (Task 1).
- Produces: `setAlert` action accepts `kind=draft_ready`. Toggle label `초안 완성 알림`, description `초안이 다 만들어지면 카톡으로 알려 드려요`. Rendered first (above 발주 알림). `AlertToggle`'s `kind` prop type widens to `AlertKind | "draft_ready"`; a local `TOGGLE_LABELS` map holds the three labels (`ALERT_LABELS` stays for the alert-log list).
- [ ] **Step 1: Failing test** for the action/settings: posting `intent=setAlert, kind=draft_ready, enabled=0` stores `alert_draft_ready_enabled = "0"`; unknown kind still rejected as today.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → pass.
- [ ] **Step 5: Commit** `feat: settings toggle for the draft-ready alert`.

### Task 3: Photo pick (server)

**Files:**
- Create: `app/promo/photo-pick.server.ts`
- Modify: `app/promo/claude.server.ts` (add `pick` call + fake), `app/promo/types.ts` (`MAX_PICK_CANDIDATES = 40`, `MAX_THUMB_BYTES = 300 * 1024`)
- Create: `app/routes/api.photo-pick.ts`; Modify: `app/routes.ts` (inside owner layout: `route("api/photo-pick", "routes/api.photo-pick.ts")`)
- Test: `test/photo-pick.test.ts`

**Interfaces:**
- Produces:
  - `PhotoPickOutput = z.object({ picks: z.array(z.object({ n: z.number().int().describe(...), reason: z.string().describe(...) })) })` in `photo-pick.server.ts`.
  - `PickCall = (req: ModelRequest) => Promise<ModelResult<PhotoPickOutput>>`; `makeClaudeCalls(apiKey)` returns `{ drafts, rewrite, pick }`, `pick` uses `effort: "low"` (make effort a parameter of the internal `call`, drafts/rewrite stay `"high"`). Fake `pick` returns the first `min(8, N)` photos in order with reason `"테스트 사진"`.
  - `buildPickRequest(input: { memo: string; kind: PostKind; privateCustomer: boolean; thumbs: { media_type: "image/jpeg"|"image/png"|"image/webp"; data: string }[] }): ModelRequest` — system = pick rules (spec "Prompt rules"); user = for each i: text `사진 ${i+1}` then the image block (base64), then a final text with kind label, memo (or `(메모 없음)`), and the 개인 고객 line when set.
  - `cleanPicks(raw: PhotoPickOutput, count: number): { n: number; reason: string }[]` — keeps 1 ≤ n ≤ count, first occurrence only, max 8, reason trimmed and cut to 40 chars.
  - `pickPhotos(call: PickCall, input): Promise<{ picks: {n; reason}[]; inputTokens: number; outputTokens: number }>`; logs `console.info("photo pick", { count, ms, inputTokens, outputTokens })`.
  - Route action `POST /api/photo-pick` (multipart: `memo`, `kind`, `privateCustomer=on`, repeated `thumbs` files) → `Response.json({ picks })` 200, or `Response.json({ error })` 400 for validation (count < 2 or > 40, wrong type, > 300 KB, memo too long, bad kind) and 502 for model failures (`GenerationError` message, `permanentApiFailure` message, else `"사진 고르기에 실패했어요. 직접 골라 주세요."`). Uses `FAKE_CLAUDE` like `makeGenDeps`.
- [ ] **Step 1: Failing tests** (`test/photo-pick.test.ts`):
  - `cleanPicks drops out-of-range, duplicate and extra picks`: input n = [3, 0, 3, 11, 1, 2, 4, 5, 6, 7, 8, 9] with count 10 → n = [3,1,2,4,5,6,7,8].
  - `cleanPicks trims and caps reasons` (50-char reason → 40).
  - `buildPickRequest labels every photo in order`: 3 thumbs → user blocks text `사진 1`, image, text `사진 2`, image, text `사진 3`, image, final text containing memo; empty memo → `(메모 없음)`; privateCustomer → final text mentions 얼굴.
  - `route rejects 1 photo and 41 photos with 400` and `rejects a 301 KB thumb`.
  - `route returns cleaned picks` with a stub: call the action with `FAKE_CLAUDE`-equivalent — inject via exported `handlePhotoPick(request, deps: { pick: PickCall })` used by the route, so the test passes a stub returning n = [2, 2, 1]; expect `{ picks: [{n:2,...},{n:1,...}] }`.
  - `route maps a GenerationError("refusal") to 502 with its Korean message`.
- [ ] **Step 2: Run** `npx vitest run test/photo-pick.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` → pass.
- [ ] **Step 5: Commit** `feat: AI photo pick endpoint`.

### Task 4: Photo pick (new-post form)

**Files:**
- Create: `app/promo/photo-selection.ts` (pure state helpers)
- Modify: `app/routes/post-new.tsx`, `app/promo/resize-image.client.ts` (no API change; reuse `resizeToJpeg(file, 640, 0.7)`)
- Test: `test/photo-selection.test.ts`

**Interfaces:**
- Consumes: `POST /api/photo-pick` contract (Task 3), `MAX_PICK_CANDIDATES`, `MAX_PHOTOS`.
- Produces (`photo-selection.ts`, no React/DOM imports):
  - `type Selection = { order: number[]; reasons: Record<number, string> }` (candidate ids).
  - `addCandidates(sel, ids: number[], max = MAX_PHOTOS): Selection` — appends ids while `order.length < max`.
  - `toggle(sel, id, max = MAX_PHOTOS): Selection` — selected → removed (reason dropped); unselected → appended if room, else unchanged.
  - `removeCandidate(sel, id): Selection`.
  - `applyPicks(sel, picks: {n:number; reason:string}[], sentIds: number[], presentIds: Set<number>): Selection` — maps n → `sentIds[n-1]`, skips ids not in `presentIds`, replaces order and reasons.
- UI behavior (post-new.tsx):
  - Candidates `{ id, file, thumb: Blob, preview: string }`; preview = object URL of the **thumbnail**. Thumbnails made sequentially on add; while making, show `사진 준비 중… (k/N)` and disable submit/AI button. Thumb failure for one file → skip it with the existing error copy.
  - Grid shows all candidates; selected ones get a numbered badge (position+1) and their reason (1 line, `line-clamp-1`, text-xs) under the tile; unselected tiles dimmed (`opacity-50`). Tap tile = toggle; ✕ button = remove candidate. Counter `선택 {order.length}/8 · 올린 사진 {N}/40`.
  - Add tile shown while N < 40. Over 40 → `사진은 40장까지 올릴 수 있어요.`
  - `AI로 고르기` button (outline, full width, `min-h-11`) when N ≥ 2; hint under it `메모를 먼저 쓰면 더 잘 골라요.` while the memo is empty. While picking: `AI가 고르는 중…` + disabled; 45 s abort → `시간이 너무 걸려요. 다시 시도하거나 직접 골라 주세요.`; error JSON → its `error`. Memo read from the textarea at click time (controlled state or ref).
  - Submit uploads `order` candidates' original files resized to 1600 px exactly as today (same field names), so `createPost` is unchanged. Submit blocked with `사진을 8장 이하로 골라 주세요.` can't happen by construction; keep `MAX_PHOTOS` check server-side.
  - Revoke every preview URL on remove and unmount.
- [ ] **Step 1: Failing tests** for the four helpers, including: `addCandidates` stops at 8; `toggle` on a full selection is a no-op; `applyPicks` with picks n=[3,1] and sentIds [10,11,12] where 12 was removed → order [10]; reasons replaced, not merged.
- [ ] **Step 2: Run** `npx vitest run test/photo-selection.test.ts` → FAIL.
- [ ] **Step 3: Implement helpers + UI.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build` → pass.
- [ ] **Step 5: Manual check** in `npm run dev` with `FAKE_CLAUDE=1` (see `.dev.vars`): add 12 images → 8 selected; AI button → fake picks applied; toggle; submit creates a post with the chosen order. Note results in the commit body.
- [ ] **Step 6: Commit** `feat: new-post form takes 40 photos and lets AI pick 8`.

### Task 5: Live check + ship

(Controller does this, not a subagent.)
- [ ] Merge `feat/photo-pick` into main (PR), apply `0003` remotely (`npx wrangler d1 migrations apply promo-agent --remote`), `npm run deploy`, note Version ID.
- [ ] Live pick on real photos from the owner's public blog (20–30 images from 2–3 posts mixed, as thumbnails) via a small script hitting `pickPhotos` with the local backtest key: record latency, tokens, cost, and whether the picks are sensible. If picks are poor at `low`, retry at `medium` and pick the setting.
- [ ] Trigger one live generation (fake or real post) and confirm the draft-ready message arrives (진욱's Kakao) and `draft_notified_at` is set.
- [ ] Update README feature list and `docs/deploy-checklist.md` (migration 0003).
