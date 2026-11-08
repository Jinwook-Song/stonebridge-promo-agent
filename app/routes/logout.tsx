import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { getOwnerSessionStorage } from "../server/session.server";

export function loader() {
  return redirect("/login");
}

export async function action({ request }: Route.ActionArgs) {
  const storage = getOwnerSessionStorage(env);
  const session = await storage.getSession(request.headers.get("Cookie"));
  return redirect("/login", { headers: { "Set-Cookie": await storage.destroySession(session) } });
}
