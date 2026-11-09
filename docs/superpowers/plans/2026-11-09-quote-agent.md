# 케이터링 견적 에이전트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**목표:** 사장님이 문의 메모를 붙여 넣으면 가격 기준표로 매긴 견적 초안·비교·회신 메일·엑셀이 나오고, 수정 버전을 이어 가며, 매일 모은 경쟁 업체 기록을 비교에 쓴다.

**구조:** 홍보글 앱(`stonebridge-promo`)에 `app/quote/`(견적)와 `app/watch/`(경쟁 업체 감시)를 더한다. 견적 한 버전 = Claude 호출 한 번, 홍보글처럼 Workflow(`QUOTE_GENERATE`)에서 돌린다. 금액·합계·수정 병합은 순수 함수(`app/quote/lines.ts`)가 한다. 감시는 크론이 Workflow(`WATCH`)를 시작하고, 출처마다 step 하나다.

**기술:** React Router 8 on Cloudflare Workers, D1 + drizzle, Workflows, cron triggers, `@anthropic-ai/sdk` 0.100 structured outputs (zod), vitest workers pool. 엑셀 라이브러리는 Task 1에서 정한다.

**설계 문서:** `docs/superpowers/specs/2026-11-09-quote-agent-design.md` (구현자는 이 계획과 같이 읽는다)

## 전체 제약

- 작업 위치: `~/repository/mine/web/stonebridge-promo-agent/.claude/worktrees/quote-impl`, 브랜치 `feat/quote-agent`. `design/quote-agent`에서 갈라 만든다. `private` → `../design/private` 심볼릭 링크. 처음에 `npm install`.
- npm/npx 앞에 `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH`. 배포에는 Node 22.22 이상이 필요하다.
- 작업이 끝날 때마다 `npm test`와 `npm run typecheck`가 통과해야 한다. 시작 시점 테스트는 322개다.
- 모델은 `claude-opus-5-5`, fallback 설정은 기존과 같다(`app/promo/claude.server.ts`의 `call()`을 재사용). effort는 견적 `medium`, 가져오기와 감시 추출 `low`.
- 구조화된 출력 스키마는 평범한 객체, 문자열, 문자열 배열, 정수, boolean, nullable만 쓴다(`app/promo/prompt.ts` 맨 위 주석 참고). min/max/regex는 쓰지 않는다.
- 금액은 원 단위 정수다. VAT = `Math.round(공급금액 × 0.1)`. 엑셀은 `=ROUND(공급금액*1.1,0)`.
- 화면 문구는 한국어 해요체. 누르는 곳은 44px 이상(`min-h-11`).
- **공개 저장소**다. 실제 단가, 견적, 손님 정보, 경쟁 업체 이름·URL은 커밋하지 않는다. 테스트와 픽스처는 만든 가짜 데이터만 쓴다. `private/`는 절대 커밋하지 않는다.
- 마이그레이션은 추가만 한다. `npx drizzle-kit generate --name <name>`으로 만든다. 배포할 때는 원격 마이그레이션을 **먼저** 적용하고 `npm run deploy`(docs/deploy-checklist.md).
- 코드 주석과 식별자는 기존처럼 영어로 쓴다.
- 커밋 메시지 끝: `Claude-Session: https://claude.ai/code/session_01KHcRieRu54FCbGTLVNDtiT`

## 리뷰 초점

1. **수정 버전에서 모델이 이상한 `prevIndex`를 낸다**(범위 밖, 중복, `itemId`가 바뀜). 직접 고친 단가와 SVC가 조용히 사라지거나 두 줄로 복사되면 안 된다. 잘못된 참조는 새 줄로 다룬다. → Task 3 테스트
2. **단가 없는 줄**(가격 기준표에 없음). 합계에서 빠지고, 화면과 엑셀에 "단가 없음"이 보여야 한다. 0원으로 끼어 합계가 맞는 척하면 안 된다. → Task 3, Task 7 테스트
3. **감시 출처 하나가 망가진다**(429, HTML 오류 페이지, EUC-KR, 형식이 바뀐 RSS). 그 출처에만 오류가 기록되고 다른 출처는 계속 돌며, 쓰레기 줄이 저장되지 않는다. → Task 9 테스트
4. **만드는 중에 만들기나 수정 요청을 두 번 누른다.** 버전은 하나만 생긴다(`BUSY`). → Task 5 테스트
5. **엑셀 파일 이름에 쓰는 고객 이름**에 공백·`/`·따옴표가 있거나 비어 있다. `Content-Disposition`이 안전해야 하고, 비면 "고객"을 쓴다. → Task 7 테스트

---

### Task 1: 위험 확인 (버리는 Worker)

설계 §5의 확인 안 된 가정 세 가지를 실제 Cloudflare에서 확인하고 결정을 남긴다. 코드는 `spike/`에만 두고, 결과 문서만 남긴 뒤 지운다.

**Files:**
- Create (임시): `spike/wrangler.jsonc` (name `stonebridge-spike`, compatibility_date는 본 앱과 같게, flags `nodejs_compat`), `spike/worker.ts`
- Create: `docs/quote-spike.md` (결과. 경쟁 업체 이름과 URL은 쓰지 않는다)
- Create: `private/quote-spike-ledger.md` (실제로 쓴 URL과 원본 응답 요약)

- [ ] **Step 1:** `spike/worker.ts`에 `GET /?t=<test>`를 만든다.
  - `rss`: `https://rss.blog.naver.com/stone_bridge_.xml`(사장님 블로그, 공개)을 fetch하고 status, content-type, item 수를 낸다.
  - `post`: `https://m.blog.naver.com/PostView.naver?blogId=stone_bridge_&logNo=<RSS 첫 글>`의 status와 `se-text-paragraph` 개수를 낸다.
  - `euckr`: `?url=`로 받은 페이지를 fetch해 `new TextDecoder("euc-kr")`로 디코드하고 앞 200자를 낸다.
  - `xlsx`: 후보 라이브러리로 병합 셀, 굵은 글씨, 테두리, 수식 `=C2*D2`가 있는 시트를 만들어 내려 주고, 같은 바이트를 다시 읽어 셀 값과 수식을 JSON으로 낸다.
