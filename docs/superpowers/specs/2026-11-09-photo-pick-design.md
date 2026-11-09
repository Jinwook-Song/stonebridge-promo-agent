# Photo auto-pick + draft-ready Kakao alert — design (2026-11-09)

## Why

Owner interview (round 1–2): picking photos is the slowest part of writing a promo post. She
picks ~8 photos that "carry the content" (내용 전달되는 것) out of a phone gallery full of near
duplicates. Today the new-post form takes at most 8 photos, so she has to do all the picking
before she starts. Second, a full generation takes ~30 s – several minutes; if her phone locks
or she leaves the page, nothing tells her the draft is ready.

Developer said "그냥 해" (skip questions) on 2026-11-09, so every product call below is the
builder's call, marked as such where it matters.

## Goals

1. On the new-post form she can add up to **40** photos. A button **"AI로 고르기"** asks Claude
   to choose up to **8** that best carry the memo, put them in story order for the blog
   (`[사진 1]`…), and say in a few words why each was chosen.
2. She can override everything: tap a photo to add/remove it from the selection (added photos go
   to the end), and the badges show the order. Only selected photos are uploaded.
3. Without the AI button, the form still works as today (≤8 photos, all selected).
4. When a full generation finishes (`ready`), send a Kakao 나에게 보내기 message
   "홍보글 초안이 준비됐어요" with a button to the post. Toggle in 설정 → 카톡 알림.

## Non-goals

- No server-side storage of the 40 candidates. Only the chosen ≤8 are uploaded, as today.
- No Kakao alert for single-channel rewrites (she starts those from the result page and is
  watching), nor for failures (v1; failure is visible on the page).
- No drag-and-drop reordering in v1 (remove + re-add changes order).
- No auto-posting, no change to the generation prompt.

## Anti-goals

- Picking must never block posting: if the AI pick fails, she still picks by hand.
- Must not make the phone choke: 40 full-size object-URL previews can crash iOS Safari. Previews
  use the small thumbnails, not the originals.
- Must not invent facts: reasons are short visual descriptions only, never prices/claims.

## How

### Photo pick (synchronous, no Workflow)

- Client: on add, each file is decoded once into a **thumbnail** (640 px long edge, JPEG q≈0.7,
  ~40–80 KB) via the existing `resizeToJpeg(file, 640, 0.7)`. Thumbnail is the grid preview and
  the AI input. The original `File` is kept for the final 1600 px upload. Thumbnails are made
  sequentially to bound memory.
- Selection state: ordered list of candidate ids. Adding photos appends them to the selection
  while it has < 8; beyond that they are added unselected. Badge = position in selection.
- "AI로 고르기" is shown when there are ≥ 2 candidates. It posts the thumbnails + memo + kind
  (multipart) to a new owner-only resource route `POST /api/photo-pick`. Memo may be empty
  (hint text: 메모를 먼저 쓰면 더 잘 골라요).
- Server (`app/promo/photo-pick.server.ts`): validates (2–40 images, JPEG/PNG/WEBP, each ≤ 300 KB,
  memo ≤ 500 chars), sends them base64 inline to Claude with numbered text labels
  (`사진 1` … `사진 N`), structured output:
  `{ picks: [{ n: int, reason: string }] }` (1–8 picks, in blog order).
  Server drops out-of-range / duplicate `n`, caps at 8. Returns `{ picks }` or `{ error }`.
- Model: `claude-opus-5-5` (project default; same fallback beta as generation), **effort
  `low`** to keep the wait short (builder's call — measure; raise to medium if the picks are
  poor). Non-streaming is fine for the small output, but use the same stream+finalMessage
  helper for consistency. Refusal / bad output → Korean error, form falls back to manual.
- Prompt rules: pick photos that show what the memo is about (the product, packaging, quantity,
  delivery/setting); among near-duplicates keep the sharpest, best-lit one; skip blurry, dark,
  screenshots, photos with faces of private customers when 개인 고객 is checked (builder's
  call); order = overview first, then details, then packaging/delivery; fewer than 8 is fine if
  the rest are duplicates. Reason: ≤ 20 Korean chars, what is visible.
- Cost (estimate): 640×480 ≈ 410 image tokens → 40 photos ≈ 16k input tokens ≈ $0.07 at
  $4/MTok plus small output; measure on live.
- Picks apply immediately: selection := AI order; the reason shows as one line under each
  selected thumbnail. She can tap to change.

### Draft-ready alert

- New nullable column `posts.draft_notified_at` (additive migration; no `alert_log` rebuild,
  `ALERT_KINDS` / `CRONS` unchanged). Dedupe: `UPDATE posts SET draft_notified_at = now WHERE
  id = ? AND draft_notified_at IS NULL RETURNING id`; zero rows → skip. Sent at most once per
  post (the first full generation that reaches `ready`; a later 다시 만들기 does not ping again —
  builder's call, she is on the page then).
- Setting `alert_draft_ready_enabled`, **default on** (builder's call: she starts the
  generation herself, so it is not an unsolicited ping; she can turn it off). Until the owner
  links her Kakao, it reaches 진욱's account (kakao_link row 1).
- `runGeneration` returns whether it finished the post (`ready`). The Workflow then runs a
  separate `step.do("notify", { retries: { limit: 0 } })` that calls `notifyDraftReady`, which
  records failures in `console.error` and never throws (a Kakao problem never fails the
  generation). Claim the column before sending (a failed send is not retried: same rule as the
  발주 alert).
- Message: "홍보글 초안이 준비됐어요\n{memo first 30 chars}" + button "초안 보기" →
  `/posts/{id}`. Skipped silently when Kakao is not configured / not linked / disabled.

## Constraints

- Cloudflare Workers request body limit is fine (40 × 80 KB ≈ 3.2 MB); Claude request limit
  32 MB. Claude allows 600 images per request; with > 20 images every image must be ≤ 3000 px
  per side (verified on the vision docs 2026-11-09) — 640 px thumbnails are well inside.
- The pick is a synchronous request: the client aborts after 45 s (AbortController) and shows
  "다시 시도"; manual picking stays enabled throughout.
- Existing tests (vitest + workers pool) must keep passing; new logic gets unit tests with fake
  Claude/fetch. Typecheck must pass. Deploy needs Node ≥ 22.22 (`nvm use 24`).

## Left to the builder

UI copy details, exact component split, test shape, whether `/api/photo-pick` is a route action
or a resource route file.
