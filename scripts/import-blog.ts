// Usage: npx tsx scripts/import-blog.ts --blog <blogId> --footer-start "<footer first line>" [--limit 50]
// Writes private/examples.json and private/seed-examples.sql (git-ignored).
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  buildSeedSql,
  classifyKind,
  parsePostHtml,
  parseRss,
  stripFooter,
  type SeedExample,
} from "./blog/parse";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DELAY_MS = 500;

const { values } = parseArgs({
  options: {
    blog: { type: "string" },
    "footer-start": { type: "string" },
    limit: { type: "string", default: "50" },
  },
});
const blog = values.blog;
const footerStart = values["footer-start"];
const limit = Number(values.limit);
if (!blog || !footerStart || !Number.isInteger(limit) || limit < 1) {
  console.error(
    'Usage: npx tsx scripts/import-blog.ts --blog <blogId> --footer-start "<footer first line>" [--limit 50]',
  );
  process.exit(1);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": MOBILE_UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const items = parseRss(await fetchText(`https://rss.blog.naver.com/${blog}.xml`)).slice(0, limit);
console.log(`RSS: ${items.length} posts`);

const rows: SeedExample[] = [];
for (const [index, item] of items.entries()) {
  if (index > 0) await sleep(DELAY_MS);
  try {
    const html = await fetchText(
      `https://m.blog.naver.com/PostView.naver?blogId=${blog}&logNo=${item.logNo}`,
    );
    const body = stripFooter(parsePostHtml(html), footerStart);
    if (!body) {
      console.warn(`skip ${item.logNo}: empty body`);
      continue;
    }
    rows.push({
      channel: "blog",
      kind: classifyKind(item.title),
      title: item.title,
      body,
      source: "blog_import",
      enabled: true,
      sourceUrl: item.url,
      createdAt: new Date(item.pubDate).toISOString(),
    });
  } catch (error) {
    console.warn(`skip ${item.logNo}: ${error instanceof Error ? error.message : error}`);
  }
}

await mkdir("private", { recursive: true });
await writeFile("private/examples.json", JSON.stringify(rows, null, 2) + "\n");
await writeFile("private/seed-examples.sql", buildSeedSql(rows) + "\n");
console.log(`wrote ${rows.length} examples to private/examples.json and private/seed-examples.sql`);
