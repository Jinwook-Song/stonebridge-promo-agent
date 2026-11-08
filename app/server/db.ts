import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";

// One D1 session per request (set up in workers/app.ts), so reads can be served by the
// nearest read replica while staying sequentially consistent with this browser's writes.
const requestSession = new AsyncLocalStorage<D1DatabaseSession>();

export function withD1Session<T>(session: D1DatabaseSession, fn: () => T): T {
  return requestSession.run(session, fn);
}

export function getDb(d1: D1Database) {
  // Drizzle only calls prepare() and batch(), which a session has too.
  const session = requestSession.getStore();
  return drizzle((session ?? d1) as D1Database, { schema });
}

export type Db = ReturnType<typeof getDb>;
