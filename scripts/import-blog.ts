// Usage: npx tsx scripts/import-blog.ts --blog <blogId> --footer-start "<line start>" [--footer-start "<line start>" ...] [--limit 50]
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
    "footer-start": { type: "string", multiple: true },
    limit: { type: "string", default: "50" },
  },
});
const blog = values.blog;
const footerStarts = (values["footer-start"] ?? []).filter((marker) => marker.trim() !== "");
const limit = Number(values.limit);
if (!blog || footerStarts.length === 0 || !Number.isInteger(limit) || limit < 1) {
  console.error(
    'Usage: npx tsx scripts/import-blog.ts --blog <blogId> --footer-start "<line start>" [--footer-start "<line start>" ...] [--limit 50]',
  );
  process.exit(1);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": MOBILE_UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Naver feeds give every post a logNo; the filter only narrows the type.
const items = parseRss(await fetchText(`https://rss.blog.naver.com/${blog}.xml`))
  .flatMap((item) => (item.logNo ? [{ ...item, logNo: item.logNo }] : []))
  .slice(0, limit);
console.log(`RSS: ${items.length} posts`);

const rows: SeedExample[] = [];
let skipped = 0;
let noMarker = 0;
for (const [index, item] of items.entries()) {
  if (index > 0) await sleep(DELAY_MS);
  try {
    const html = await fetchText(
      `https://m.blog.naver.com/PostView.naver?blogId=${blog}&logNo=${item.logNo}`,
    );
    const full = parsePostHtml(html);
    const body = stripFooter(full, footerStarts);
    if (body === full) noMarker += 1;
    if (!body) {
      skipped += 1;
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
    skipped += 1;
    console.warn(`skip ${item.logNo}: ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`footer: ${noMarker} of ${items.length} posts matched no --footer-start marker`);
if (rows.length === 0) {
  console.error(`no examples imported (skipped ${skipped} of ${items.length}); leaving private/ untouched`);
  process.exit(1);
}

await mkdir("private", { recursive: true });
await writeFile("private/examples.json", JSON.stringify(rows, null, 2) + "\n");
await writeFile("private/seed-examples.sql", buildSeedSql(rows) + "\n");
console.log(
  `wrote ${rows.length} of ${items.length}, skipped ${skipped} (private/examples.json, private/seed-examples.sql)`,
);
if (skipped > 0) process.exitCode = 1;
