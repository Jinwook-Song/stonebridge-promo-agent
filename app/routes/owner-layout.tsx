import { env } from "cloudflare:workers";
import { LogOutIcon } from "lucide-react";
import { Form, Link, NavLink, Outlet } from "react-router";
import type { Route } from "./+types/owner-layout";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { requireOwner } from "../server/auth.server";

// Middleware runs for every matched child loader AND action (including
// `.data?_routes=` single-fetch requests and no-JS document POSTs), unlike a
// layout loader, which child requests can skip. The loader check is kept as
// defence in depth.
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request }, next) => {
    await requireOwner(request, env);
    // Posts must not come back from the bfcache / HTTP cache after logout.
    const response = await next();
    response.headers.set("Cache-Control", "no-store");
    return response;
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  await requireOwner(request, env);
  return null;
}

const LINKS = [
  { to: "/", label: "글 목록", end: true },
  { to: "/settings", label: "설정", end: false },
];

export default function OwnerLayout() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
          <Link to="/" aria-label="글 목록으로">
            <Logo sub="홍보글" />
          </Link>
          <Form method="post" action="/logout">
            <Button type="submit" variant="ghost" className="h-11 text-muted-foreground">
              <LogOutIcon aria-hidden="true" />
              로그아웃
            </Button>
          </Form>
        </div>
        <nav className="flex gap-1 px-3 pb-2" aria-label="메뉴">
          {LINKS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex h-11 flex-1 items-center justify-center rounded-md text-sm font-medium transition-colors",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Outlet />
      </main>
    </div>
  );
}
