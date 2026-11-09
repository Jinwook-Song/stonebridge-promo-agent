# 배포 체크리스트 (개발자용)

처음 배포할 때 위에서부터 순서대로. 명령은 저장소 루트에서 실행한다.

## 1. 준비

- [ ] **Node 22.22 이상**으로 바꾼 뒤 빌드한다 (`node -v`). 낮은 버전에서는 `npm run build`가 실패할 수 있다.
- [ ] **Workers Paid 요금제를 첫 실제 호출 전에 켠다.** 무료 요금제는 Workflow 단계마다 CPU 10 ms라 Claude 스트리밍 응답 파싱이 들어가지 않는다. 그러면 단계가 3번(과금되는 재시도 포함) 실패하고, 사장님 화면에는 원인과 상관없는 "잠시 후 다시 시도해 주세요."만 뜬다.

## 2. 리소스 만들기

- [ ] D1: `npx wrangler d1 create promo-agent` → 나온 `database_id`를 `wrangler.jsonc`의 `d1_databases[0].database_id`에 넣는다.
- [ ] R2: `npx wrangler r2 bucket create promo-photos` (공개 접근은 켜지 않는다).
- [ ] 마이그레이션: `npx wrangler d1 migrations apply promo-agent --remote`

## 3. 설정값

- [ ] **한국용 앞단(Pages)**: `npx wrangler pages project create stonebridge-promo --production-branch main` (한 번만). `edge/`의 Pages 프로젝트가 모든 요청을 서비스 바인딩으로 Worker에 넘긴다. `*.workers.dev`는 한국에서 LA 거점으로 들어가 화면마다 1~10초 걸리고, `*.pages.dev`는 서울 거점이라 0.06~0.24초다 (2026-11-09 측정). `npm run deploy`가 Worker 다음에 앞단도 배포한다.
- [ ] **`PUBLIC_ORIGIN`**: `wrangler.jsonc`의 `vars.PUBLIC_ORIGIN`을 앞단 주소(`https://stonebridge-promo.pages.dev`)로 둔다. Claude가 이 주소로 서명된 사진 URL을 받아 가고, 카톡 알림 버튼도 이 주소로 간다. workers.dev 주소로 들어온 요청은 이 주소로 308 넘긴다. 바꿀 때는 카카오 콘솔에 새 주소를 먼저 등록한다 ([kakao-setup.md](kakao-setup.md)).
  - 자리표시자(`example` 들어간 주소)나 잘못된 https 주소면 초안 만들기가 바로 실패하고 "앱 주소 설정(PUBLIC_ORIGIN)이 안 되어 있어요. 관리자에게 알려 주세요."가 뜬다 (재시도 없음).
- [ ] 비밀값 4개 (`npx wrangler secret put <이름>`):
  - `ANTHROPIC_API_KEY`
  - `SESSION_SECRET` — 32자 이상 (`openssl rand -base64 48`)
  - `OWNER_INITIAL_PASSWORD` — 8자 이상, 사장님께 따로 전달
  - `IMAGE_URL_SECRET` — 32자 이상 (`openssl rand -base64 48`)
- [ ] (선택) 카톡 알림 키 2개: `KAKAO_REST_KEY`, `KAKAO_CLIENT_SECRET`. 없어도 배포는 되고 알림만 꺼진다. 콘솔 설정과 연결 순서: [kakao-setup.md](kakao-setup.md)
- [ ] 배포: `npm run deploy`

## 4. 예시 글 넣기 (한 번만)

- [ ] `npx wrangler d1 execute promo-agent --remote --file private/seed-examples.sql`
  - **멱등이 아니다.** 다시 실행하면 예시가 두 벌이 된다.
  - 다시 넣어야 하면 먼저 지운다: `npx wrangler d1 execute promo-agent --remote --command "DELETE FROM examples WHERE source='blog_import'"` (사장님 확정본 `owner_final`은 남는다).
- 시드 파일을 새로 만들 때는 `private/import-command.txt`에 저장해 둔 명령을 그대로 실행한다 (`scripts/import-blog.ts`).
- `private/`는 git에 올리지 않는다.

## 5. 꼬리말·가격표

- [ ] 앱의 **설정** 화면에서 꼬리말(블로그/짧은 판)과 가격표를 넣는다. 실제 문구는 절대 git에 넣지 않는다.
- 말투·채널 규칙 칸은 비워 두거나 기본값 그대로 저장하면 코드의 기본 규칙을 따라간다.

## 6. 첫 실제 확인

- [ ] `npx wrangler tail`을 켜 둔다.
- [ ] 사진 2장으로 글 하나를 만든다 → 네 채널 초안이 다 나오는지 본다.
- [ ] 한 채널을 **다시 쓰기** 두 번 한다 → 두 번째 다시 쓰기의 `claude usage`에서 `cache_read_input_tokens`가 0보다 큰지 확인한다 (시스템 프롬프트 캐시).
  - 첫 다시 쓰기는 캐시를 못 읽는 게 정상이다. 초안 만들기와 다시 쓰기는 출력 JSON 스키마가 달라서 캐시 앞부분이 다르다 (2026-11-08 실측: 초안 6,467 토큰 기록 → 첫 다시 쓰기 5,424 토큰 새로 기록 → 두 번째 다시 쓰기 5,424 토큰 읽음). 첫 다시 쓰기마다 약 $0.02가 더 든다.
- [ ] 두 호출의 토큰 수(`input_tokens`, `cache_*`, `output_tokens`)와 걸린 시간을 적어 둔다.
- [ ] 시간이 단계 제한(15분, `STEP_TIMEOUT_MINUTES`)에 가깝거나 `max_tokens`로 잘리면 `app/promo/generate.server.ts`의 타임아웃 / `app/promo/claude.server.ts`의 `MAX_TOKENS`를 조정한다. 타임아웃을 바꾸면 `STALE_CLAIM_MS`는 자동으로 따라간다.

