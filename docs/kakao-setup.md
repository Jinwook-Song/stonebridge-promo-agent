# 카카오톡 알림

사장님 카톡 '나와의 채팅'으로 알림을 보낸다: **매일 23:20 쿠팡 발주 알림**, **매달 정한 날 10:00 홍보글 알림**. 카카오 REST API **나에게 보내기**(`POST https://kapi.kakao.com/v2/api/talk/memo/default/send`)를 쓴다. 아래 "되는가"는 2026-11-08에 문서로 확인한 내용이다. 코드 설계: [plans/2026-11-08-kakao-alerts.md](superpowers/plans/2026-11-08-kakao-alerts.md).

## 앱에서 (콘솔 설정 뒤)

1. 키 두 개를 넣고 배포한다:
   ```bash
   npx wrangler secret put KAKAO_REST_KEY
   npx wrangler secret put KAKAO_CLIENT_SECRET
   npx wrangler d1 migrations apply promo-agent --remote
   npm run deploy
   ```
   키가 없으면 설정 화면에 "키 미설정"이 뜨고 알림은 안 간다 (배포는 된다).
2. **설정 > 카톡 알림 > 카카오 계정 연결**. 카카오 로그인에서 '카카오톡 메시지 전송'에 동의한다.
3. **시험 보내기** → 카톡 '나와의 채팅'에 메시지가 오는지, 버튼을 누르면 앱이 열리는지 본다. 실패하면 카카오 에러 코드가 그대로 뜬다.
4. 발주 알림 / 홍보글 알림을 켠다. **기본은 꺼짐**이다.
5. 받는 사람은 **마지막에 연결한 계정 하나**다. 개발자가 자기 계정으로 시험한 뒤, 사장님이 사장님 폰에서 같은 화면의 **다른 계정으로 다시 연결**을 누르면 사장님으로 바뀐다.
6. 2개월 넘게 알림이 하나도 안 나가 리프레시 토큰이 만료되면 "다시 연결 필요"가 뜬다. 다시 연결하면 된다.

알림 기록은 설정 화면 '최근 알림'에 남는다 (실패 이유 포함). 실패한 알림은 다시 보내지 않는다.

## 되는가

- 된다. 나에게 보내기는 **권한 신청이 필요 없다**. 동의항목만 설정하면 된다. 카카오 직원 답변: [2025-10-13](https://devtalk.kakao.com/t/topic/146679), [2026-07-08](https://devtalk.kakao.com/t/topic/150575).
- 보내는 건수 제한이 없다. [문서](https://developers.kakao.com/docs/ko/kakaotalk-message/common)
- 비즈 앱이나 사업자 정보는 필요 없다. 비즈 앱이 필요한 건 친구 목록, 친구에게 보내기, 카카오싱크, 와일드카드 도메인이다. [문서](https://developers.kakao.com/docs/ko/app-setting/app)
- 정책: 금지는 아니다. 다만 카카오는 서비스가 사용자에게 보내는 알림에는 알림톡을 권한다. 여기서는 보내는 사람과 받는 사람이 같은 사장님 본인이고, 사장님이 직접 동의한다. [문서](https://developers.kakao.com/docs/ko/kakaotalk-message/common)

## 콘솔 설정 (개발자가 developers.kakao.com에서)

1. 앱을 만들고 **카카오 로그인**을 켠다. 메뉴 이름은 [카카오 로그인] > [사용 설정] 또는 [일반]이다 (문서마다 다르다).
2. [앱] > [플랫폼 키] > **REST API 키**를 복사한다. 같은 화면에 **리다이렉트 URI**를 등록한다: `https://stonebridge-promo.wlsdnr129.workers.dev/kakao/callback`. 프로토콜과 끝의 `/`까지 정확히 맞아야 한다.
3. 같은 화면의 **클라이언트 시크릿**은 기본으로 켜져 있다. 켜져 있으면 토큰 요청과 갱신 요청에 둘 다 넣어야 한다.
4. [카카오 로그인] > [동의항목] > **카카오톡 메시지 전송**(`talk_message`)을 **선택 동의**로 설정하고 목적을 적는다. 로그인 주소에 `scope=talk_message`를 넣는다. 동의가 없으면 보내기가 `-402`로 실패한다.
5. [앱] > [제품 링크 관리] > **웹 도메인**에 `https://stonebridge-promo.wlsdnr129.workers.dev`를 등록한다. 메시지 안의 링크는 등록된 도메인만 쓸 수 있다.
   - **확인 필요:** 콘솔이 하위 도메인을 잘라 `workers.dev`로 저장하는지 본다. 그러면 Worker에 커스텀 도메인을 붙인다.
6. [앱] > [멤버]에 **사장님 카카오 계정을 멤버로 추가**한다 (뷰어면 된다).
   - **확인 필요:** '제한된 기능'이 앱 멤버에게만 동작한다는 문구가 있는데, 나에게 보내기에도 해당하는지는 문서에 없다. 멤버로 넣어 두면 이 위험이 없다.
7. 사장님이 한 번 로그인하고 시험 메시지를 받아 본다.

## 토큰 (코드 만들 때)

- 액세스 토큰: REST API 기준 **6시간**.
- 리프레시 토큰: **2개월**. 남은 기간이 1개월 미만일 때 갱신하면 새 리프레시 토큰이 오고, 옛 토큰은 무효가 된다. 새 토큰이 응답에 있을 때마다 바로 저장해야 한다 (D1에 한 번에 쓰기).
- 매일 23:20 발주 알림을 보내면 토큰이 계속 갱신된다. 2개월 넘게 아무것도 보내지 않으면 사장님이 다시 로그인해야 한다.

출처: [토큰](https://developers.kakao.com/docs/ko/kakaologin/common), [REST API](https://developers.kakao.com/docs/ko/kakaologin/rest-api), [동의항목](https://developers.kakao.com/docs/ko/kakaologin/utilize#scope-feature), [메시지 템플릿 튜토리얼](https://developers.kakao.com/docs/ko/tutorial/custom-msg-template).
