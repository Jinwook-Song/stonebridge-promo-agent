import { useEffect } from "react";
import { useRevalidator } from "react-router";

const EVERY_MS = 2000;
const MAX_BACKOFF_MS = 15000;

type PollOptions = { url?: string; everyMs?: number };

/**
 * While `active`, asks /api/posts/:id/status (or `options.url`) every 2 s (or `options.everyMs`).
 * When the post stops generating (or the reply says `stale: true`: nobody is making it any more)
 * it revalidates once and stops; if the reloaded page still says generating, the effect starts
 * again (it re-runs when the revalidation settles). Pauses while the tab is hidden (phone
 * locked, other app) and polls at once when it comes back; backs off on network errors;
 * stops on unmount.
 */
export function useStatusPolling(postId: number, active: boolean, options: PollOptions = {}) {
  const { url = `/api/posts/${postId}/status`, everyMs = EVERY_MS } = options;
  const revalidator = useRevalidator();
  const { revalidate } = revalidator;
  const idle = revalidator.state === "idle";

  useEffect(() => {
    if (!active || !idle) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;
    let delay = everyMs;

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = setTimeout(poll, delay);
    };

    // Once per transition: no further polls (and so no second revalidate) from this run.
    function finish() {
      stopped = true;
      clearTimeout(timer);
      void revalidate();
    }

    async function poll() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (stopped) return;
        // A redirect means the session ended (login page): the reload sends her there.
        if (res.redirected || res.status === 401 || res.status === 404) return finish();
        if (res.ok && res.headers.get("Content-Type")?.includes("application/json")) {
          const { status, stale } = (await res.json()) as { status: string; stale?: boolean };
          if (stopped) return;
          if (status !== "generating" || stale === true) return finish();
          delay = everyMs;
        } else {
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
      } catch {
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      } finally {
        inFlight = false;
      }
      schedule();
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        delay = everyMs;
        void poll();
      } else {
        clearTimeout(timer);
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, everyMs, active, idle, revalidate]);
}
