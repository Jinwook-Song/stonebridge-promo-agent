# Quote agent: runtime spike results (2026-11-09)

Three assumptions from the design (section 5) were checked with a throwaway Worker
(`stonebridge-spike`, same compatibility date as the app, deployed to the real Cloudflare account,
called with `curl`, then deleted). Exact URLs and raw responses are kept out of the repo.

## Decisions

| | Question | Decision |
|---|---|---|
| (a) | Naver blog fetch from a deployed Worker | `direct` (plain Worker `fetch`) |
| (b) | `TextDecoder("euc-kr")` in workerd | Works |
| (c) | `.xlsx` write + read in a Worker | `exceljs@4.4.0`, compatibility flag `nodejs_compat` |

### (a) Naver import: `direct`

Fetched from the deployed Worker with a plain `fetch` and a generic User-Agent, no special headers:

| Test | Result |
|---|---|
| RSS feed of the owner's public blog | 200, `text/xml;charset=UTF-8`, 73,015 bytes, 50 `<item>` |
| Mobile `PostView` of the newest post | 200, `text/html;charset=UTF-8`, 93,488 bytes, 130 `se-text-paragraph` |
| Repeat (3 calls each) | RSS 200 x3, PostView 200 x3 |

Naver does not block the Cloudflare egress here, so no need for the `claude_web_fetch` fallback in v1.
Keep the fallback seam in the design in case this changes. Notes for the implementer:

- RSS `<link>` values are CDATA and look like `https://blog.naver.com/<blogId>/<logNo>?fromRss=true&trackingCode=rss`.
  The channel-level `<link>` has no logNo; skip it.
- `PostView` returns HTTP 200 even for a missing post (a short "deleted" alert page with no
  `se-text-paragraph`). Judge success by finding paragraphs, not by status.
- Checked from a single deployed location over a few minutes; a block could still appear later,
  so treat a non-200 or zero paragraphs as a clear import error.

### (b) EUC-KR decode: works

A cp949 competitor price page (served as `text/html` without a charset header, `<meta charset=euc-kr>` inside):

- `fetch` -> 200, 99,349 bytes.
- `new TextDecoder("euc-kr").decode(buffer)` did not throw: 89,385 characters, 9,911 Hangul
  characters, 0 replacement characters (U+FFFD). Sampled text reads correctly (catering/price headings).
- Always `arrayBuffer()` then decode; `response.text()` would assume UTF-8.

### (c) `.xlsx`: `exceljs@4.4.0`

First candidate in the planned order, so SheetJS and hand-written OOXML were not needed.
Built a sheet with a merged range (A1:E1), bold text, thin borders and formulas
(`C3*D3`, `C2*D2`), downloaded it, and in the same Worker read the same bytes back:

- 6,716 bytes, valid zip. File inspected: `<mergeCell ref="A1:E1"/>`, `<f>C3*D3</f>`, thin borders and bold in `styles.xml`.
- Read-back JSON: sheet name `견적`; A1 `견적서`, bold, merged (master A1), merge list `A1`; A2 bold with
  thin borders on all four sides; C3 `10`; E3 `{formula: "C3*D3", result: 15000}`; F3 `{formula: "C2*D2"}`.
- Worker startup 39-88 ms.

Bundle size (`wrangler deploy --dry-run`, spike worker alone; an empty worker is 0.13 KiB, so this is
the increase for exceljs):

| Resolution | Total Upload | gzip |
|---|---|---|
| `exceljs` as bundled by wrangler (resolves the package `browser` build) | 1,469.8 KiB | 299.6 KiB |
| `exceljs/lib/exceljs.nodejs.js` (the `main` build) | 2,340.6 KiB | 422.7 KiB |

For reference the app today is 1,819.8 KiB / 407.3 KiB gzip, so expect roughly 3.2-4.1 MiB raw
and about 0.7-0.8 MiB gzip after adding it. Fine for the paid plan (10 MiB gzip) and the free plan (3 MiB gzip).

Compatibility flag: the `browser` build also ran on `nodejs_als` alone, but the app is bundled by
Vite, which may pick the package `main` (the Node build, which needs Node built-ins). Both builds
ran correctly under `nodejs_compat`, so use that. The app's `wrangler.jsonc` flags changed from
`["nodejs_als"]` to `["nodejs_compat"]` (it includes `nodejs_als`); typecheck and all 24 test files
(322 tests) still pass. Task 7 adds the dependency. If the app bundle exceeds limits, import
`exceljs/dist/exceljs.min.js` (the smaller browser build) explicitly.

## Not covered

- Behavior of Naver under heavy or scheduled traffic (only a handful of calls were made).
- Excel/Numbers rendering of the generated file (checked at the XML level and by re-reading with exceljs only).
