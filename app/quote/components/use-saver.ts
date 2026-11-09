import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

/** What the quote-detail action returns. */
export type QuoteActionResult = { ok?: true; error?: string; intent?: string };

/** Whether the server holds what the screen shows: a download now would carry older values otherwise. */
export type SyncState = "saved" | "saving" | "failed";

/** Tells `report` (e.g. the Excel button's guard) whenever a saver's SyncState changes; "saved" on unmount. */
export function useReportSync(saver: { pending: boolean; error: string | null }, report?: (state: SyncState) => void) {
  const state: SyncState = saver.pending ? "saving" : saver.error !== null ? "failed" : "saved";
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    reportRef.current?.(state);
  }, [state]);
  useEffect(() => () => reportRef.current?.("saved"), []);
}

/**
 * Saves one JSON value of the quote screen through its own fetcher, one request at a time: a
 * change made while a save is in flight waits for it and then sends the latest value, so the
 * server never ends up with an older value than the screen. Identical values are not re-sent.
 * The screen keeps its own copy of the value (optimistic); a failed save leaves it as typed and
 * reports `error`, and `retry()` sends it again.
 */
export function useJsonSaver(opts: {
  quoteId: number;
  intent: "saveLines" | "saveEvent" | "saveSender";
  field: "lines" | "event" | "sender";
  /** Sent along as `version` for the version-scoped intents. */
  version?: number;
  /** What the server holds now. */
  initial: unknown;
}) {
  const { quoteId, intent, field, version } = opts;
  const fetcher = useFetcher<QuoteActionResult>();
  const confirmed = useRef(JSON.stringify(opts.initial));
  const queued = useRef<string | null>(null);
  const sending = useRef<string | null>(null);
  const started = useRef(false);
  const last = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True from the moment a value is handed to save() until the server has it (or the save failed).
  const [pending, setPending] = useState(false);
  const submitRef = useRef<(data: Record<string, string>) => void>(() => {});
  submitRef.current = (data) => void fetcher.submit(data, { method: "post", action: `/quotes/${quoteId}` });

  function pump() {
    if (sending.current !== null || queued.current === null) return;
    const json = queued.current;
    queued.current = null;
    if (json === confirmed.current) return;
    sending.current = json;
    started.current = false;
    const data: Record<string, string> = { intent, [field]: json };
    if (version !== undefined) data.version = String(version);
    submitRef.current(data);
  }

  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  function syncPending() {
    setPending(sending.current !== null || queued.current !== null);
  }

  useEffect(() => {
    if (fetcher.state !== "idle") {
      started.current = true;
      return;
    }
    if (!started.current || sending.current === null) return;
    started.current = false;
    if (fetcher.data?.ok) {
      confirmed.current = sending.current;
      setError(null);
    } else {
      setError(fetcher.data?.error ?? "저장하지 못했어요.");
    }
    sending.current = null;
    pumpRef.current();
    syncPending();
  }, [fetcher.state, fetcher.data]);

  return {
    save(value: unknown) {
      const json = JSON.stringify(value);
      last.current = json;
      queued.current = json;
      setError(null);
      pump();
      syncPending();
    },
    retry() {
      if (last.current === null) return;
      queued.current = last.current;
      setError(null);
      pump();
      syncPending();
    },
    error,
    saving: fetcher.state !== "idle",
    /** A value is waiting for or travelling to the server: the server's copy is older than the screen. */
    pending,
  };
}
