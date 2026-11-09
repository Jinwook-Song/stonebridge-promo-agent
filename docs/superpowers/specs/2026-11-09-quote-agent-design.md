# Catering quote agent (스톤테이블) — design (2026-11-09)

> **This repo is public.** Real unit prices, the owner's past quotes, customer details and the
> competitor research data stay out of git. They live in D1 (entered through the app or seeded by
> a script in the gitignored `private/` folder). This document names competitors only generically.

## 1. Why

The owner runs a dessert/다과 catering side business, **스톤테이블**, separate from the cafe
(business registration not done yet). Inquiries come by phone. She replies by email with an
Excel quote and usually goes through about 3 revisions. She has no price list.

What the interview showed (answers f01, f08, f11, f12):

- The Excel step itself takes **~20 min**. The rest of the **1–6 h** per quote goes to research:
  "다른 업체는 어떤 메뉴를 어떤 비용으로 납품했는지 비교분석… 그 업체가 지난번엔 어디를 했는지".
- What she most wants from competitor research: **price range and menu composition**. Main
  reference: "드호".
- Discounts are shown as **SVC**: the line keeps its list price and the amount says SVC (free).
  She does this "담당자가 네고를 원할 때나 예산이 빠듯할 때".
- Quotes will go out under the 스톤테이블 name once the business is registered.

Competitor research done 2026-11-09 (raw data in `private/competitor-research-2026-11-09/`):

- **Who catered where, when, and with which menu** is public for most caterers. Naver blog
  titles and posts name the venue or client and the date, often with a quantity. Posts appear
  almost daily. Roughly 80% of this can be automated (RSS + post pages, no login).
- **Published price lists** exist for larger agencies and coffee/다과 businesses, as plain-HTML
  pages with exact per-person prices, minimums and fees. Pages contradict each other (two prices
  for the same package; one subdomain shows numbers, another shows "상담").
- **Small local caterers at her tier publish no prices.** What a given event actually cost is
  almost never public. Her own past quotes are the only price data at her tier.
- Blocked without a browser login: Instagram posts, 숨고, smart-store pages (HTTP 429/403).

So the design moves research out of quote time. A **daily watch** collects competitor events and
published prices into D1. At quote time the agent **looks up** that log. (The playback the
developer approved had research running at quote time. Changing it was my call, based on the
findings above.)

## 2. Goals

1. **Quote draft from a pasted inquiry.** She pastes a call memo or an inquiry email and gets:
   - the extracted event facts (date, headcount, venue, event type, budget, requests), each
     editable, plus questions for anything missing;
   - quote lines priced from her **price sheet**, with amounts computed in code;
   - a comparison panel with published prices and recent similar events from the watch log,
     each with source link and date;
   - a reply-email draft;
   - a **.xlsx** download in the 스톤테이블 template.
2. **Revisions.** She pastes the customer's change request and gets v2, v3… with a short "what
   changed" list. Every version is kept. She can toggle SVC on any line and edit qty, price
   and text by hand.
3. **Price sheet (가격 기준표).** A settings table of items (1인 packages and 1회 fixed fees)
   that she edits. It is seeded from the one real quote we have. It later feeds the 스톤테이블
   website price list (separate project).
4. **Competitor watch.** A daily cron reads a watch list she can edit (blogs via RSS, price
   pages). It stores:
   - **events**: who, where, when, menu, quantity, price if stated;
   - **published prices**: package, per-person price, minimum, fees.
   Every row carries `source_url` and `seen_at`. A "경쟁 업체" page lists both, filterable by
   competitor.
5. **Lead list as a side effect.** The event log shows which institutions buy catering and from
   whom. For example, one hospital in 구리 appears in two competitors' posts. The page can filter
   events by client/venue. This is useful even with few inquiries.
6. **Her own quotes are price data.** Each quote can be marked 보냄 / 성사 / 무산. She can import
   past quote Excels, which are parsed into lines she confirms and stored as imported quotes. The
   comparison panel shows her own past quotes for similar events first.

