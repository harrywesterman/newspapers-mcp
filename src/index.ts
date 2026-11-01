#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { z } from "zod";
import axios from "axios";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cors from "cors";
import { NoOpOAuthProvider } from "./oauth-provider.js";
import {
  searchEuropeanaFull,
  searchGallicaFull,
  searchDdbFull,
  searchDigipressFull,
  searchBritishLibraryFull,
  searchAnnoFull,
  searchChroniclingAmericaFull,
  searchSouthAfricanFull,
  searchDelpherFull,
  searchTroveFull,
  searchEluxemburgensiaFull,
  searchNorwegianFull,
  searchDigitalNZFull,
  searchInternetArchiveFull,
} from "./providers/index.js";

// Schema definitions for tool inputs
const searchSchema = z.object({
  source: z.enum([
    "all",
    "europeana",
    "gallica",
    "ddb",
    "digipress",
    "british_library",
    "anno",
    "delpher",
    "chronicling_america",
    "norwegian",
    "digitalnz",
    "internet_archive",
    "south_african",
    "trove",
    "eluxemburgensia",
    "norwegian",
    "digitalnz",
    "internet_archive",
  ]).default("all").describe("Which newspaper archive to search. Use 'all' to search all archives simultaneously."),
  query: z.string().describe("Search query. Plain words are searched as a phrase; raw CQL (e.g. 'papertitle=\"De Noord-Ooster\" AND Westerman') is passed through unchanged"),
  date_from: z.string().optional().describe("Start date: YYYY-MM-DD (YYYY and YYYY-MM also accepted, widened to the whole year/month)"),
  date_to: z.string().optional().describe("End date: YYYY-MM-DD (YYYY and YYYY-MM also accepted, widened to the whole year/month)"),
  newspaper: z.string().optional().describe("Limit to one newspaper title, e.g. 'De Noord-Ooster' or 'Emmer courant' (exact title, no quotes needed)"),
  page: z.number().optional().default(1).describe("Page number for results"),
  rows: z.number().optional().default(20).describe("Number of results per page"),
});

/**
 * Fetch OCR text for a Delpher item. The `:ocr` representation exists for article ids
 * (`…:a0108`) but not for page ids (`…:p00004`), which is why this is a fallback and not
 * a substitute for a snippet image.
 */
async function fetchDelpherOcr(documentId: string): Promise<string | undefined> {
  try {
    const response = await axios.get(
      `https://resolver.kb.nl/resolve?urn=${encodeURIComponent(documentId)}:ocr`,
      { headers: { "User-Agent": "newspapers-mcp/1.0" }, timeout: 10000 },
    );
    const paragraphs = [...String(response.data).matchAll(/<p>([\s\S]*?)<\/p>/g)]
      .map(m => m[1].trim())
      .filter(Boolean);
    return paragraphs.length ? paragraphs.join(" ").slice(0, 4000) : undefined;
  } catch {
    return undefined;
  }
}

const DELPHER_PDF_DIR = path.join(os.tmpdir(), "newspapers-mcp-delpher");

