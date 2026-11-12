import { z } from "zod";
import { KIND_LABELS, type PostKind } from "../promo/types";

/** Public demo only: is this memo material for a shop's promo post at all? */
export const TopicCheck = z.object({
  related: z.boolean(),
  /** One short Korean sentence, shown to the visitor when related is false. */
  reason: z.string(),
});
export type TopicCheck = z.infer<typeof TopicCheck>;

export const TOPIC_CHECK_SYSTEM = `너는 디저트 가게 홍보글 에이전트의 입력 검사기야. 사장님이 쓴 메모가 가게 홍보글(블로그·인스타·당근·플레이스)의 재료인지만 판단해.

관련 있음 (related: true):
- 단체 주문 사례, 상품·시즌 메뉴 안내, 가게 소식(영업시간, 휴무, 이벤트, 포장, 배달, 행사 납품).
- 아주 짧거나 맞춤법이 틀린 메모도 가게 일이면 관련 있음. 예: "마카롱 20세트", "휘낭시에 신메뉴", "OO학교 40개 리본".
- 애매하면 관련 있음으로 판단해. 사장님 메모를 잘못 막는 것이 더 나빠.

관련 없음 (related: false):
- 가게·상품·주문·행사와 상관없는 질문이나 요청. 예: 날씨, 주식·코인, 코딩, 숙제, 일반 상식 질문, 다른 업종의 글, 홍보글이 아닌 글(소설, 시, 번역) 요청.

reason: 관련 없을 때만, 왜 홍보글로 쓸 수 없는지 한 문장 (한국어, 존댓말). 관련 있으면 빈 문자열.`;

export function topicCheckUser(memo: string, kind: PostKind): string {
  return `글 종류: ${KIND_LABELS[kind]}\n<메모>\n${memo}\n</메모>`;
}