## 3. Non-goals

- Sending anything to customers. She copies the email and attaches the Excel herself.
- Guessing a competitor's unpublished price for an event.
- Instagram, 숨고 and smart-store scraping, and OCR of image-only price cards (v1).
- A per-quote live web search (v1). This could become a "더 찾아보기" button later, using
  `web_search_20260209` with `allowed_domains`.
- Kakao alerts for quotes or competitor news (v1). A weekly digest is a possible later add.
- Setting-reference photos inside the Excel (v1). Her current template has a photo area; v1 leaves
  it out.
- Cafe (스톤브릿지) features. This is the catering business only.

## 4. Anti-goals (works, but still a failure)

- The AI invents a unit price, a fee, or a competitor fact. Prices come only from the price sheet
  or her own edits. Competitor numbers come only from stored rows with a source link.
- A competitor number shown without its source and date.
- Totals that don't add up. Amounts, subtotal and VAT come from code, and the Excel holds live
  formulas.
- Her customer data or prices in the public repo.
- The quote flow breaks when the watch is empty or failing. The comparison panel just says
  there's nothing yet.

## 5. Constraints

- Same app as the promo agent: Cloudflare Worker `stonebridge-promo` (React Router, D1, R2,
  Workflows), same owner login, Claude API with `claude-opus-5-5` and the same refusal-fallback
  setup as generation.
