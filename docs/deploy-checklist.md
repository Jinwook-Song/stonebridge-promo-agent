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

- [ ] **`PUBLIC_ORIGIN`**: `wrangler.jsonc`의 `vars.PUBLIC_ORIGIN`을 실제 주소(예: `https://stonebridge-promo.<내 서브도메인>.workers.dev`)로 바꾼다. Claude가 이 주소로 서명된 사진 URL을 받아 간다.
  - 자리표시자(`example` 들어간 주소)나 잘못된 https 주소면 초안 만들기가 바로 실패하고 "앱 주소 설정(PUBLIC_ORIGIN)이 안 되어 있어요. 관리자에게 알려 주세요."가 뜬다 (재시도 없음).
  - workers.dev 주소는 첫 배포 뒤에 확정되므로, 모르면 한 번 배포하고 주소를 넣은 뒤 다시 배포한다.
- [ ] 비밀값 4개 (`npx wrangler secret put <이름>`):
  - `ANTHROPIC_API_KEY`
  - `SESSION_SECRET` — 32자 이상 (`openssl rand -base64 48`)
  - `OWNER_INITIAL_PASSWORD` — 8자 이상, 사장님께 따로 전달
  - `IMAGE_URL_SECRET` — 32자 이상 (`openssl rand -base64 48`)
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
- [ ] 한 채널을 **다시 쓰기** 한다 → 로그의 `claude usage`에서 `cache_read_input_tokens`가 0보다 큰지 확인한다 (시스템 프롬프트 캐시).
- [ ] 두 호출의 토큰 수(`input_tokens`, `cache_*`, `output_tokens`)와 걸린 시간을 적어 둔다.
- [ ] 시간이 단계 제한(15분, `STEP_TIMEOUT_MINUTES`)에 가깝거나 `max_tokens`로 잘리면 `app/promo/generate.server.ts`의 타임아웃 / `app/promo/claude.server.ts`의 `MAX_TOKENS`를 조정한다. 타임아웃을 바꾸면 `STALE_CLAIM_MS`는 자동으로 따라간다.
