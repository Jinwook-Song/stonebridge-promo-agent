import { and, eq } from "drizzle-orm";
import { kakaoLink } from "../../database/schema";
import type { Db } from "../server/db";
import {
  exchangeCode,
  KakaoError,
  refreshAccessToken,
  sendMemo,
  tokenInfo,
  type Fetch,
  type KakaoConfig,
  type MemoMessage,
} from "./client.server";

export type KakaoLinkRow = typeof kakaoLink.$inferSelect;

/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const LINK_ID = 1;

export type LinkProblem = "not_configured" | "not_linked" | "needs_relogin" | "no_consent";

/** Something only she (or the developer) can fix; never retried. */
export class KakaoLinkError extends Error {
  constructor(
    readonly problem: LinkProblem,
    message: string,
  ) {
    super(message);
    this.name = "KakaoLinkError";
  }
}

export function kakaoConfig(env: {
  KAKAO_REST_KEY?: string;
  KAKAO_CLIENT_SECRET?: string;
  PUBLIC_ORIGIN: string;
}): KakaoConfig | null {
  const restKey = env.KAKAO_REST_KEY?.trim();
  const clientSecret = env.KAKAO_CLIENT_SECRET?.trim();
  if (!restKey || !clientSecret) return null;
  return { restKey, clientSecret, redirectUri: `${env.PUBLIC_ORIGIN.replace(/\/+$/, "")}/kakao/callback` };
}

export async function getLink(db: Db): Promise<KakaoLinkRow | undefined> {
  const [row] = await db.select().from(kakaoLink).where(eq(kakaoLink.id, LINK_ID));
  return row;
}

const at = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();

/**
 * Finishes a Kakao login: swaps the code for tokens and makes this account the alert recipient,
 * replacing whoever was connected before.
 */
export async function connect(
  db: Db,
  cfg: KakaoConfig,
  code: string,
  now: Date,
  fetch: Fetch,
): Promise<KakaoLinkRow> {
  const tokens = await exchangeCode(cfg, code, fetch);
  // Kakao lists the granted scopes; without talk_message every send fails with -402.
  if (tokens.scopes.length > 0 && !tokens.scopes.includes("talk_message")) {
    throw new KakaoLinkError("no_consent", "카카오톡 메시지 전송에 동의해야 알림을 받을 수 있어요.");
  }
  if (!tokens.refreshToken || tokens.refreshExpiresIn === undefined) {
    throw new KakaoError(200, "BAD_RESPONSE", "카카오 로그인 응답에 refresh_token이 없습니다.");
  }
  const { id } = await tokenInfo(tokens.accessToken, fetch);
  const row = {
    id: LINK_ID,
    kakaoUserId: id,
    accessToken: tokens.accessToken,
    accessExpiresAt: at(now, tokens.expiresIn),
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: at(now, tokens.refreshExpiresIn),
    linkedAt: now.toISOString(),
    needsRelogin: false,
    lastError: null,
  };
  const { id: _id, ...update } = row;
  const [saved] = await db
    .insert(kakaoLink)
    .values(row)
    .onConflictDoUpdate({ target: kakaoLink.id, set: update })
    .returning();
  return saved;
}

export async function disconnect(db: Db): Promise<void> {
  await db.delete(kakaoLink).where(eq(kakaoLink.id, LINK_ID));
}

function usable(link: KakaoLinkRow): KakaoLinkRow {
  if (link.needsRelogin) {
    throw new KakaoLinkError("needs_relogin", "카카오 연결이 끊겼어요. 설정에서 다시 연결해 주세요.");
  }
  return link;
}

async function requireLink(db: Db): Promise<KakaoLinkRow> {
  const link = await getLink(db);
  if (!link) throw new KakaoLinkError("not_linked", "카카오 계정이 연결되어 있지 않아요.");
  return usable(link);
}

/**
 * A valid access token, refreshing it when it is about to expire (or `force`, after Kakao said
 * -401). Kakao may rotate the refresh token, which revokes the old one, so the new pair is
 * written in one statement guarded by the old refresh token: if another request rotated first,
 * nothing is written and its tokens are used instead.
 */
export async function getAccessToken(
  db: Db,
  cfg: KakaoConfig,
  now: Date,
  fetch: Fetch,
  force = false,
): Promise<string> {
  const link = await requireLink(db);
  const left = new Date(link.accessExpiresAt).getTime() - now.getTime();
  if (!force && left > REFRESH_MARGIN_MS) return link.accessToken;

  let tokens;
  try {
    tokens = await refreshAccessToken(cfg, link.refreshToken, fetch);
  } catch (e) {
    if (!(e instanceof KakaoError && e.invalidGrant)) throw e;
    // A concurrent refresh may have rotated the token we used; that is not a broken link.
    const latest = await requireLink(db);
    if (latest.refreshToken !== link.refreshToken) return latest.accessToken;
    await db
      .update(kakaoLink)
      .set({ needsRelogin: true, lastError: `${e.code}: ${e.message}` })
      .where(and(eq(kakaoLink.id, LINK_ID), eq(kakaoLink.refreshToken, link.refreshToken)));
    throw new KakaoLinkError("needs_relogin", "카카오 연결이 만료됐어요. 설정에서 다시 연결해 주세요.");
  }

  const updated = await db
    .update(kakaoLink)
    .set({
      accessToken: tokens.accessToken,
      accessExpiresAt: at(now, tokens.expiresIn),
      ...(tokens.refreshToken && tokens.refreshExpiresIn !== undefined
        ? { refreshToken: tokens.refreshToken, refreshExpiresAt: at(now, tokens.refreshExpiresIn) }
        : {}),
      lastError: null,
    })
    .where(and(eq(kakaoLink.id, LINK_ID), eq(kakaoLink.refreshToken, link.refreshToken)))
    .returning({ id: kakaoLink.id });
  if (updated.length === 0) {
    // Someone else rotated (or reconnected) meanwhile; theirs is the pair Kakao now honours.
    return (await requireLink(db)).accessToken;
  }
  return tokens.accessToken;
}

/** Sends to the connected account's '나와의 채팅'. On -401 refreshes once and retries once. */
export async function sendToMe(
  db: Db,
  cfg: KakaoConfig,
  msg: MemoMessage,
  now: Date,
  fetch: Fetch,
): Promise<void> {
  const token = await getAccessToken(db, cfg, now, fetch);
  try {
    await sendMemo(token, msg, fetch);
  } catch (e) {
    if (!(e instanceof KakaoError && e.code === "-401")) throw e;
    await sendMemo(await getAccessToken(db, cfg, now, fetch, true), msg, fetch);
  }
}

/** One line for the settings page / alert log, keeping Kakao's own code for debugging. */
export function describeKakaoError(e: unknown): string {
  if (e instanceof KakaoLinkError) return e.message;
  if (e instanceof KakaoError) {
    const hint: Record<string, string> = {
      "-402": "카카오톡 메시지 동의가 없어요. 다시 연결하고 동의해 주세요.",
      "-501": "카카오톡을 쓰지 않는 계정이에요.",
      "-401": "카카오 로그인이 만료됐어요. 다시 연결해 주세요.",
      "-2": "요청 형식 오류예요.",
      KOE006: "콘솔에 등록된 리다이렉트 URI와 다릅니다.",
      KOE010: "클라이언트 시크릿이 틀렸어요.",
      KOE101: "REST API 키가 틀렸어요.",
    };
    return `${hint[e.code] ?? "카카오 오류예요."} (${e.code}: ${e.message})`;
  }
  return e instanceof Error ? e.message : String(e);
}
