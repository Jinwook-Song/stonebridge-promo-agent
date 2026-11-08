// backtest.ts imports app/promo code that mentions Workers' D1 types only in type positions
// (app/server/db.ts). The scripts project has no Workers globals, so declare them as opaque here.
// Never constructed: the backtest passes no database.
interface D1Database {
  prepare(query: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
}
interface D1DatabaseSession extends D1Database {}
