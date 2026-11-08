// Kakao REST calls used for '나에게 보내기'. `fetch` is passed in so tests can stand in for Kakao.
// Docs: https://developers.kakao.com/docs/ko/kakaologin/rest-api,
// https://developers.kakao.com/docs/ko/kakaotalk-message/rest-api

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type KakaoConfig = {
  restKey: string;
  clientSecret: string;
  redirectUri: string;
};

export type Tokens = {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Only present when Kakao issued a new one (always on login, on refresh only when rotated). */
  refreshToken: string | undefined;
  refreshExpiresIn: number | undefined;
};

export type MemoMessage = { text: string; url: string; buttonTitle?: string };

/** Kakao caps the text template at 200 characters. */
export const MEMO_TEXT_LIMIT = 200;

const KAUTH = "https://kauth.kakao.com";
const KAPI = "https://kapi.kakao.com";
const FORM = "application/x-www-form-urlencoded;charset=utf-8";

export class KakaoError extends Error {
  constructor(
    readonly status: number,
    /** KOE… code for login errors, the numeric API code (e.g. "-401") for API errors. */
    readonly code: string,
    message: string,
    /** The refresh token (or code) is no longer valid; only a new login fixes it. */
    readonly invalidGrant = false,
  ) {
    super(message);
    this.name = "KakaoError";
  }
}

async function call(fetch: Fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Kakao answers JSON; anything else is a gateway page.
  }
  if (res.ok) return body;
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const code = str(body.error_code) ?? str(body.code) ?? str(body.error) ?? `HTTP_${res.status}`;
  const message = str(body.error_description) ?? str(body.msg) ?? (text.slice(0, 200) || res.statusText);
  throw new KakaoError(res.status, code, message, body.error === "invalid_grant");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function tokensFrom(body: Record<string, unknown>): Tokens {
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new KakaoError(200, "BAD_RESPONSE", "카카오 토큰 응답에 access_token이 없습니다.");
  }
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    refreshExpiresIn: num(body.refresh_token_expires_in),
  };
}

export function authorizeUrl(cfg: KakaoConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.restKey,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "talk_message",
    state,
  });
  return `${KAUTH}/oauth/authorize?${params}`;
}

function postToken(fetch: Fetch, params: Record<string, string>) {
  return call(fetch, `${KAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": FORM },
    body: new URLSearchParams(params).toString(),
  });
}

export async function exchangeCode(
  cfg: KakaoConfig,
  code: string,
  fetch: Fetch,
): Promise<Tokens & { scopes: string[] }> {
  const body = await postToken(fetch, {
    grant_type: "authorization_code",
    client_id: cfg.restKey,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code,
  });
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [];
  return { ...tokensFrom(body), scopes };
}

export async function refreshAccessToken(cfg: KakaoConfig, refreshToken: string, fetch: Fetch): Promise<Tokens> {
  const body = await postToken(fetch, {
    grant_type: "refresh_token",
    client_id: cfg.restKey,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
  });
  return tokensFrom(body);
}

/** Kakao member number of the token's owner (needs no extra consent item). */
export async function tokenInfo(accessToken: string, fetch: Fetch): Promise<{ id: string }> {
  const body = await call(fetch, `${KAPI}/v1/user/access_token_info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (body.id === undefined) throw new KakaoError(200, "BAD_RESPONSE", "카카오 회원번호를 받지 못했습니다.");
  return { id: String(body.id) };
}

/** Sends a text message to the token owner's '나와의 채팅'. */
export async function sendMemo(accessToken: string, msg: MemoMessage, fetch: Fetch): Promise<void> {
  if ([...msg.text].length > MEMO_TEXT_LIMIT) {
    throw new Error(`Kakao memo text is over ${MEMO_TEXT_LIMIT} characters`);
  }
  const template = {
    object_type: "text",
    text: msg.text,
    link: { web_url: msg.url, mobile_web_url: msg.url },
    ...(msg.buttonTitle ? { button_title: msg.buttonTitle } : {}),
  };
  await call(fetch, `${KAPI}/v2/api/talk/memo/default/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": FORM },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }).toString(),
  });
}
