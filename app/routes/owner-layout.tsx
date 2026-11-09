import { env } from "cloudflare:workers";
import { LogOutIcon } from "lucide-react";
import { Form, Link, Outlet, useLocation, useMatches, useNavigation } from "react-router";
import type { Route } from "./+types/owner-layout";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/button";
import { litTab } from "../lib/nav-tabs";
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
  { to: "/quotes", label: "견적", end: false },
  { to: "/competitors", label: "경쟁 업체", end: false },
  { to: "/settings", label: "설정", end: false },
];

export default function OwnerLayout() {
  // Routes with wide tables (the quote screens) ask for more room with `handle = { wide: true }`.
  const wide = useMatches().some((m) => (m.handle as { wide?: boolean } | undefined)?.wide === true);
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const pendingPathname = navigation.state === "loading" ? navigation.location.pathname : null;
  const lit = litTab(LINKS, pathname, pendingPathname);
  // Another page is on its way: the old one fades a little, only if the wait is noticeable. The
  // transition lives under data-leaving only, so the new page shows at full strength at once.
  const leaving = pendingPathname !== null && pendingPathname !== pathname;
  return (
    <div className={cn("mx-auto flex min-h-screen w-full flex-col", wide ? "max-w-4xl" : "max-w-xl")}>
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
          {LINKS.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              // Lit from the tap, not from the server's answer (see litTab).
              aria-current={lit === to ? "page" : undefined}
              className={cn(
                "flex h-11 flex-1 items-center justify-center rounded-md text-sm font-medium",
                lit === to ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>
      <main
        data-leaving={leaving || undefined}
        className="flex-1 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] data-[leaving]:opacity-50 data-[leaving]:transition-opacity data-[leaving]:delay-150"
      >
        <Outlet />
      </main>
    </div>
  );
}
