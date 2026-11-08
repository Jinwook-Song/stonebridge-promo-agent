// Optional secrets: kept out of wrangler.jsonc `secrets.required` so the Worker still deploys before
// the Kakao app exists. Without them the settings page shows "키 미설정" and no alert is sent.
declare global {
  namespace Cloudflare {
    interface Env {
      KAKAO_REST_KEY?: string;
      KAKAO_CLIENT_SECRET?: string;
    }
  }
}

export {};
