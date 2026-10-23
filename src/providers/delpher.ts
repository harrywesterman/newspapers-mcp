import axios from "axios";

/**
 * Delpher/KB SRU (jsru.kb.nl) quirks, learned the hard way:
 *
 * 1. `date within "A B"` is SILENTLY IGNORED when A === B. The query then returns the
 *    unfiltered total (e.g. 104689 hits for "Westerman"), which looks like "the date
 *    filter does not work". A single day must be expressed as `date = "YYYY-MM-DD"`.
 * 2. Bounds are inclusive: `within "1932-02-01 1932-02-28"` covers 1..28 February.
 * 3. Only full ISO dates work: `within "1932 1932"` / `"19320220 19320228"` are ignored,
 *    `within "1932-02-20 1932-02-28"` works. Year/month-only input is expanded here.
 * 4. A bare multi-word query (`Emmer courant`) is invalid CQL and yields 0 records, while a
 *    quoted phrase (`"Emmer courant"`) yields 0 as soon as ANY date clause is added. Plain
 *    words are therefore AND-joined here. Three or more clauses are fine.
 * 5. Newspaper titles are searchable via `papertitle="De Noord-Ooster"`.
 */

/** Normalize "1932", "1932-02", "1932-2-9", "1932/02/09" to ISO; month/year input is widened. */
function isoDatePart(raw: string, end: boolean): string | undefined {
  const m = raw.trim().match(/^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?$/);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = m[2] !== undefined ? Number(m[2]) : undefined;
  const day = m[3] !== undefined ? Number(m[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined && (day < 1 || day > 31)) return undefined;
  const yy = String(year).padStart(4, "0");
  if (month !== undefined && day !== undefined) {
    return `${yy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (month !== undefined) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dd = end ? lastDay : 1;
    return `${yy}-${String(month).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  return `${yy}-${end ? "12-31" : "01-01"}`;
}

export function buildDelpherDateCql(dateFrom?: string, dateTo?: string): string | undefined {
  const from = dateFrom ? isoDatePart(dateFrom, false) : undefined;
  const to = dateTo ? isoDatePart(dateTo, true) : undefined;
  if (!from && !to) return undefined;
  if (from && to && from === to) return `date = "${from}"`; // 'within' with equal bounds is ignored by KB
  if (from && to && from > to) return `date within "${to} ${from}"`;
  return `date within "${from ?? "1618-01-01"} ${to ?? "1995-12-31"}"`;
}

/** Turn a plain query into valid CQL; leave real CQL untouched.
 *
 * A quoted phrase (`"Emmer courant"`) returns 0 records as soon as ANY date clause is
 * added, so plain multi-word input is AND-joined word by word instead.
 */
export function buildDelpherQuery(query: string, newspaper?: string): string {
  const q = query.trim();
  const looksLikeCql = /["=<>()]/.test(q) || /\b(?:AND|OR|NOT|WITHIN)\b/i.test(q);
  let cql = q;
  if (!looksLikeCql && /\s/.test(q)) {
    const words = q
      .split(/\s+/)
      .map(w => w.replace(/[^\p{L}\p{N}\-']/gu, ""))
      .filter(Boolean);
    cql = words.length ? words.join(" AND ") : q;
  }
  if (newspaper && newspaper.trim()) {
    cql = `papertitle="${newspaper.replace(/"/g, "").trim()}" AND (${cql})`;
  }
  return cql;
}

export async function searchDelpherFull(
  query: string,
  date_from?: string,
  date_to?: string,
  page = 1,
  rows = 20,
  newspaper?: string,
): Promise<string> {
  const cqlQuery = [buildDelpherQuery(query, newspaper), buildDelpherDateCql(date_from, date_to)]
    .filter(Boolean)
    .join(" AND ");

  const params = new URLSearchParams({
    version: "1.2",
    operation: "searchRetrieve",
    query: cqlQuery,
    recordSchema: "ddd",
    maximumRecords: rows.toString(),
    startRecord: ((page - 1) * rows + 1).toString(),
    "x-collection": "DDD_artikel",
  });

  const response = await axios.get(`https://jsru.kb.nl/sru/sru?${params}`, {
    headers: { "User-Agent": "newspapers-mcp/1.0" },
    timeout: 15000,
  });
  const xml: string = response.data;

  const totalMatch = xml.match(/<srw:numberOfRecords>(\d+)<\/srw:numberOfRecords>/);
  const totalResults = totalMatch ? totalMatch[1] : "unknown";

  // Parse SRU records
  const articles: Array<{
    title: string; date: string; type: string; newspaper: string;
    metadataKey: string; pageurl: string; pageNum: string;
    publisher: string; place: string; edition: string; link: string;
  }> = [];

  const recordRegex = /<srw:record>([\s\S]*?)<\/srw:record>/g;
  let match;
  while ((match = recordRegex.exec(xml)) !== null && articles.length < rows) {
    const rec = match[1];
    const get = (tag: string) => {
      const m = rec.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : "";
    };

    const metadataKey = get("ddd:metadataKey");
    if (!metadataKey) continue;

    articles.push({
      title: get("dc:title") || "Untitled",
      date: get("dc:date").split(" ")[0].replace(/\//g, "-") || "",
      type: get("dc:type"),
      newspaper: get("ddd:papertitle"),
      metadataKey,
      pageurl: get("ddd:pageurl"),
      pageNum: get("ddd:page"),
      publisher: get("ddd:publisher"),
      place: get("ddd:spatialCreation"),
      edition: get("ddd:edition"),
      link: `https://www.delpher.nl/nl/kranten/view?coll=ddd&identifier=${encodeURIComponent(metadataKey)}`,
    });
  }

  // Header echoes the effective CQL, so a silently ignored filter becomes visible.
  const filterLine = date_from || date_to || newspaper ? `\nEffective CQL: ${cqlQuery}` : "";

  // Enrich top results with OCR text
  const maxOcrFetches = Math.min(articles.length, 5);
  const enrichedResults: string[] = [];

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    let entry = `${i + 1}. ${art.title}`;
    if (art.date) entry += ` (${art.date})`;
    if (art.newspaper) entry += ` — ${art.newspaper}`;
    if (art.edition) entry += ` [${art.edition}]`;
    if (art.place) entry += `, ${art.place}`;
    if (art.type) entry += ` (${art.type})`;
    entry += `\n   Link: ${art.link}`;
    if (art.pageNum) entry += ` (page ${art.pageNum})`;

    if (i < maxOcrFetches) {
      try {
        const ocrResp = await axios.get(`https://resolver.kb.nl/resolve?urn=${art.metadataKey}:ocr`, {
          headers: { "User-Agent": "newspapers-mcp/1.0" },
          timeout: 10000,
        });
        const ocrXml: string = ocrResp.data;
        // Extract text from <p> tags
        const paragraphs: string[] = [];
        const pRegex = /<p>([\s\S]*?)<\/p>/g;
        let pMatch;
        while ((pMatch = pRegex.exec(ocrXml)) !== null) {
          const text = pMatch[1].trim();
          if (text) paragraphs.push(text);
        }
        const ocrText = paragraphs.join(" ").substring(0, 400);
        if (ocrText) entry += `\n   OCR: ${ocrText}`;
      } catch {
        // OCR fetch failed, show basic result
      }
    }

    if (art.pageurl) {
      entry += `\n   → newspapers_get_snippet(source: "delpher", document_id: "${art.pageurl}")`;
    }

    enrichedResults.push(entry);
  }

  return `Delpher (KB Netherlands) — ${totalResults} results for "${query}" (2M+ newspapers, 1618–1995)${filterLine}\nPage ${page}, showing ${articles.length} results:\n\n${enrichedResults.join("\n\n") || "No results found."}`;
}
