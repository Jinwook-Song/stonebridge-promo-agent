import { useEffect } from "react";
import { useRevalidator } from "react-router";

const EVERY_MS = 2000;
const MAX_BACKOFF_MS = 15000;

/**
 * While `active`, asks /api/posts/:id/status every 2 s and revalidates the page once the post is
 * no longer generating. Stops while the tab is hidden (phone locked, other app) and polls at
 * once when it comes back; backs off on network errors; stops on unmount.
 */
export function useStatusPolling(postId: number, active: boolean) {
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;
    let delay = EVERY_MS;

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = setTimeout(poll, delay);
    };

    async function poll() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/posts/${postId}/status`, { headers: { Accept: "application/json" } });
        // A redirect means the session ended (login page): let the loader send her there.
        if (res.redirected || res.status === 401 || res.status === 404) {
          finish();
          return;
        }
        if (res.ok && res.headers.get("Content-Type")?.includes("application/json")) {
          const { status } = (await res.json()) as { status: string };
          if (status !== "generating") finish();
          else delay = EVERY_MS;
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

    // Revalidate and keep going at the normal pace: the effect is cleaned up once the loader
    // says the post is no longer generating, and keeps polling if it somehow still is.
    function finish() {
      delay = EVERY_MS;
      void revalidate();
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
  }, [postId, active, revalidate]);
}
