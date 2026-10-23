#!/usr/bin/env node
/**
 * End-to-end checks for the Delpher provider (date filtering, newspaper filter, snippet JPEG).
 * Runs the real MCP server over stdio, so it exercises the built code path a client uses.
 *
 *   npm run build && node scripts/test-delpher.mjs
 *
 * Live archive data: assertions are about shape and filtering, not about exact hit counts.
 * Requires ImageMagick (`magick`) on PATH for the snippet conversion test.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: "node", args: [path.join(root, "build/index.js")] });
const client = new Client({ name: "delpher-e2e", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

const text = r => r.content.map(c => c.text ?? "").join("\n");
const hits = t => Number((t.match(/— (\d+) results/) ?? [])[1]);
const dates = t => [...t.matchAll(/^\d+\. .*?\((\d{4}-\d{2}-\d{2})\)/gm)].map(m => m[1]);
const papers = t => [...t.matchAll(/^\d+\. .*?— ([^[]+?) \[/gm)].map(m => m[1].trim());

async function search(args) {
  return text(await client.callTool({ name: "search_newspapers", arguments: { source: "delpher", ...args } }));
}

// 1. a single day must survive as `date = "…"` (the KB drops `within` with equal bounds)
let t = await search({ query: "Westerman", date_from: "1932-02-23", date_to: "1932-02-23", rows: 5 });
check("single day -> date =", t.includes('date = "1932-02-23"'), (t.match(/Effective CQL: .*/) ?? [])[0]);
check("single day is filtered", hits(t) > 0 && hits(t) < 1000, `${hits(t)} hits`);
check("every hit is on that day", dates(t).length > 0 && dates(t).every(d => d === "1932-02-23"), dates(t).join(","));

// 2. year-only input is widened to the whole year
t = await search({ query: "Westerman", date_from: "1932", date_to: "1932", rows: 3 });
check("year-only -> whole year", t.includes('date within "1932-01-01 1932-12-31"'), (t.match(/Effective CQL: .*/) ?? [])[0]);

// 3. multi-word plain query is AND-joined (a quoted phrase plus a date clause returns 0)
t = await search({ query: "Emmer courant", date_from: "1932-02-20", date_to: "1932-02-29", rows: 3 });
check("multi-word -> AND", t.includes("Emmer AND courant AND date"), (t.match(/Effective CQL: .*/) ?? [])[0]);
check("multi-word finds records", hits(t) > 0, `${hits(t)} hits`);

// 4. newspaper filter
t = await search({ query: "Emmen", newspaper: "De Noord-Ooster", date_from: "1932-02-20", date_to: "1932-02-29", rows: 5 });
check("newspaper -> papertitle", t.includes('papertitle="De Noord-Ooster"'), (t.match(/Effective CQL: .*/) ?? [])[0]);
check("hits come from that paper", papers(t).length > 0 && papers(t).every(p => p === "De Noord-Ooster"), papers(t).join(" | "));

// 5. raw CQL is passed through untouched
t = await search({ query: 'papertitle="De Noord-Ooster" AND Emmen', date_from: "1932-02-20", date_to: "1932-02-29", rows: 2 });
check("raw CQL passthrough", t.includes('papertitle="De Noord-Ooster" AND Emmen AND date within'));

// 6. snippets: KB serves JP2, the server must hand back a JPEG
for (const [label, coords] of [["full page", undefined], ["crop", "600,300,900,400"]]) {
  const r = await client.callTool({
    name: "newspapers_get_snippet",
    arguments: { source: "delpher", document_id: "MMGEM01:163312015:mpeg21:p00002", ...(coords ? { snippet_coords: coords } : {}) },
  });
  const img = r.content.find(c => c.type === "image");
  if (!img) {
    check(`snippet ${label}`, false, r.content.map(c => c.text ?? "").join("").slice(0, 200));
    continue;
  }
  const buf = Buffer.from(img.data, "base64");
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  check(`snippet ${label} is JPEG`, img.mimeType === "image/jpeg" && jpeg && buf.length > 10_000, `${img.mimeType}, ${buf.length} bytes`);
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
