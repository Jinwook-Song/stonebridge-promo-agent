import { env } from "cloudflare:workers";
import { CircleAlertIcon } from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { CheckerBand, LogoMark } from "../components/Logo";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Field } from "../components/ui/label";
import { attemptLogin, ensureOwnerPassword } from "../server/auth.server";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";
import { getOwnerSessionStorage } from "../server/session.server";

// Never cache the login page or its responses (back button after logout, shared computers).
export const middleware: Route.MiddlewareFunction[] = [
  async (_args, next) => {
    const response = await next();
    response.headers.set("Cache-Control", "no-store");
    return response;
  },
];

export function meta({}: Route.MetaArgs) {
  return [{ title: "스톤브릿지 홍보글" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getOwnerSessionStorage(env).getSession(request.headers.get("Cookie"));
  if (session.get("owner") === true) throw redirect("/");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const db = getDb(env.DB);

  try {
    await ensureOwnerPassword(db, env.OWNER_INITIAL_PASSWORD);
    const ok = await attemptLogin(db, ip, password, new Date());
    if (!ok) return { error: "비밀번호가 올바르지 않아요." };
  } catch (e) {
    if (e instanceof DomainError && e.code === "RATE_LIMITED") {
      return { error: e.message };
    }
    throw e;
  }

  const storage = getOwnerSessionStorage(env);
  const session = await storage.getSession(request.headers.get("Cookie"));
  session.set("owner", true);
  return redirect("/", { headers: { "Set-Cookie": await storage.commitSession(session) } });
}

export default function Login({ actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <Backdrop />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark className="size-16 shadow-md rounded-[1.1rem]" />
          <div>
            <p className="text-2xl font-extrabold tracking-[0.08em] text-primary">STONE BRIDGE</p>
            <p className="mt-1 text-sm text-muted-foreground">홍보글 에이전트</p>
          </div>
        </div>
        <Card className="p-5 shadow-sm">
          <h1 className="mb-4 font-semibold">사장님 로그인</h1>
          <Form method="post" className="flex flex-col gap-4">
            <Field label="비밀번호" htmlFor="password">
              <Input
                id="password"
                type="password"
                name="password"
                autoFocus
                required
                autoComplete="current-password"
                className="h-11"
              />
            </Field>
            {actionData?.error && (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
                {actionData.error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={busy}>
              로그인
            </Button>
          </Form>
        </Card>
      </div>
    </main>
  );
}

/** Faint checkerboard from the shop's badge, fading down (decoration only). */
function Backdrop() {
  return (
    <CheckerBand className="absolute inset-x-0 top-0 h-64 text-primary/[0.05] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
  );
}
