// Wikidata as a seed for the handle directory: property P2002 is the X username. Nightly, never per
// post. Rows land in handle_directory_staging; an editor verifies before any handle can be suggested.
// Expect patchy coverage for Rajasthan MLAs and district officials.

export interface WikidataHandle {
  qid: string;
  label: string;
  labelHi: string | null;
  handle: string;
  description: string | null;
}

const PREFIX = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
`;

const SELECT = `SELECT DISTINCT ?item ?itemLabel ?hiLabel ?handle ?desc WHERE {`;
const LABELS = `
  OPTIONAL { ?item rdfs:label ?hiLabel FILTER(lang(?hiLabel) = "hi") }
  OPTIONAL { ?item schema:description ?desc FILTER(lang(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,hi". }
}`;

/** The three seeds from the backend doc §6.5. */
export const WIKIDATA_QUERIES = {
  /** People with Indian citizenship and an X username */
  indiaPeople: `${PREFIX}${SELECT}
  ?item wdt:P31 wd:Q5 ; wdt:P27 wd:Q668 ; wdt:P2002 ?handle .${LABELS}`,
  /** People holding a position whose jurisdiction is Rajasthan (Q1437) */
  rajasthanOffice: `${PREFIX}${SELECT}
  ?item wdt:P31 wd:Q5 ; wdt:P2002 ?handle ; wdt:P39 ?pos . ?pos wdt:P1001 wd:Q1437 .${LABELS}`,
  /** Indian organisations (ministries, parties, agencies) with an X username */
  indiaOrgs: `${PREFIX}${SELECT}
  ?item wdt:P31/wdt:P279* wd:Q43229 ; wdt:P17 wd:Q668 ; wdt:P2002 ?handle .${LABELS}`,
} as const;

interface SparqlRow {
  item: { value: string };
  itemLabel?: { value: string };
  hiLabel?: { value: string };
  handle: { value: string };
  desc?: { value: string };
}

export function parseSparqlRows(rows: SparqlRow[]): WikidataHandle[] {
  return rows.map((r) => {
    const qid = r.item.value.split("/").pop()!;
    const label = r.itemLabel?.value ?? qid;
    return {
      qid,
      // the label service falls back to the QID itself when there is no label
      label: /^Q\d+$/.test(label) ? r.hiLabel?.value ?? label : label,
      labelHi: r.hiLabel?.value ?? null,
      handle: r.handle.value.replace(/^@/, ""),
      description: r.desc?.value ?? null,
    };
  });
}

export interface WikidataOptions {
  /** Wikidata blocks anonymous clients: say who you are and how to reach you */
  userAgent: string;
  pageSize?: number;
  maxPages?: number;
  endpoint?: string;
  fetch?: typeof fetch;
}

/** Pages through a query with LIMIT/OFFSET; the endpoint times out at about 60 s per request. */
export async function fetchWikidataHandles(query: string, opts: WikidataOptions): Promise<WikidataHandle[]> {
  const http = opts.fetch ?? fetch;
  const pageSize = opts.pageSize ?? 2000;
  const out: WikidataHandle[] = [];
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const paged = `${query}\nORDER BY ?item\nLIMIT ${pageSize}\nOFFSET ${page * pageSize}`;
    const url = `${opts.endpoint ?? "https://query.wikidata.org/sparql"}?format=json&query=${encodeURIComponent(paged)}`;
    const res = await http(url, { headers: { accept: "application/sparql-results+json", "user-agent": opts.userAgent } });
    if (!res.ok) throw new Error(`Wikidata returned ${res.status}`);
    const json = (await res.json()) as { results: { bindings: SparqlRow[] } };
    const rows = parseSparqlRows(json.results.bindings);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