function delpherCacheKey(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/** Keep the PDF cache bounded; entries are only useful to a warm, long-running process. */
function pruneDelpherPdfs(keep = 20): void {
  try {
    const files = fs.readdirSync(DELPHER_PDF_DIR)
      .filter(f => f.endsWith(".pdf"))
      .map(f => ({ file: f, mtime: fs.statSync(path.join(DELPHER_PDF_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { file } of files.slice(keep)) {
      fs.unlinkSync(path.join(DELPHER_PDF_DIR, file));
    }
  } catch {
    // Pruning is best-effort; a full cache must never fail a request.
  }
}

/**
 * Last-resort Delpher image source: some issues have no page scans in the image API but
 * do have an issue-level PDF. Render the requested page from it with poppler's `pdftoppm`,
 * at a fixed width so `snippet_coords` keeps the same coordinate space as the normal route.
 * The PDF (~7 MB) is cached in the temp directory; rendered pages are not, because a
 * full-resolution render is about as large as the PDF itself.
 */
async function renderDelpherPdfPage(
  documentId: string,
  width: number,
): Promise<{ buffer?: Buffer; error?: string }> {
  const match = documentId.match(/^(.*):p(\d+)$/);
  if (!match) return { error: "not a page id (expected …:p00004)" };
  const issueId = match[1];
  const page = Number(match[2]);
  const key = delpherCacheKey(issueId);
  const pdfPath = path.join(DELPHER_PDF_DIR, `${key}.pdf`);

  try {
    fs.mkdirSync(DELPHER_PDF_DIR, { recursive: true });

    if (!fs.existsSync(pdfPath)) {
      const pdf = await axios.get(
        `https://resolver.kb.nl/resolve?urn=${encodeURIComponent(issueId)}:pdf`,
        {
          responseType: "arraybuffer",
          headers: { "User-Agent": "newspapers-mcp/1.0" },
          timeout: 120000,
          validateStatus: status => status === 200,
        },
      );
      fs.writeFileSync(pdfPath, Buffer.from(pdf.data));
      pruneDelpherPdfs();
    }

    // Render to a per-request file: full-resolution renders are ~7 MB, so only the
    // (much more expensive to fetch) PDF is kept between calls.
    const prefix = path.join(DELPHER_PDF_DIR, `${key}-p${page}-w${width}-${process.pid}-${Date.now()}`);
    const jpgPath = `${prefix}.jpg`;
    const render = spawnSync(
      "pdftoppm",
      [
        "-f", String(page), "-l", String(page),
        "-scale-to-x", String(width), "-scale-to-y", "-1",
        "-jpeg", "-singlefile", pdfPath, prefix,
      ],
      { timeout: 120000 },
    );
    if (render.error) return { error: `pdftoppm failed: ${render.error.message}` };
    if (render.status !== 0) {
      try { fs.unlinkSync(jpgPath); } catch { /* nothing to clean up */ }
      return { error: `pdftoppm exited ${render.status}: ${String(render.stderr).slice(0, 200)}` };
    }
    if (!fs.existsSync(jpgPath)) return { error: "pdftoppm produced no output" };
    const buffer = fs.readFileSync(jpgPath);
    try { fs.unlinkSync(jpgPath); } catch { /* best-effort cache cleanup */ }
    return { buffer };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function registerTools(server: McpServer) {
// ========== UNIFIED NEWSPAPER SEARCH ==========
server.registerTool(
  "search_newspapers",
  {
    title: "Search Newspaper Archives",
    description: "Search historical newspaper archives across multiple countries. Sources: europeana (Europe-wide), gallica (France/BnF), ddb (Germany/DDB), digipress (Germany/BSB), british_library (UK catalogue), anno (Austria/ANNO), delpher (Netherlands/KB), chronicling_america (USA/LoC), trove (Australia/NLA, requires TROVE_API_KEY), eluxemburgensia (Luxembourg/BnL), norwegian (Norway/nb.no), digitalnz (New Zealand/Papers Past), internet_archive (Internet Archive newspapers), south_african (links only). Use source='all' to search all simultaneously.",
    inputSchema: searchSchema,
  },
  async ({ source, query, date_from, date_to, newspaper, page = 1, rows = 20 }) => {
    try {
      if (source === "all") {
        const archives = [
          { name: "Europeana", fn: () => searchEuropeanaFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "Gallica", fn: () => searchGallicaFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "digiPress", fn: () => searchDigipressFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "Norwegian NL", fn: () => searchNorwegianFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "DigitalNZ", fn: () => searchDigitalNZFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "Internet Archive", fn: () => searchInternetArchiveFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "Chronicling America", fn: () => searchChroniclingAmericaFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "ANNO", fn: () => searchAnnoFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "Delpher", fn: () => searchDelpherFull(query, date_from, date_to, page, Math.min(rows, 5), newspaper) },
          { name: "DDB", fn: () => searchDdbFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "Trove", fn: () => searchTroveFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "eLuxemburgensia", fn: () => searchEluxemburgensiaFull(query, date_from, date_to, page, Math.min(rows, 5)) },
          { name: "British Library", fn: () => searchBritishLibraryFull(query, date_from, date_to, page, rows) },
        ];

        const settled = await Promise.allSettled(archives.map(a => a.fn()));
        const sections = settled.map((r, i) =>
          r.status === "fulfilled" ? r.value : `${archives[i].name}: Error — ${r.reason instanceof Error ? r.reason.message : "Unknown error"}`
        );

        return {
          content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        };
      }

      // Single-source search
      let result: string;
      switch (source) {
        case "europeana":
          result = await searchEuropeanaFull(query, date_from, date_to, page, rows);
          break;
        case "gallica":
          result = await searchGallicaFull(query, date_from, date_to, page, rows);
          break;
        case "ddb":
          result = await searchDdbFull(query, date_from, date_to, page, rows);
          break;
        case "digipress":
          result = await searchDigipressFull(query, date_from, date_to, page, rows);
          break;
        case "british_library":
          result = await searchBritishLibraryFull(query, date_from, date_to, page, rows);
          break;
        case "anno":
          result = await searchAnnoFull(query, date_from, date_to, page, rows);
          break;
        case "delpher":
          result = await searchDelpherFull(query, date_from, date_to, page, rows, newspaper);
          break;
        case "chronicling_america":
          result = await searchChroniclingAmericaFull(query, date_from, date_to, page, rows);
          break;
        case "norwegian":
          result = await searchNorwegianFull(query, date_from, date_to, page, rows);
          break;
        case "digitalnz":
          result = await searchDigitalNZFull(query, date_from, date_to, page, rows);
          break;
        case "internet_archive":
          result = await searchInternetArchiveFull(query, date_from, date_to, page, rows);
          break;
        case "south_african":
          result = await searchSouthAfricanFull(query, date_from, date_to, page, rows);
          break;
        case "trove":
          result = await searchTroveFull(query, date_from, date_to, page, rows);
          break;
        case "eluxemburgensia":
          result = await searchEluxemburgensiaFull(query, date_from, date_to, page, rows);
          break;
        case "norwegian":
          result = await searchNorwegianFull(query, date_from, date_to, page, rows);
          break;
        case "digitalnz":
          result = await searchDigitalNZFull(query, date_from, date_to, page, rows);
          break;
        case "internet_archive":
          result = await searchInternetArchiveFull(query, date_from, date_to, page, rows);
          break;
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching newspapers: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// ========== SNIPPET IMAGE PROXY ==========
server.registerTool(
  "newspapers_get_snippet",
  {
    title: "Get Newspaper Snippet Image",
    description: "Fetch a newspaper snippet image and return it as base64. Use with snippet coordinates from search results. Supported sources: digipress, chronicling_america, gallica, europeana, anno, delpher, ddb, eluxemburgensia. Delpher pages are fetched as JPEG from Delpher's download API; a crop is applied with ImageMagick and the result is capped at 1600px. For Delpher page ids without a served scan, set allow_pdf_fallback to render the page from the issue PDF (slower).",
    inputSchema: z.object({
      source: z.enum(["digipress", "chronicling_america", "gallica", "europeana", "anno", "delpher", "ddb", "eluxemburgensia"])
        .describe("The archive source (digipress, chronicling_america, gallica, europeana, anno, delpher, ddb, eluxemburgensia)"),
      document_id: z.string()
        .describe("Document/page identifier from the archive (e.g. 'bsb10001591_00035' for digiPress, 'service:ndnp:...:0003' for Chronicling America, 'bpt6k5460422k/f173' for Gallica, full imageURL for ANNO, 'ddd:...:mpeg21:p010' for Delpher, UUID for DDB, 'ark:70795/.../pages/1' for eLuxemburgensia)"),
      snippet_coords: z.string().optional()
        .describe("IIIF region coordinates for the snippet crop (e.g. 'pct:0,11.5,100,3.6' for digiPress, 'x,y,w,h' pixel coords for Gallica and Delpher). Not used for ANNO (imageURL already contains crop). Delpher coords are relative to the 6000px-wide page image. If omitted, returns the full page."),
      allow_pdf_fallback: z.boolean().optional().default(false)
        .describe("Delpher page ids only: if the image API has no scan for the page, render it from the issue PDF instead. Downloads ~7 MB per issue (cached) and needs poppler's pdftoppm, so it is off by default."),
    }),
  },
  async ({ source, document_id, snippet_coords, allow_pdf_fallback }) => {
    try {
      let imageUrl: string;
      let cropJpeg = false;
      let pdfFallbackNote: string | undefined;
      const region = snippet_coords || "full";

      switch (source) {
        case "digipress":
          imageUrl = `https://api.digitale-sammlungen.de/iiif/image/v2/${encodeURI(document_id)}/${region}/full/0/default.jpg`;
          break;
        case "chronicling_america":
          imageUrl = `https://tile.loc.gov/image-services/iiif/${encodeURI(document_id)}/${region}/pct:25/0/default.jpg`;
          break;
        case "gallica":
          // Use ,1000 max height for full pages, full size for cropped regions
          const gallicaSize = snippet_coords ? "full" : ",1000";
          imageUrl = `https://gallica.bnf.fr/iiif/ark:/12148/${encodeURI(document_id)}/${region}/${gallicaSize}/0/default.jpg`;
          break;
        case "europeana":
          imageUrl = `https://api.europeana.eu/thumbnail/v2/url.json?uri=${encodeURIComponent(document_id)}&type=TEXT`;
        case "eluxemburgensia":
          // IIIF image service — document_id is "ark:70795/.../pages/N", region via snippet_coords
          imageUrl = `https://iiif.eluxemburgensia.lu/iiif/2/${encodeURIComponent(document_id)}/${region}/full/0/default.jpg`;
          break;
          break;
        case "anno": {
          // ANNO snippet imageURLs are complete URLs from the snippet API — validate domain
          const annoUrl = new URL(document_id);
          if (annoUrl.hostname !== "anno.onb.ac.at" && annoUrl.hostname !== "digital.onb.ac.at") {
            throw new Error("Invalid ANNO image URL: must be from anno.onb.ac.at or digital.onb.ac.at");
          }
          imageUrl = document_id;
          break;
        }
        case "delpher":
          // The KB resolver's `:image` endpoint was retired (404 for every id). Delpher's
          // download API still renders JPEGs server-side, so no JP2 conversion is needed.
          // Fetch a large page when cropping; a small one for a plain full-page snippet.
          imageUrl = `https://www.delpher.nl/nl/api/downloadimage?id=${encodeURIComponent(document_id + ":image")}&w=${snippet_coords ? 6000 : 1600}`;
          cropJpeg = Boolean(snippet_coords);
          break;
        case "ddb":
          // DDB binary endpoint returns thumbnails/images by UUID
          imageUrl = `https://api.deutsche-digitale-bibliothek.de/binary/${encodeURIComponent(document_id)}`;
          break;
        case "eluxemburgensia":
          // IIIF image service — document_id is "ark:70795/.../pages/N", region via snippet_coords
          imageUrl = `https://iiif.eluxemburgensia.lu/iiif/2/${encodeURIComponent(document_id)}/${region}/full/0/default.jpg`;
          break;
      }

      const response = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        headers: { "User-Agent": "newspapers-mcp/1.0" },
        timeout: 60000,
        // Delpher's download API reports failures as a 200 with a text body, but a
        // future 4xx/5xx should still produce our explicit message, not a bare axios error.
        ...(source === "delpher" ? { validateStatus: () => true } : {}),
      });

      const contentType = String(response.headers["content-type"] || "image/jpeg");
      let bytes = Buffer.from(response.data);
      let mimeType = contentType.split(";")[0].trim();

      // Delpher serves `image/jpeg` even for its "Not Found: …" error text, so trust the
      // bytes, not the content type. Not every page has a served scan: some issues only
      // expose the issue PDF (`…:mpeg21:pdf`) and OCR.
      const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
      if (source === "delpher" && (response.status < 200 || response.status >= 300 || !isJpeg)) {
        const detail = bytes.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 200)
          || `HTTP ${response.status}, non-JPEG payload`;
        const ocr = await fetchDelpherOcr(document_id);
        if (ocr) {
          return {
            content: [
              {
                type: "text",
                text: `No page image is available for ${document_id} (${detail}).\n\nOCR text:\n${ocr}`,
              },
            ],
          };
        }

        let fallbackError: string;
        if (allow_pdf_fallback) {
          // Render from the issue PDF at the same width the normal route would use,
          // so snippet_coords keeps its 6000px coordinate space.
          const width = snippet_coords ? 6000 : 1600;
          const rendered = await renderDelpherPdfPage(document_id, width);
          if (rendered.buffer) {
            bytes = rendered.buffer;
            mimeType = "image/jpeg";
            pdfFallbackNote =
              `Delpher serves no page scan for ${document_id}; page rendered from the issue PDF ` +
              `at ${width}px wide (cached). Crop coordinates are relative to that width.`;
            fallbackError = "";
          } else {
            fallbackError = `PDF fallback failed: ${rendered.error}`;
          }
        } else {
          fallbackError = "Retry with allow_pdf_fallback: true to render the page from the issue PDF";
        }

        if (fallbackError) {
          const issueId = document_id.replace(/:p\d+$/, "");
          throw new Error(
            `KB image route unavailable for ${document_id}: ${detail}. ${fallbackError}. ` +
            `The issue PDF is at https://resolver.kb.nl/resolve?urn=${issueId}:pdf.`,
          );
        }
      }

      if (cropJpeg || /jp2|jpeg\s*-?\s*2000/i.test(mimeType)) {
        // Crop to snippet_coords "x,y,w,h" in page pixels and cap the result at 1600 px.
        // JPEG-2000 payloads from other sources are converted here too, since most clients
        // cannot display them.
        const cropArgs: string[] = [];
        if (snippet_coords) {
          const n = snippet_coords.split(",").map(v => Number(v.trim()));
          if (n.length === 4 && n.every(v => Number.isFinite(v)) && n[2] > 0 && n[3] > 0) {
            cropArgs.push("-crop", `${n[2]}x${n[3]}+${n[0]}+${n[1]}`, "+repage");
          }
        }
        const conv = spawnSync(
          "magick",
          ["-", ...cropArgs, "-resize", "1600x1600>", "-quality", "82", "jpg:-"],
          { input: bytes, maxBuffer: 512 * 1024 * 1024 },
        );
        if (conv.status === 0 && conv.stdout && conv.stdout.length > 0) {
          bytes = conv.stdout as Buffer;
          mimeType = "image/jpeg";
        } else {
          const detail = conv.stderr ? conv.stderr.toString().slice(0, 300) : `exit ${conv.status}`;
          console.error(`JPEG conversion failed: ${detail}`);
          throw new Error(`JPEG conversion failed (${detail}); raw image is ${mimeType}`);
        }
      }

      const base64 = bytes.toString("base64");

      return {
        content: [
          ...(pdfFallbackNote ? [{ type: "text" as const, text: pdfFallbackNote }] : []),
          {
            type: "image" as const,
            data: base64,
            mimeType,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching snippet image: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
      };
    }
  }
);

} // end registerTools

// Main function to start the server (stdio)
async function main() {
  const server = new McpServer({
    name: "newspapers-mcp",
    version: "1.0.0",
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Newspapers MCP Server running on stdio");
}

// HTTP entry point for Google Cloud Functions
const app = express();
app.set("trust proxy", 1);
app.use(cors());

// Lazily initialize OAuth auth router on first request
let authHandler: express.RequestHandler | null = null;

app.use((req, res, next) => {
  if (!authHandler) {
    const serverUrl = `${req.protocol}://${req.get("host")}`;
    console.log(`[init] OAuth provider serverUrl=${serverUrl}`);
    const provider = new NoOpOAuthProvider();
    authHandler = mcpAuthRouter({
      provider,
      issuerUrl: new URL(serverUrl),
      resourceName: "Newspapers MCP",
      scopesSupported: [],
    });
  }
  authHandler(req, res, next);
});

// MCP StreamableHTTP endpoint
app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
  const mcpServer = new McpServer({
    name: "newspapers-mcp",
    version: "1.0.0",
  });
  registerTools(mcpServer);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body ?? {});
  } catch (err) {
    console.error("[mcp] error:", err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

// Health check
app.get(["/", "/health"], (_req: express.Request, res: express.Response) => {
  res.json({ status: "ok", server: "newspapers-mcp", version: "1.0.0" });
});

// Named export for GCP Cloud Functions
export const newspapersMcp = app;

// When running locally, use stdio transport instead
if (!process.env.K_SERVICE) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
