// Prints the demo seed as SQL (same statements resetDemo runs), for the first fill of a new demo
// D1 or a reset outside the 04:00 cron:
//   npx tsx scripts/demo-seed-sql.ts > $TMPDIR/demo-seed.sql
//   CLOUDFLARE_ENV=demo npx wrangler d1 execute promo-demo --remote --file $TMPDIR/demo-seed.sql
// Visitor photos stay in R2 until the next cron reset.
import { seedStatements } from "../app/demo/seed-sql";
import { DEMO_SEED } from "../demo/seed";

function literal(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replaceAll("'", "''")}'`;
}

for (const { sql, params } of seedStatements(DEMO_SEED)) {
  let i = 0;
  console.log(`${sql.replace(/\?/g, () => literal(params[i++]))};`);
}
