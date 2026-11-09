import { env } from "cloudflare:workers";
import { CircleAlertIcon } from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/quote-new";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { startQuoteGeneration } from "../quote/generate.server";
import { createQuote } from "../quote/quotes.server";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

export const handle = { wide: true };

export function meta({}: Route.MetaArgs) {
  return [{ title: "새 견적 · 스톤브릿지 홍보글" }];
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const db = getDb(env.DB);
  try {
    const { quoteId } = await createQuote(db, { text: String(form.get("text") ?? ""), source: "app" }, new Date());
    // The quote exists now: whatever happens to the start, go to it rather than letting her
    // submit again and make a duplicate. A failed start is recorded on the version itself.
    try {
      await startQuoteGeneration(env, db, quoteId, 1);
    } catch (e) {
      console.error("startQuoteGeneration failed after createQuote", { quoteId, error: e });
    }
    return redirect(`/quotes/${quoteId}`);
  } catch (e) {
    if (e instanceof DomainError && e.code === "INVALID_INPUT") return { error: e.message };
    throw e;
  }
}

export default function QuoteNew({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <Form method="post" className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold">새 견적</h1>
      <Field label="문의 내용" htmlFor="text" hint="통화 메모나 문의 메일을 그대로 붙여 넣어도 돼요. 몇 분 걸릴 수 있어요.">
        <Textarea
          id="text"
          name="text"
          rows={12}
          required
          disabled={busy}
          placeholder="통화 메모나 문의 메일을 붙여 넣으세요"
          className="min-h-64"
        />
      </Field>
      {actionData?.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{actionData.error}</span>
        </p>
      )}
      <Button type="submit" size="lg" className="h-12" disabled={busy}>
        {busy ? "만드는 중…" : "만들기"}
      </Button>
    </Form>
  );
}
