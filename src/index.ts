#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { z } from "zod";
import axios from "axios";
import { spawnSync } from "node:child_process";
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
    description: "Fetch a newspaper snippet image and return it as base64. Use with snippet coordinates from search results. Supported sources: digipress, chronicling_america, gallica, europeana, anno, delpher, ddb, eluxemburgensia. Delpher pages are fetched as JPEG from Delpher's download API; a crop is applied with ImageMagick and the result is capped at 1600px.",
    inputSchema: z.object({
      source: z.enum(["digipress", "chronicling_america", "gallica", "europeana", "anno", "delpher", "ddb", "eluxemburgensia"])
        .describe("The archive source (digipress, chronicling_america, gallica, europeana, anno, delpher, ddb, eluxemburgensia)"),
      document_id: z.string()
        .describe("Document/page identifier from the archive (e.g. 'bsb10001591_00035' for digiPress, 'service:ndnp:...:0003' for Chronicling America, 'bpt6k5460422k/f173' for Gallica, full imageURL for ANNO, 'ddd:...:mpeg21:p010' for Delpher, UUID for DDB, 'ark:70795/.../pages/1' for eLuxemburgensia)"),
      snippet_coords: z.string().optional()
        .describe("IIIF region coordinates for the snippet crop (e.g. 'pct:0,11.5,100,3.6' for digiPress, 'x,y,w,h' pixel coords for Gallica and Delpher). Not used for ANNO (imageURL already contains crop). Delpher coords are relative to the 6000px-wide page image. If omitted, returns the full page."),
    }),
  },
  async ({ source, document_id, snippet_coords }) => {
    try {
      let imageUrl: string;
      let cropJpeg = false;
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
        const issueId = document_id.replace(/:p\d+$/, "");
        throw new Error(
          `KB image route unavailable for ${document_id}: ${detail}. ` +
          `Delpher does not serve a page scan for this id; the issue PDF may still be available at ` +
          `https://resolver.kb.nl/resolve?urn=${issueId}:pdf.`,
        );
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
          {
            type: "image",
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