- [ ] **Step 2:** 엑셀 라이브러리 후보 순서:
  1. `exceljs`: 스타일과 수식이 되고 `nodejs_compat`가 필요하다.
  2. SheetJS CE(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`): 병합과 수식은 되지만 스타일은 안 된다.
  3. `fflate`로 OOXML을 직접 쓴다.
  첫 번째로 workerd에서 쓰기와 읽기가 모두 되는 것을 고른다. 번들 크기(`wrangler deploy --dry-run --outdir`)도 적는다.
- [ ] **Step 3:** `cd spike && npx wrangler deploy`로 배포하고, 네 테스트를 `curl`로 부른다. EUC-KR 테스트 URL은 `private/competitor-research-2026-11-09/`의 cp949 사이트를 쓴다.
- [ ] **Step 4:** `docs/quote-spike.md`에 결정 세 가지를 쓴다.
  - (a) **네이버 가져오기 방식**: `direct`(Worker fetch) 또는 `claude_web_fetch`(Claude `web_fetch_20260209`). 막히면 상태 코드도 적는다.
  - (b) **EUC-KR 디코드**: 되는지.
  - (c) **엑셀 라이브러리**: 이름, 버전, 필요한 compatibility flag, 번들 증가량.
  `nodejs_compat`가 필요하면 본 앱 `wrangler.jsonc`의 flags를 `["nodejs_compat"]`로 바꾼다. `nodejs_als`를 포함하므로 기존 테스트가 통과하는지 확인한다.
- [ ] **Step 5:** `npx wrangler delete --name stonebridge-spike`로 지우고 `spike/`도 지운다. 커밋은 `docs/quote-spike.md`(와 바뀐 경우 `wrangler.jsonc`)만 한다.

### Task 2: 데이터 표와 타입

**Files:**
- Create: `app/quote/types.ts`, `app/watch/types.ts`
- Modify: `database/schema.ts`
- Create: `drizzle/0004_quote_agent.sql` (+ meta)
- Test: `test/schema.test.ts`에 추가

**Interfaces:**
- Produces (`app/quote/types.ts`):
  - `PRICE_KINDS = ["per_person", "per_event"]`
  - `PRICE_SOURCES = ["sheet", "hand", "imported"]`
  - `QUOTE_STATUSES = ["draft", "sent", "won", "lost"]`, `QUOTE_STATUS_LABELS = { draft: "초안", sent: "보냄", won: "성사", lost: "무산" }`
  - `QUOTE_SOURCES = ["app", "imported"]`
  - `VERSION_STATUSES = ["generating", "ready", "failed"]`
  - `type QuoteLine = { itemId: number | null; label: string; content: string; qty: number; unitPrice: number | null; priceSource: PriceSource; svc: boolean; menu: string; note: string }`
  - `type QuoteEvent = { customerName: string; contactName: string; contact: string; email: string; eventDate: string; headcount: number | null; venue: string; eventType: string; budget: string; requests: string; missing: string[] }` (모르는 문자열 칸은 `""`)
  - `type Sender = { company: string; person: string; phone: string; email: string; payment: string; onsite: string; bizNo: string }`
  - `type ComparisonRow = { id: string; kind: "own" | "price" | "event"; label: string; perPerson: number | null; sourceUrl: string | null; seenAt: string | null }` (id 접두어: `q`/`p`/`e` + 숫자)
  - `type Comparison = { notes: string; rows: ComparisonRow[] }`
  - zod 스키마 `QuoteLineSchema`, `QuoteEventSchema`, `SenderSchema`(D1 JSON 칸 읽기·폼 검증용. 구조화 출력용이 아니라서 min/max를 써도 된다): qty는 0~100000 정수, unitPrice는 0~100000000 정수 또는 null.
- Produces (`app/watch/types.ts`): `WATCH_KINDS = ["rss", "page"]`, `WATCH_STATUSES = ["ok", "error"]`.
- Produces (`database/schema.ts`): 설계 §6.6의 표 여섯 개. 바뀐 점:
  - 행사 정보는 버전마다 `eventJson`에만 둔다(목록은 최신 버전 것을 읽는다).
  - `quotes`: `id, status, source, senderJson, vatIncluded(boolean), createdAt, updatedAt`.
  - `quote_versions`: `id, quoteId(FK cascade), version, status, error, workflowId, generationStartedAt, inputText, changeRequest, eventJson, linesJson, comparisonJson, emailSubject, emailBody, changesJson, inputTokens, outputTokens, createdAt, generatedAt`. `unique(quoteId, version)`.
  - `price_items`: §6.6 그대로 + `createdAt`.
  - `watch_sources`: §6.6 그대로 + `createdAt`.
  - `competitor_events`: `sourceUrl` unique. `competitor_prices`는 `index(sourceId, packageName)`.
  - enum 칸에는 기존 `inList` CHECK를 건다.

- [ ] **Step 1:** `test/schema.test.ts`에 실패하는 테스트를 쓴다.
  - 여섯 표에 한 줄씩 넣고 읽기.
  - `quote_versions (quoteId, version)` 중복 시 실패.
  - `quotes` 삭제 시 버전도 삭제.
  - `competitor_events.sourceUrl` 중복 시 실패.
  - 잘못된 `status` 값은 CHECK로 실패.
- [ ] **Step 2:** `npm test -- schema`가 실패하는지 확인한다.
- [ ] **Step 3:** 타입, 스키마, `npx drizzle-kit generate --name quote_agent`.
- [ ] **Step 4:** `npm test`, `npm run typecheck` 통과.
- [ ] **Step 5:** 커밋 `feat: tables for quotes, price sheet and competitor watch`

### Task 3: 견적 줄 계산 (순수 함수)

**Files:**
- Create: `app/quote/lines.ts`
- Test: `test/quote-lines.test.ts`

**Interfaces:**
- Consumes: Task 2의 `QuoteLine`, `price_items` 행 타입 `PriceItem`(`typeof priceItems.$inferSelect`).
- Produces:
  - `type ModelLine = { itemId: number | null; label: string; content: string; qty: number; menu: string; note: string; prevIndex: number | null }`
  - `computeTotals(lines: QuoteLine[], vatIncluded: boolean): { supply: number; vat: number; total: number; missingPrices: number }`
    - SVC 줄과 `unitPrice === null`인 줄은 공급금액에서 뺀다.
    - `missingPrices` = SVC가 아니면서 단가가 null인 줄 수.
  - `lineAmount(line: QuoteLine): number | "SVC" | null`
  - `buildLines(model: ModelLine[], sheet: PriceItem[], prev: QuoteLine[] | null): QuoteLine[]`. 규칙:
    1. 유효한 참조: `prevIndex`가 범위 안이고, 앞선 줄이 아직 쓰지 않았고, `model.itemId === prev[prevIndex].itemId`. 이때는 이전 줄의 `unitPrice`/`priceSource`/`svc`를 그대로 가져오고, 문구와 수량은 모델 값을 쓴다.
    2. 그 밖에 `itemId`가 기준표에 있고 enabled면 기준표 단가, `priceSource: "sheet"`, `svc: false`.
    3. 둘 다 아니면 `itemId: null`, `unitPrice: null`, `priceSource: "hand"`, `svc: false`.
    4. qty는 음수·소수를 0 이상 정수로 고친다.
  - `diffLines(prev: QuoteLine[], next: QuoteLine[]): string[]`. 줄은 `itemId`(없으면 label)로 맞춘다. 결과 예:
    - `"추가: <label>"`, `"삭제: <label>"`
    - `"수량 300→350: <label>"`, `"단가 7,700→9,000원: <label>"`
    - `"SVC 켬: <label>"`, `"SVC 끔: <label>"`

- [ ] **Step 1:** 실패하는 테스트를 쓴다(가짜 기준표: id 1 "다과 4종" 1인 7,700 / id 2 "출장료" 1회 100,000 / id 3 꺼진 항목).
  - `computeTotals`, VAT 켬: 500×7,700 + 1×100,000 → `{ supply: 3,950,000, vat: 395,000, total: 4,345,000, missingPrices: 0 }`.
  - VAT 끔: `vat 0`, `total === supply`.
  - SVC 줄은 빠지고, `lineAmount`가 `"SVC"`.
  - 단가 null 줄은 빠지고 `missingPrices 1`, `lineAmount`가 null.
  - `buildLines`, prev 없음: id 1 → 7,700 sheet / 없는 id 99 → null hand / 꺼진 id 3 → null hand.
  - 수정 버전: prev[0]이 hand 9,000이고 모델이 `prevIndex 0`, 같은 itemId, qty 350 → 9,000 hand, qty 350.
  - prev[1]이 SVC이고 `prevIndex 1` → SVC 유지.
  - 두 모델 줄이 같은 `prevIndex 0`을 가리키면 첫 줄만 가져오고 둘째는 규칙 2/3을 따른다.
  - `prevIndex 7`(범위 밖) → 규칙 2/3.
  - `prevIndex`는 맞지만 itemId가 다르면 → 기준표 단가, svc false.
  - qty -3 → 0, 2.6 → 3.
  - `diffLines`: 추가·삭제·수량·단가·SVC 다섯 경우에 위 문자열이 정확히 나온다.
- [ ] **Step 2:** 실패 확인 `npm test -- quote-lines`.
- [ ] **Step 3:** `app/quote/lines.ts` 구현.
- [ ] **Step 4:** 통과 확인.
- [ ] **Step 5:** 커밋 `feat: quote line pricing, totals and revision carry-over`

### Task 4: 가격 기준표와 견적 설정

**Files:**
- Create: `app/quote/price-sheet.server.ts`, `app/quote/quote-settings.server.ts`, `app/routes/quote-settings.tsx`
- Modify: `app/routes.ts` (`settings/quote`), `app/routes/settings.tsx` (맨 위에 "견적 설정 →" 링크 하나)
- Test: `test/price-sheet.test.ts`, `test/quote-settings.test.ts`

**Interfaces:**
- Produces:
  - `listPriceItems(db, opts?: { enabledOnly?: boolean }): Promise<PriceItem[]>` (sort, id 순서)
  - `savePriceItem(db, input: PriceItemInput, now: Date): Promise<number>`
    - `PriceItemInput = { id?: number; kind; name; content; unit; unitPrice: number | null; minimumQty: number | null; menu; note; needsConfirm: boolean; enabled: boolean; sort: number }`
    - 이름이 비면 `DomainError("INVALID_INPUT")`.
    - 사장님이 저장하면 `needsConfirm`은 false가 된다(폼에서 보낸 값과 상관없이).
  - `deletePriceItem(db, id): Promise<void>`. 지난 견적은 단가를 복사해 두었으므로 안전하다.
  - `type QuoteSettings = { sender: Sender; intro: string; fixedLines: string }`
  - `getQuoteSettings(db): Promise<QuoteSettings>`, `saveQuoteSettings(db, s: QuoteSettings): Promise<void>`
    - settings 키: `quote_sender`(JSON), `quote_intro`, `quote_fixed_lines`.
    - 기본값: `sender.company = "스톤테이블"`, 나머지 `""`.
    - 홍보글 `settings.server.ts`의 KEYS 바깥 키다. 비밀번호 해시 키를 건드리지 않는다.
- 화면 `/settings/quote`:
  - 가격 기준표: 줄마다 이름·단위·단가·최소 수량·메뉴·비고·켜기 편집, 추가, 삭제. `needsConfirm` 줄은 노란 배경과 "확인 필요" 배지.
  - 발신 정보 칸들.
  - 소개 문구와 기본 제공 사항 textarea.
  - intent: `savePriceItem`, `deletePriceItem`, `saveQuoteSettings`.

- [ ] **Step 1:** 실패하는 테스트를 쓴다.
  - `savePriceItem`으로 새 항목을 넣고 같은 id로 고치면 `needsConfirm`이 false가 된다.
  - 이름이 빈 입력 → `INVALID_INPUT`.
  - `listPriceItems({ enabledOnly: true })`는 꺼진 항목을 뺀다.
  - `getQuoteSettings` 빈 DB → company "스톤테이블". 저장 후 다시 읽으면 같다.
  - `quote_sender`에 깨진 JSON이 들어 있으면 기본값으로 읽는다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 서버 모듈, 라우트, 화면 구현. 처음 값은 화면으로 넣거나 Task 8의 배포 단계에서 비공개 SQL로 넣는다.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run dev`(포트 5174)로 화면을 열어 항목 하나를 저장해 본다.
- [ ] **Step 5:** 커밋 `feat: price sheet and quote sender settings`

### Task 5: 견적 만들기 (백엔드)

**Files:**
- Create: `app/quote/prompt.ts`, `app/quote/comparison.server.ts`, `app/quote/quotes.server.ts`, `app/quote/generate.server.ts`, `workers/quote-workflow.ts`
- Modify: `app/promo/claude.server.ts` (`ClaudeCalls`에 `quote`, `importQuote` 추가, 가짜 응답 포함), `wrangler.jsonc` (workflow `quote-generate` / binding `QUOTE_GENERATE` / class `QuoteGenerateWorkflow`), `workers/app.ts` (export)
- Test: `test/quote-generate.test.ts`, `test/quote-comparison.test.ts`

**Interfaces:**
- Consumes: Task 3 `buildLines`/`diffLines`/`ModelLine`, Task 4 `listPriceItems`/`getQuoteSettings`.
- Produces (`app/quote/prompt.ts`):
  - `QuoteOutput` zod: `{ event: { customerName, contactName, contact, email, eventDate, headcount: int|null, venue, eventType, budget, requests, missing: string[] }, lines: [{ itemId: int|null, label, content, qty: int, menu, note, prevIndex: int|null }], comparison: { notes, citedIds: string[] }, email: { subject, body }, requestSummary: string }`
  - `ImportOutput` zod: `{ event: (같음), lines: [{ label, content, qty: int, unitPrice: int|null, svc: boolean, menu, note }] }`.
  - `buildQuoteSystem(): string`. 설계 §6.2의 규칙:
    - 기준표 `itemId`로만 가격을 정한다.
    - 금액을 쓰지 않는다.
    - SVC는 비고로 제안만 한다.
    - 빠진 정보는 `missing`에 질문으로 남긴다.
    - 메일은 정중하고 짧게, 운영 방식을 지어내지 않는다.
    - `citedIds`는 받은 id만 쓴다.
    - 바뀌지 않는 글이라 cache_control 대상이다.
  - `buildQuoteUser(input: { text: string; sheet: PriceItem[]; candidates: ComparisonRow[]; prev: { lines: QuoteLine[]; event: QuoteEvent } | null; changeRequest: string | null }): Anthropic.ContentBlockParam[]`
  - `buildImportSystem(): string`. "완성된 견적을 그대로 옮긴다. 가격을 매기지 않는다."
- Produces (`app/quote/comparison.server.ts`):
  - `selectCandidates(db, event: Pick<QuoteEvent, "eventType" | "headcount">, excludeQuoteId: number | null): Promise<ComparisonRow[]>`
    - 사장님 견적(지금 견적 제외, ready 버전이 있는 것) 최대 10개 → 업체별 패키지 최신 가격 최대 10개 → 경쟁 업체 행사 최대 10개, 이 순서로 합쳐 30개 이하.
    - `eventType` 키워드가 맞는 것을 앞에 둔다. 나머지 휴리스틱은 구현자가 정한다(설계 §8).
- Produces (`app/quote/quotes.server.ts`):
  - `createQuote(db, input: { text: string; source: "app" | "imported" }, now): Promise<{ quoteId: number }>`. 설정의 sender와 VAT 켬을 복사하고, version 1을 `generating`으로 만든다. text는 1~20,000자, 아니면 `INVALID_INPUT`.
  - `requestRevision(db, quoteId, changeRequest, now): Promise<{ version: number }>`. 최신 버전이 `ready`일 때만 v(n+1)을 만든다. 최신이 `generating`이고 오래되지 않았으면 `BUSY`.
  - `getQuote(db, quoteId, version?: number): Promise<QuoteView>`. `QuoteView = { quote, version: VersionView, versions: { version: number; status: string; createdAt: string }[] }`. `VersionView`는 JSON 칸을 파싱한 값(`event`, `lines`, `comparison`, `changes`)이다.
  - `listQuotes(db): Promise<QuoteListItem[]>`: 고객/행사 성격, 행사일, 인원, 합계(`computeTotals`), 상태, 최신 버전 번호.
  - `saveLines(db, quoteId, version, lines: QuoteLine[]): Promise<void>`, `saveEvent(db, quoteId, version, event: QuoteEvent)`. 최신 버전이고 `ready`일 때만 된다. 아니면 `INVALID_STATE`. 입력은 zod로 검사한다.
  - `saveSender(db, quoteId, sender)`, `setVat(db, quoteId, on: boolean)`, `setStatus(db, quoteId, status)`, `deleteQuote(db, quoteId)`
- Produces (`app/quote/generate.server.ts`):
  - `type QuoteGenParams = { quoteId: number; version: number }`
  - `startQuoteGeneration(env: Pick<Env, "QUOTE_GENERATE">, db, quoteId, version, now)`. 버전 행의 `workflowId`/`generationStartedAt`을 claim하고 Workflow를 만든다. 만들기에 실패하면 버전을 `failed`로 둔다(홍보글 `startGeneration`과 같은 방식). `createQuote`/`requestRevision` 다음에 라우트가 부른다.
  - `runQuoteGeneration(deps: QuoteGenDeps, run: { quoteId; version; workflowId }, opts: RunOptions): Promise<void>`
    - `source === "imported"`면 `importQuote` 호출. lines는 `priceSource: "imported"`, `itemId: null`이다.
    - 아니면 `quote` 호출 → `buildLines`. citedIds로 candidates를 걸러 `comparisonJson`에 스냅숏한다. v2부터는 `changesJson = [requestSummary, ...diffLines(prev, next)]`.
    - 쓰기는 모두 "이 run이 아직 그 버전을 쥐고 있을 때만"이다. 실패 처리는 `app/promo/generate.server.ts`의 `handleFailure`/`GenerationError`/`permanentApiFailure` 방식을 따른다(재사용 가능한 것은 export해서 쓴다).
  - `QuoteGenDeps = { db; quote: QuoteCall; importQuote: ImportCall; now: () => Date }`, `makeQuoteGenDeps(env, db)` (`FAKE_CLAUDE=1`이면 가짜).
- Produces (`app/promo/claude.server.ts`): `ModelResult<T>`를 export하고, `QuoteCall = (req: ModelRequest) => Promise<ModelResult<QuoteOutput>>`, `ImportCall = (req: ModelRequest) => Promise<ModelResult<ImportOutput>>`를 더한다. `ClaudeCalls`에 `quote`, `importQuote`가 생긴다.
- `workers/quote-workflow.ts`: step `generate` 하나. 재시도와 타임아웃은 홍보글 상수를 쓴다.

- [ ] **Step 1:** 실패하는 테스트를 쓴다. 가짜 `QuoteCall`과 고정 `QuoteOutput`을 쓴다.
  - `createQuote` → `startQuoteGeneration`(가짜 env.QUOTE_GENERATE) → `runQuoteGeneration` → `getQuote`: event와 lines가 기준표 단가로 채워진다. `status ready`, 토큰이 기록된다.
  - 모델이 없는 `citedIds`("p999")를 내면 comparison.rows에서 빠진다.
  - `requestRevision`: v1의 줄 하나를 `saveLines`로 hand 9,000으로 고친 뒤 v2를 만들면, 그 줄이 9,000 hand로 남고 `changes[0]`이 requestSummary다.
  - 최신이 `generating`일 때 `requestRevision` → `BUSY`. 두 번 연달아 불러도 버전 행은 하나다.
  - 옛 버전(v1, 최신은 v2)에 `saveLines` → `INVALID_STATE`.
  - `GenerationError("refusal")` → 버전 `failed`와 한국어 오류 메시지, 다시 throw하지 않는다.
  - 다른 workflowId의 run → 아무것도 쓰지 않는다.
  - imported 버전 → `importQuote`가 불리고, 줄 단가가 파일 값이며 `priceSource` imported다.
  - `selectCandidates`: 사장님 견적, 가격, 행사를 넣으면 순서와 상한(각 10)을 지키고, `excludeQuoteId`가 빠지며, id 접두어가 붙는다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현. `claude.server.ts`의 `makeClaudeCalls`에 `quote: (req) => call(QuoteOutput, req, "medium")`, `importQuote: (req) => call(ImportOutput, req, "low")`를 더하고, 가짜는 기준표 첫 항목 한 줄짜리를 돌려준다.
- [ ] **Step 4:** `npm test`, `npm run typecheck`(`wrangler types`가 `QUOTE_GENERATE`를 만든다).
- [ ] **Step 5:** 커밋 `feat: quote generation workflow with revisions and comparison snapshot`

### Task 6: 견적 화면

**Files:**
- Create: `app/routes/quotes.tsx`, `app/routes/quote-new.tsx`, `app/routes/quote-detail.tsx`, `app/routes/api.quote-status.ts`, `app/quote/components/LinesTable.tsx`, `app/quote/components/ComparisonPanel.tsx`
- Modify: `app/routes.ts`, `app/routes/owner-layout.tsx` (메뉴에 `{ to: "/quotes", label: "견적" }` 추가. 라우트 `handle: { wide: true }`면 `max-w-4xl`, 아니면 기존 `max-w-xl`)
- Test: `test/quote-routes.test.ts` (action 단위)

**Interfaces:**
- Consumes: Task 5의 `quotes.server.ts`, `startQuoteGeneration`. Task 3의 `computeTotals`/`lineAmount`.
- 라우트:
  - `/quotes` 목록 + "새 견적" 버튼
  - `/quotes/new` textarea + 만들기 → `createQuote` + `startQuoteGeneration` → `/quotes/:id`로 이동
  - `/quotes/:id?v=N` 상세
  - `/api/quotes/:id/status` → `{ version, status, error }`. 만드는 중일 때 상세 화면이 3초마다 부른다(홍보글 `api.post-status.ts`와 같은 방식).
- 상세 intent:
  - `saveEvent`, `saveLines`(줄 전체를 JSON으로)
  - `saveSender`, `setVat`, `setStatus`
  - `requestRevision`(textarea) → 새 버전으로 이동
  - `deleteQuote`(확인 단계 하나를 둔다. `window.confirm`은 쓰지 않는다)
- 상세 화면 구성은 설계 §6.1:
  - 행사 정보와 "확인할 것" 목록.
  - 견적 표(`LinesTable`): 줄 편집, SVC 스위치, 기준표에서 고르는 추가, 직접 입력 줄 추가. 단가를 직접 바꾸면 `priceSource "hand"`가 된다. 단가 없는 줄은 "단가 없음" 표시. 공급금액과 합계, `missingPrices > 0`이면 "단가 없는 줄 N개" 경고.
  - 비교(`ComparisonPanel`): notes, rows(종류 배지, label, 1인 단가, 출처 링크 `target=_blank rel=noreferrer`, seenAt 날짜). 비어 있으면 "아직 비교할 자료가 없어요".
  - 회신 메일과 복사 버튼(`app/promo/clipboard.ts` 재사용).
  - 바뀐 점(v2부터), 발신 정보와 VAT 스위치, 엑셀 받기 링크(Task 7).
  - 옛 버전은 읽기 전용이고 "최신 버전 보기" 링크가 있다.

- [ ] **Step 1:** 실패하는 action 테스트를 쓴다.
  - `/quotes/new`에 빈 text → 오류 메시지, 견적이 생기지 않는다.
  - `saveLines`에 qty -1 같은 잘못된 JSON → 400 메시지, 저장되지 않는다.
  - `setStatus "won"` 후 `listQuotes`에서 상태가 won이다.
  - 로그인 없이 `/quotes` → 로그인으로 이동(기존 미들웨어 확인).
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현. 상세의 편집은 홍보글 상세처럼 `useFetcher`로 바로 저장하고, 화면에는 낙관적으로 먼저 반영한다.
- [ ] **Step 4:** `npm test`, `npm run typecheck`. 그다음 `FAKE_CLAUDE=1`로 `npm run dev`를 켜고 브라우저(ego-browser)로 한 바퀴 돈다: 새 견적 → 가짜 결과 → 줄 단가 고치기 → SVC → 수정 요청 → v2에 고친 단가가 남는지. 375px 폭과 PC 폭 스크린숏을 하나씩 남긴다.
- [ ] **Step 5:** 커밋 `feat: quote list, new and detail screens`

### Task 7: 엑셀 받기

**Files:**
- Create: `app/quote/excel.server.ts`, `app/routes/quote-xlsx.ts`
- Modify: `app/routes.ts` (`quotes/:id/v/:version/xlsx`), `package.json` (Task 1에서 고른 라이브러리)
- Test: `test/quote-excel.test.ts`

**Interfaces:**
- Consumes: `QuoteView`(Task 5), `getQuoteSettings`(Task 4), `lineAmount`/`computeTotals`(Task 3).
- Produces:
  - `buildQuoteXlsx(input: { event: QuoteEvent; lines: QuoteLine[]; sender: Sender; vatIncluded: boolean; intro: string; fixedLines: string; createdAt: string }): Promise<Uint8Array>`
  - `xlsxFileName(customerName: string, createdAt: string, version: number): string` → `스톤테이블_견적서_<고객>_<YYMMDD>_v<n>.xlsx`
    - 고객 이름에서 `\/:*?"<>|`와 제어 문자를 빼고 공백은 `_`로 바꾼다. 비면 "고객".
    - 날짜는 KST 기준이다.
  - `xlsxToText(bytes: Uint8Array): Promise<string>`: 첫 시트의 값이 있는 셀을 행 단위 탭 구분 텍스트로 만든다. 수식 셀은 계산값을 쓴다. Task 10이 사용한다.
- 시트 배치는 설계 §6.3을 따른다. 줄 표의 열은 `항목 | 내용 | 수량 | 공급 단가 | 공급 금액 | 메뉴 | 비고`.
  - 금액 칸: 수식 `=수량칸*단가칸`. SVC면 문자열 `"SVC"`, 단가가 없으면 빈칸.
  - 공급금액: `=SUM(금액 열 범위)`. 문자열과 빈칸은 SUM이 무시한다.
  - VAT 켬: 합계 `=ROUND(공급금액칸*1.1,0)`, 라벨 "합계 금액 (VAT 10% 포함)". VAT 끔: 합계 줄 없이 공급금액만 두고, 사업자번호가 비면 그 줄도 뺀다.

- [ ] **Step 1:** 실패하는 테스트를 쓴다. 만든 바이트를 같은 라이브러리로 다시 읽는다.
  - 줄 3개(일반, SVC, 단가 없음): 일반 줄 금액 셀이 수식이고, SVC 셀 값이 "SVC", 단가 없음 셀이 비어 있다.
  - 공급금액 칸 수식이 금액 열 전체를 SUM하고, 캐시된 값을 쓴다면 `computeTotals().supply`와 같다.
  - VAT 켬이면 `ROUND(...*1.1,0)` 수식이 있고, VAT 끔이면 "VAT"라는 글자가 시트 어디에도 없다.
  - 발신 company가 시트에 들어간다.
  - `xlsxFileName`: `'A/B "학원"'` → `스톤테이블_견적서_AB_학원_261109_v2.xlsx`(입력 예 2026-11-09 KST), `""` → `_고객_`.
  - `xlsxToText`는 만든 파일에서 "다과" 같은 줄 label을 찾는다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현. 라우트는 owner 미들웨어 아래의 resource route다.
  - `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - `Content-Disposition: attachment; filename="quote.xlsx"; filename*=UTF-8''<encodeURIComponent(name)>`
  - 상세 화면에 "엑셀 받기" 링크를 단다.
- [ ] **Step 4:** `npm test`, `npm run typecheck`. dev 서버에서 파일을 받아 macOS Numbers나 Excel로 열어 수식 결과가 화면 합계와 같은지 본다.
- [ ] **Step 5:** 커밋 `feat: quote Excel download`

### Task 8: 1단계 배포 (견적만)

**Files:**
- Modify: `docs/deploy-checklist.md` (새 Workflow 바인딩, 0004 마이그레이션, 비공개 시드)
- Create (커밋 안 함): `private/seed-quote-2026-11-09.sql`

- [ ] **Step 1:** `private/seed-quote-2026-11-09.sql`을 쓴다.
  - `docs/ax-challenge/quote-template-notes.md`(cafe-manager 브랜치 `worktree-ax-challenge-day1`)의 가격 기준표 v0 항목을 `price_items`에 넣는다. 모두 `needs_confirm = 1`.
  - `quote_intro`와 `quote_fixed_lines`는 그 문서의 소개 문구와 기본 제공 사항 4줄로 넣는다.
- [ ] **Step 2:** `npm test`, `npm run typecheck` 통과 확인. 원격 마이그레이션 → 시드 → 배포 순서로 한다.
  - `npx wrangler d1 migrations apply promo-agent --remote`
  - `npx wrangler d1 execute promo-agent --remote --file private/seed-quote-2026-11-09.sql`
  - `npm run deploy`
  배포 결과의 Version ID를 적는다.
- [ ] **Step 3:** 실제 확인. 로그인 비밀번호는 `private/owner-password.txt`.
  - 만든 가짜 문의("○○학원 12월 20일 수료식 120명 다과, 음료 포함, 예산 120만원 정도")로 견적을 만든다.
  - 걸린 시간과 토큰, 비용을 기록한다. `wrangler tail`의 `claude usage` 로그를 본다.
  - 수정 요청("인원 150명으로, 출장비 빼 주세요")으로 v2를 만들고 엑셀을 받는다.
  - 확인한 뒤 테스트 견적은 지운다.
- [ ] **Step 4:** 측정값을 `private/sdd-ledger-2026-11-09-quote.md`에 적는다. 커밋 `docs: deploy checklist for quotes`.

### Task 9: 경쟁 업체 감시 (백엔드)

**Files:**
- Create: `app/watch/naver-blog.ts` (`scripts/blog/parse.ts`의 `parseRss`, `parsePostHtml`, `tagText`, `unescapeHtml`을 옮긴다. `scripts/blog/parse.ts`는 여기서 re-export한다), `app/watch/fetch.server.ts`, `app/watch/sources.server.ts`, `app/watch/extract.ts`, `app/watch/run.server.ts`, `workers/watch-workflow.ts`
- Modify: `app/promo/claude.server.ts` (`watchEvent`, `watchPrices` 호출, effort low, 가짜 응답), `wrangler.jsonc` (cron `"0 18 * * *"` = 03:00 KST, workflow `watch` / binding `WATCH` / class `WatchWorkflow`), `workers/app.ts` (scheduled에서 cron이 감시 cron이면 `env.WATCH.create({ id: "watch-<KST 날짜>" })`. 이미 있으면 무시한다), `app/kakao/alerts.server.ts` 근처 CRONS 주석
- Test: `test/watch.test.ts`, 기존 `test/blog-parse.test.ts` 통과 유지

**Interfaces:**
- Produces:
  - `parseRss(xml): RssItem[]`를 일반화한다. `RssItem = { title; url; key; pubDate }`. 네이버면 `key = logNo`, 아니면 `guid` 또는 link다. 기존 호출부(`scripts/import-blog.ts`, 테스트)가 쓰는 `logNo`는 네이버 항목에서 계속 채운다.
  - `fetchText(url: string, f: typeof fetch): Promise<{ status: number; text: string }>`
    - 문자 집합 순서: Content-Type charset → `<meta charset>`/`http-equiv` → utf-8. `euc-kr`/`cp949`/`ks_c_5601-1987`은 `TextDecoder("euc-kr")`로 읽는다.
    - 타임아웃 15초.
    - Task 1 결정이 `claude_web_fetch`면 네이버 URL은 이 함수 대신 Claude 추출 호출에 URL을 넘긴다. 이때 `tools: [{ type: "web_fetch_20260209", name: "web_fetch", allowed_domains: ["blog.naver.com", "m.blog.naver.com", "rss.blog.naver.com"], max_uses: 2 }]`.
  - `htmlToText(html: string): string`: script, style, 태그를 빼고 공백을 정리한다. 네이버 글이 아닌 페이지용이다.
  - `EventExtract` zod: `{ isEvent: boolean, date, client, venue, eventType, menu: string[], quantity, headcount: int|null, price: int|null, notes }`(모르면 `""`/null)
  - `PriceExtract` zod: `{ packages: [{ name, perPerson: int|null, items: string[], minimum, fees: string[] }] }`
  - `runWatchSource(deps: WatchDeps, sourceId: number, budget: number, now: Date): Promise<{ claudeCalls: number; added: number; status: "ok" | "error" | "skipped" }>`
    - `rss`: `lastSeenKey`보다 새 항목만, 출처당 10개까지, budget 안에서. 글마다 본문을 가져와 `watchEvent`를 부르고, `isEvent`면 `competitor_events`에 넣는다. `sourceUrl`이 같으면 무시한다(`onConflictDoNothing`). 처리한 가장 새 key를 `lastSeenKey`로 둔다.
    - `page`: `lastRunAt`이 7일 안이면 skipped. 본문 SHA-256이 `contentHash`와 같으면 Claude를 부르지 않는다. 다르면 `watchPrices` → 패키지마다 (sourceId, packageName)의 최신 줄과 perPerson/minimum/items/fees가 다를 때만 새 줄을 넣는다.
    - 오류가 나면 `lastStatus "error"`, `lastError`(200자)를 기록하고 throw하지 않는다. 성공하면 `ok`, error null. 어느 쪽이든 `lastRunAt` 갱신.
  - `WatchEventCall = (req: ModelRequest) => Promise<ModelResult<EventExtract>>`, `WatchPricesCall = (req: ModelRequest) => Promise<ModelResult<PriceExtract>>` (`claude.server.ts`의 `ClaudeCalls`에 `watchEvent`, `watchPrices`로 추가)
  - `WatchDeps = { db; fetch: typeof fetch; watchEvent: WatchEventCall; watchPrices: WatchPricesCall; now: () => Date }`, `makeWatchDeps(env, db)`
  - `WATCH_RUN_BUDGET = 30`
  - `listWatchSources(db)`, `saveWatchSource(db, input: { id?; name; kind; url; memo; enabled }, now)`(URL은 http/https만), `deleteWatchSource(db, id)`
- `WatchWorkflow.run`: 켜진 출처마다 `step.do("source-<id>", { retries: { limit: 1, delay: "30 seconds" }, timeout: "5 minutes" }, ...)`. 남은 budget은 step 결과를 합산해 넘긴다.

- [ ] **Step 1:** 실패하는 테스트를 쓴다. fetch는 가짜이고 픽스처는 만든 가짜 HTML/RSS다.
  - RSS 3개 중 `lastSeenKey`보다 새 것 2개만 처리되고, `isEvent false`인 1개는 저장되지 않으며, `lastSeenKey`가 가장 새 key가 된다.
  - 같은 실행을 두 번 하면 행사 줄이 늘지 않는다.
  - budget 1이면 Claude 호출이 1번이다.
  - fetch가 429 → `lastStatus error`, `lastError`에 "429"가 들어가고 throw 없음, 행사 줄 0.
  - EUC-KR 바이트(`new Uint8Array([0xb0, 0xa1])` = "가")에 `content-type: text/html; charset=euc-kr` → `fetchText`가 "가"를 돌려준다. meta charset만 있는 경우도 확인.
  - `page`: 첫 실행은 가격 2줄. 같은 본문으로 8일 뒤 다시 돌리면 Claude 호출 0(해시 같음). 본문이 바뀌고 한 패키지 가격만 다르면 그 패키지만 새 줄 1개.
  - `page`, 3일 뒤 → skipped.
  - `saveWatchSource`에 `javascript:` URL → `INVALID_INPUT`.
  - 네이버가 아닌 RSS(WordPress 형식 `guid`)도 `key`가 채워진다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `npm test`, `npm run typecheck`.
- [ ] **Step 5:** 커밋 `feat: daily competitor watch workflow`

### Task 10: 경쟁 업체 화면, 비교 연결, 지난 견적 가져오기

**Files:**
- Create: `app/routes/competitors.tsx`, `app/routes/quote-import.tsx`
- Modify: `app/routes.ts`, `app/routes/owner-layout.tsx` (메뉴 `{ to: "/competitors", label: "경쟁 업체" }`), `app/routes/quotes.tsx` ("지난 견적 가져오기" 링크)
- Test: `test/competitors-route.test.ts`, `test/quote-import.test.ts`

**Interfaces:**
- Consumes: Task 9의 sources/표, Task 7의 `xlsxToText`, Task 5의 `createQuote({ source: "imported" })`와 `startQuoteGeneration`.
- `/competitors?tab=news|prices|sources`:
  - 소식: 행사 최신순 100개, `q`로 업체·고객·장소 글자 검색.
  - 가격: (출처, 패키지)별 최신 값과 이전 값 개수. 펼치면 이력.
  - 감시 목록: 편집, 켜기/끄기, 마지막 실행 상태와 오류, "지금 한 번 돌리기" 버튼(intent `runNow` → `env.WATCH.create({ id: "watch-manual-<ms>" })`).
- `/quotes/import`: .xlsx 하나(5MB 이하, 확장자와 MIME 확인) → `xlsxToText` → 비면 오류 → `createQuote(db, { text, source: "imported" })` → `startQuoteGeneration` → 상세로 이동. 상세는 imported 견적에서 "가져온 견적이에요. 내용을 확인하고 상태(보냄/성사/무산)를 골라 주세요." 안내를 보여 준다.

- [ ] **Step 1:** 실패하는 테스트를 쓴다.
  - `?tab=news&q=병원`이 가짜 행사 3개 중 맞는 것만 돌려준다.
  - 가격 탭이 같은 패키지 두 줄 중 최신만 위에 둔다.
  - `runNow`가 `env.WATCH.create`를 부른다(가짜 바인딩).
  - 가져오기에 .txt → 오류. Task 7로 만든 가짜 .xlsx → 견적 source imported, version 1 generating.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `FAKE_CLAUDE=1` dev로 세 탭과 가져오기를 브라우저로 한 바퀴.
- [ ] **Step 5:** 커밋 `feat: competitors page and past quote import`

### Task 11: 2단계 배포와 마무리

**Files:**
- Modify: `docs/deploy-checklist.md`, `README.md` (견적·경쟁 업체 감시 기능 한 단락. 경쟁 업체 이름은 쓰지 않는다)
- Create (커밋 안 함): `private/seed-watch-2026-11-09.sql`

- [ ] **Step 1:** `private/seed-watch-2026-11-09.sql`을 쓴다. 조사 결과(`private/competitor-research-2026-11-09/`, 이 세션 요약)에서 RSS가 되는 블로그 4~5개와 텍스트 가격 페이지 2~3개를 `watch_sources`에 넣는다. 업체 A는 memo에 "사장님 확인 필요: 같은 업체인지, 협력사인지"를 적는다.
- [ ] **Step 2:** 원격 마이그레이션(새 것이 있으면) → 시드 → `npm run deploy`. Version ID를 적는다.
- [ ] **Step 3:** 실제 확인.
  - 경쟁 업체 화면에서 "지금 한 번 돌리기" → 몇 분 뒤 소식·가격 탭에 줄이 생기는지, 출처마다 상태가 ok인지 본다.
  - Claude 호출 수와 비용을 `wrangler tail`로 기록한다.
  - 새 테스트 견적을 만들어 비교 칸에 출처 링크 달린 줄이 나오는지 확인하고, 테스트 견적을 지운다.
- [ ] **Step 4:** 다음 날 03:00 KST 크론 결과(감시 목록의 lastRunAt)를 확인하는 일을 ledger의 남은 일에 적는다.
- [ ] **Step 5:** 커밋 `docs: README and deploy checklist for competitor watch`. 그다음 PR(`feat/quote-agent` → main)을 만들고 리뷰가 통과하면 병합한다.
