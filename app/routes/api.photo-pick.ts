import { env } from "cloudflare:workers";
import type { Route } from "./+types/api.photo-pick";
import { makeClaudeCalls, makeFakeClaudeCalls } from "../promo/claude.server";
import { handlePhotoPick } from "../promo/photo-pick-route.server";

// "AI로 고르기" on the new-post form. Inside the owner layout, so its middleware checks the
// session and adds Cache-Control: no-store. Synchronous: no Workflow, the form waits for it.
export async function action({ request }: Route.ActionArgs) {
  // Typed as its wrangler.jsonc default ("0"); only a local .dev.vars turns it on.
  const fakeClaude: string = env.FAKE_CLAUDE;
  const calls = fakeClaude === "1" ? makeFakeClaudeCalls() : makeClaudeCalls(env.ANTHROPIC_API_KEY);
  return handlePhotoPick(request, { pick: calls.pick });
}
