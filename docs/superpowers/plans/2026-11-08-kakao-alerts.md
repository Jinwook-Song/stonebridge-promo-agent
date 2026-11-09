# 카카오톡 알림 (나에게 보내기) 계획

2026-11-08. 사장님 카톡 '나와의 채팅'으로 두 가지 알림을 보낸다: 매일 23:20 쿠팡 발주 알림, 매달 정한 날 10:00 홍보글 알림. 설정 화면에서 켜고 끈다. 콘솔 설정은 `docs/kakao-setup.md`.

## 결정

- **받는 사람 = 마지막으로 연결한 카카오 계정.** `kakao_link`는 한 줄(id=1)만 둔다. 개발자 계정으로 먼저 시험하고, 사장님이 같은 화면에서 다시 연결하면 받는 사람이 바뀐다.
- **알림은 기본 꺼짐.** 연결만으로 매일 밤 알림이 시작되지 않는다.
- **키는 선택 secret.** `KAKAO_REST_KEY`, `KAKAO_CLIENT_SECRET`은 `secrets.required`에 넣지 않는다 (넣으면 키 없이 배포가 막힌다). 없으면 설정 화면에 "키 미설정"이 뜬다.
- **크론은 UTC.** `20 14 * * *` = 23:20 KST (발주), `0 1 * * *` = 10:00 KST (홍보글; 날짜는 코드에서 KST 기준으로 비교, 그 달에 없는 날이면 말일).
- **중복 방지.** `alert_log(kind, period_key)` UNIQUE에 먼저 넣고 보낸다. 크론이 두 번 돌아도 한 번만 간다. 실패해도 다시 보내지 않고 설정 화면에 남긴다.
- **토큰.** 액세스 5분 안에 만료되면 갱신한다. 갱신 응답의 새 리프레시 토큰은 `WHERE refresh_token = <옛 값>` 조건으로 한 번에 저장한다. 0줄이면 다른 요청이 먼저 갱신한 것이니 다시 읽는다. 보내기가 -401이면 갱신 후 한 번만 다시 보낸다. 리프레시가 거절되면(다른 요청이 먼저 바꾼 경우가 아니면) "다시 연결 필요"로 표시한다.
- **동의 확인.** 토큰 응답의 `scope`에 `talk_message`가 없으면 저장하지 않고 "동의 필요"로 돌려보낸다 (보낼 때 -402로 알게 되는 것보다 낫다).
- **회원번호.** `GET /v1/user/access_token_info`의 `id`만 쓴다 (닉네임은 동의항목을 더 받아야 해서 안 씀).
- **HTTP는 주입한 `fetch`로.** 테스트에서 카카오 서버를 흉내 낸다.

## 작업

1. 스키마: `kakao_link`, `alert_log` + drizzle 마이그레이션.
2. `app/kakao/client.server.ts`: authorize URL, 코드 교환, 갱신, token info, 나에게 보내기 (주입 fetch, KakaoError).
3. `app/kakao/link.server.ts`: 연결 저장/삭제, 액세스 토큰 얻기(갱신 포함), `sendToMe`.
4. `app/kakao/alerts.server.ts`: 알림 설정(settings 표), KST 날짜, `runScheduled(cron, now, env)`.
5. `workers/app.ts` `scheduled` + `wrangler.jsonc` 크론.
6. 라우트 `kakao/connect`, `kakao/callback` (owner layout 안, state 쿠키 10분).
7. 설정 화면 카톡 알림 칸: 상태, 연결/끊기, 시험 보내기(카카오 에러 코드 그대로 보여 줌), 알림 켜기/끄기, 날짜, 최근 알림 기록.
8. 문서: `docs/kakao-setup.md`, `docs/deploy-checklist.md`, `.dev.vars.example`.

## 나중

- 초안 완성 알림 (사장님 d2 "결과는 카톡"). 생성이 ~34초라 지금은 화면에서 기다림.
- ~~홍보글 알림을 한 달 두 번으로 (b2 "한 달에 한두 번").~~ 2026-11-09 완료: 두 번째 날짜(비우면 한 번), 날짜별로 한 번만 보냄.
