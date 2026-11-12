// Prints the demo seed as SQL (same statements resetDemo runs), for the first fill of a new demo
// D1 or a reset outside the 04:00 cron:
//   CLOUDFLARE_ENV=demo npx tsx scripts/demo-seed-sql.ts > $TMPDIR/demo-seed.sql
//   CLOUDFLARE_ENV=demo npx wrangler d1 execute promo-demo --remote --file $TMPDIR/demo-seed.sql
// Visitor photos stay in R2 until the next cron reset.
import { seedStatements } from "../app/demo/seed-sql";
import { DEMO_SEED } from "../demo/seed";

// Its output starts by emptying every table: refuse unless aimed at the demo, never the owner's D1.
if (process.env.CLOUDFLARE_ENV !== "demo") {
  console.error("CLOUDFLARE_ENV=demo 로 실행하세요 (이 SQL은 모든 테이블을 비웁니다).");
  process.exit(1);
}

function literal(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replaceAll("'", "''")}'`;
}

for (const { sql, params } of seedStatements(DEMO_SEED)) {
  let i = 0;
  console.log(`${sql.replace(/\?/g, () => literal(params[i++]))};`);
}