## 매 배포마다

- [ ] **새 D1 마이그레이션이 있으면 배포 전에 먼저 원격에 적용한다.** 순서는 `npx wrangler d1 migrations apply promo-agent --remote` → `npm run deploy`.
  - 앱을 마이그레이션보다 먼저 배포하면 안 된다. drizzle이 스키마의 모든 칸을 SELECT해서, 새 칸이 아직 없으면 글 페이지가 전부 실패한다.
  - 이번 배포에 필요한 것: `0003_draft_ready_alert.sql` (`posts.draft_notified_at` 칸 추가).

## 견적 에이전트 (2026-11-09 배포)

순서: 원격 마이그레이션 → 비공개 시드 → npm run deploy

- [ ] **새 Workflow 바인딩**: `wrangler.jsonc`의 `QUOTE_GENERATE` (`quote-generate`, `QuoteGenerateWorkflow`). `npm run deploy`가 같이 만든다. 배포 결과의 Bindings 목록에 `env.QUOTE_GENERATE`가 보이는지 확인한다.
- [ ] **호환 플래그**: `nodejs_compat` (엑셀 `exceljs`가 필요로 한다). `nodejs_als`를 포함한다.
- [ ] **마이그레이션 `0004_quote_agent.sql`** (표 6개 추가: `quotes`, `quote_versions`, `price_items`, `competitor_events`, `competitor_prices`, `watch_sources`). 배포 전에 먼저 `npx wrangler d1 migrations apply promo-agent --remote`. 추가만 하는 마이그레이션이라 기존 화면은 영향이 없다.
- [ ] **비공개 시드** (`private/seed-quote-2026-11-09.sql`, git에 올리지 않는다): `npx wrangler d1 execute promo-agent --remote --file private/seed-quote-2026-11-09.sql`
  - 다시 실행해도 안전하다. 가격 항목은 같은 이름이 없을 때만 넣고(사장님이 고친 값은 남는다), 소개 문구와 기본 제공 사항은 덮어쓴다.
  - 가격 항목은 모두 `needs_confirm = 1`이다. 사장님이 앱의 가격표에서 저장하면 확인된 것으로 바뀐다.
  - 소개 문구는 분석 문서에 일부만 있어서 사장님 확인이 필요하다. 발신 정보(`quote_sender`)는 넣지 않는다 (기본값 스톤테이블, 사업자 등록 후 설정에서 입력).
- [ ] **실제 확인**: `npx wrangler tail`을 켜 두고, 가짜 문의로 견적을 만든다 → 수정 요청으로 v2 → 엑셀 받기(200, `filename*`) → 테스트 견적 지우기. 2026-11-09 실측: v1 약 16초(입력 5,973 / 출력 748 토큰), v2 약 17초(캐시 읽기 5,195 토큰), 두 번 합쳐 약 $0.07.

## 경쟁 업체 감시 (2026-11-09 배포)

순서: 원격 마이그레이션 → 비공개 감시 목록 시드 → npm run deploy

- [ ] **마이그레이션 `0005_competitor_event_notes.sql`** (`competitor_events.notes` 칸 추가). 추가만 하는 마이그레이션. 배포 전에 먼저 `npx wrangler d1 migrations apply promo-agent --remote`.
- [ ] **새 Workflow 바인딩**: `WATCH` (`watch`, `WatchWorkflow`). 크론 `0 18 * * *` (UTC, 한국 시간 새벽 3시)이 매일 감시를 시작한다. 배포 결과의 Bindings와 schedule 목록에서 확인한다.
- [ ] **비공개 시드** (`private/seed-watch-2026-11-09.sql`, git에 올리지 않는다): `npx wrangler d1 execute promo-agent --remote --file private/seed-watch-2026-11-09.sql`
  - 다시 실행해도 안전하다. 같은 주소가 이미 있으면 넣지 않는다.
  - 경쟁 업체 이름과 주소는 이 파일과 DB에만 있다. 저장소에는 올리지 않는다.
- [ ] **실제 확인**: 로그인 후 `/competitors`에서 "지금 한 번 돌리기" → `npx wrangler tail`로 `watch source N: ok, ... calls, ... added` 로그와 `claude usage`를 본다. 한 번 돌릴 때 Claude 호출은 최대 30번(`WATCH_RUN_BUDGET`), 글 하나당 1번이다. 수동 실행은 같은 한국 시간 1시간 안에서 한 번만 시작된다.
  - 가격 페이지(출처당 최대 1번)를 먼저 돌리고, 남은 호출을 RSS 출처들이 나눠 쓴다(남은 수 ÷ 아직 안 돈 RSS 출처 수, 올림). 첫 실행처럼 밀린 글이 많으면 출처마다 일부만 읽고 나머지는 다음 실행에서 읽는다. 호출이 바닥나 건너뛴 출처는 감시 목록에 "예산이 모자라 이번엔 건너뛰었어요"가 보인다. 평소(크론)에는 새 글만 읽어서 호출이 적다.
  - 2026-11-09 실측: 1회차 30번 약 $0.32 (앞 출처 3개만 돎), 2회차 12번 약 $0.22 (나머지 5개). 합쳐 소식 31개, 가격 15개. 출처 8개 중 6개 ok, 2개는 상대 사이트 문제로 error (글자 없는 페이지, 상대 인증서 오류 HTTP 526).
- [ ] 다음 날 새벽 3시 크론이 돈 뒤 `SELECT name, last_status, last_error, last_run_at FROM watch_sources`로 출처마다 `last_run_at`이 갱신됐는지 본다.
