import { useEffect } from "react";
import { useRevalidator } from "react-router";

const EVERY_MS = 2000;
const MAX_BACKOFF_MS = 15000;

/**
 * While `active`, asks /api/posts/:id/status every 2 s. When the post stops generating it
 * revalidates once and stops; if the reloaded page still says generating, the effect starts
 * again (it re-runs when the revalidation settles). Pauses while the tab is hidden (phone
 * locked, other app) and polls at once when it comes back; backs off on network errors;
 * stops on unmount.
 */
export function useStatusPolling(postId: number, active: boolean) {
  const revalidator = useRevalidator();
  const { revalidate } = revalidator;
  const idle = revalidator.state === "idle";

  useEffect(() => {
    if (!active || !idle) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;
    let delay = EVERY_MS;

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
        const res = await fetch(`/api/posts/${postId}/status`, { headers: { Accept: "application/json" } });
        if (stopped) return;
        // A redirect means the session ended (login page): the reload sends her there.
        if (res.redirected || res.status === 401 || res.status === 404) return finish();
        if (res.ok && res.headers.get("Content-Type")?.includes("application/json")) {
          const { status } = (await res.json()) as { status: string };
          if (stopped) return;
          if (status !== "generating") return finish();
          delay = EVERY_MS;
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
        delay = EVERY_MS;
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
  }, [postId, active, idle, revalidate]);
}