- Repo is public until the challenge ends (11/16) and goes private after. Treat it as public.
- Deploy order: remote D1 migrations **before** `npm run deploy` (docs/deploy-checklist.md).
- She uses a phone for most things, but quotes and Excel are likely done on a PC. Every page must
  work on both (builder's call; not confirmed).
- **Unverified runtime assumptions.** These are the first task of the plan:
  1. Fetching Naver blog RSS and `PostView` pages from a deployed Worker. Naver may block
     Cloudflare egress IPs; the research fetched from a local machine. Fallback: pass the URLs to
     Claude with the server-side `web_fetch_20260209` tool.
  2. Decoding cp949/EUC-KR pages (one competitor site) with `TextDecoder("euc-kr")` in workerd.
  3. Generating (and, for import, reading) .xlsx inside the Worker: no fs, bundle size limits.
     A SheetJS-class library is expected to work; stream/fs-based ones may not.

## 6. Decided

### 6.1 Screens

- New top-level menu **견적** next to 홍보글 (owner layout).
- **견적 목록**: customer/event, date, headcount, total, status (초안/보냄/성사/무산), version.
- **새 견적**: one large textarea ("통화 메모나 문의 메일을 붙여 넣으세요") and a 만들기 button.
- **견적 상세** (one version at a time, with a version switcher):
  1. 행사 정보: editable fields, plus "확인할 것" questions the AI raised (e.g. 예산, 음료 여부).
  2. 견적 표: lines with 항목 · 내용 · 수량 · 단가 · 금액 · 메뉴 · 비고. Each line has an SVC
     toggle and can be edited, deleted, or added (pick from price sheet or free line). Lines
     whose item is not on the price sheet show an empty price and a "가격 기준표에 없음" mark.
     Subtotal and VAT 10% total are live.
  3. 비교: her own similar past quotes first, then competitor published packages near the same
     per-person level, then recent competitor events of the same type. Every row links to its
     source and shows `seen_at`. The AI writes 2–3 sentences of takeaway, citing row ids only.
  4. 회신 메일: subject + body with a copy button.
  5. Buttons: 엑셀 받기, 수정 요청 붙여넣기 (→ next version), 상태 바꾸기.
  6. **Per-quote sender and VAT** (my call): 발신 block and a "VAT 10% 별도" switch are stored
     on each quote, defaulting from settings. Jobs referred through 드호/the academy can go out
     under another name, and VAT/사업자번호 can be turned off until 스톤테이블 is registered.
     With VAT off, the total row is just 공급금액 and the Excel has no ×1.1 formula.
- **경쟁 업체** page with tabs:
  - 소식 (event log, newest first, filter by competitor / client text);
  - 가격 (published packages, latest per package, with history);
  - 감시 목록 (watch-list editor: name, kind `rss` | `page`, URL, memo, on/off, last run result).
- **설정 → 견적**:
  - price sheet editor;
  - sender block (업체명 default "스톤테이블", 담당자, 전화, 메일, 결제, 사업자번호 — empty until
    registration);
  - intro paragraph;
  - fixed "기본 제공 사항" lines.
  Fixed text is pasted by code, never written by the AI (same rule as the promo footers).

### 6.2 Quote generation

- One Claude call per version, run in a Cloudflare Workflow like post generation (owner can leave
  the page). Structured output, roughly:
  `{ event: {...fields, missing: string[]}, lines: [{ itemId|null, label, content, qty, menu, note }], comparison: { notes: string, citedIds: string[] }, email: { subject, body }, changes?: string[] }`.
- Input: pasted text (+ previous version and change request for v2+), the price sheet (ids,
  names, units, prices), the comparison candidates (pre-selected by code: her quotes and
  competitor rows, filtered by event type keyword and per-person band, capped at ~30), fixed
  rules. Prompt rules:
  - Use only price-sheet `itemId`s for prices.
  - Never output amounts. Code computes `qty × unit price`, the subtotal, and ×1.1.
  - Suggest SVC only as a note; she decides.
  - Ask instead of assuming when headcount or date is missing.
  - The email is polite and short. Don't invent policies (same rule as promo drafts).
- Code validates: unknown `itemId` → null (price blank); `citedIds` filtered to the ids actually
  sent.
- **Stored line** (what `linesJson` holds, builder's call made explicit): `{ itemId|null, label,
  content, qty, unitPrice|null, priceSource: 'sheet' | 'hand' | 'imported', svc: boolean, menu,
  note }`. `unitPrice` is copied from the sheet when the version is created (later sheet edits
  don't rewrite old quotes).
- **Hand edits and revisions** (my call): she edits the current version in place, and those
  edits are saved straight away. A version is never regenerated in place. "수정 요청 붙여넣기"
  creates v(n+1). The model gets the previous lines with their prices and SVC flags. For each
  line it outputs `prevIndex` (the line it keeps or changes) or null for a new line. Code then
  copies `unitPrice`/`priceSource`/`svc` from the referenced line whenever that line had a hand
  price or SVC, so negotiated prices and SVC choices survive revisions. The model may suggest
  dropping SVC only as a note. The "what changed" list is computed by code from the line diff,
  plus the model's one-line summary of the request.
- Effort: start at `medium`; the builder measures time and cost on 3–4 test inquiries.

### 6.3 Excel

- Layout follows her current quote (notes in `private/`, not in git):
  1. title;
  2. 수신 block (고객사, 담당자, 연락처, 행사 성격, 장소, 특이사항) and 발신 block from settings;
  3. intro paragraph;
  4. line table;
  5. 공급금액 / 합계(VAT 10% 포함) / 사업자번호;
  6. 기본 제공 사항.
- Live formulas: `금액 = 수량 × 단가`, `공급금액 = SUM`, `합계 = 공급금액 × 1.1`. SVC lines keep
  the 단가 and show "SVC" in 금액 (excluded from the sum).
- File name: `스톤테이블_견적서_<고객>_<YYMMDD>_v<n>.xlsx`.

### 6.4 Competitor watch

- Cron once a day (night KST; add to `triggers.crons` and the CRONS list in code).
- `rss` sources: read the feed and take items newer than the source's last seen item (cap 10 per
  source per run). For each new post, fetch the post text and run one low-effort Claude
  extraction:
  - fields: `{ isEvent, date, client, venue, eventType, menu[], quantity, headcount, price, notes }`;
  - store only if `isEvent`; unknown fields stay null and are never guessed.
- `page` sources (price pages): fetch weekly. If the page text hash changed, extract
  `{ packages: [{ name, perPerson, items[], minimum, fees[] }] }`. Store a new price row only
  when a value changed, so history stays visible.
- Per-run cap on Claude calls (default 30) and a per-source last-run status/error shown on the
  감시 목록 tab. Failures never block quotes.
- Seed watch list (entered via the app or the private seed script, not committed): 드호 plus
  4–5 peers found in the research (blog RSS + price pages), owner to confirm.

### 6.5 Importing past quotes

- Upload .xlsx. The server converts the cells to text, and the same extraction as 6.2 runs with
  "this is a finished quote, copy it, don't price it": lines keep the prices written in the
  file.
- She confirms. The quote is stored with `source = imported` and status 성사/무산/보냄 as she
  marks it.

### 6.6 Data (D1, new tables)

- `price_items`: id, kind (`per_person` | `per_event`), name, content, unit, unitPrice (nullable,
  공급가 = VAT 별도, as in her quote), minimumQty (nullable), menu, note, needsConfirm, enabled,
  sort. Headcount tiers and distance-based fees are out of v1 (my call). She adjusts per quote,
  and the note field holds the rule in words. `needsConfirm` marks seeded prices she hasn't
  confirmed yet; the editor shows them highlighted.
- `quotes`: id, customer (name/contact/email), event fields, senderJson, vatIncluded, status,
  source (`app` | `imported`), createdAt.
- `quote_versions`: quoteId, version, inputText, changeRequest, eventJson, linesJson,
  comparisonJson, emailSubject, emailBody, workflow fields (same claim/stale pattern as posts),
  tokens, createdAt.
- `watch_sources`: id, name, kind, url, memo, enabled, lastSeenKey, lastRunAt, lastStatus,
  lastError, contentHash.
- `competitor_events`: id, sourceId, sourceUrl (unique), date, client, venue, eventType,
  menuJson, quantity, headcount, price, seenAt.
- `competitor_prices`: id, sourceId, sourceUrl, packageName, perPerson, itemsJson, minimum,
  feesJson, seenAt.
- Settings keys for the sender block, intro, fixed lines.

### 6.7 Rollout order (one plan, three shippable phases)

1. Risk spike (§5 items 1–3) on a deployed preview.
2. Price sheet + settings + quote generation + Excel + revisions. Usable on its own.
3. Competitor watch + comparison panel + 경쟁 업체 page.
4. Past-quote import.

## 7. Cost estimate (to be measured)

- Quote version: one Opus 5.5 call, a few thousand input tokens + ~2k output → about
  $0.05–0.10.
- Watch: ~10 sources, ~5–15 new posts/day at low effort, ~3k tokens each → roughly $0.1–0.3/day
  (≈ $3–9/month). The per-run cap bounds it. The builder records real numbers in the ledger.

## 8. Left to the builder

- Excel library choice (within the §5 constraint) and exact cell styling.
- How comparison candidates are pre-selected (keyword/band heuristics).
- Prompt wording, effort levels after measurement, Workflow step split.
- UI details within the screens above; reuse the promo app's components and patterns.

## 9. Open questions for the owner (not blocking v1)

- 드호: her quote went out with 드호 as 발신처 (academy-referred job). The 드호 we found
  (강남 premium agency) publishes 25,000원+/인 packages, far above her level. Is that the same
  드호, and is it a partner who passes jobs, a competitor, or both?
- Which peers should be on the watch list (we'll propose 4–5)?
- A past quote email she sent, so the reply draft matches her tone.
- Are the seeded prices hers? The only quote went out under 드호's name. If 드호 added a
  margin, 8,500원/인 is not her level. Seeded rows are marked `needsConfirm` until she checks
  them.
- Does she price by headcount tiers, minimum order or distance? v1 leaves these to per-quote
  edits.
