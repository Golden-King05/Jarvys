import { getWikipediaByTitle, wikipediaTitleFromUrl } from "./wikipedia.js";

const USER_AGENT = "Jarvys-personal-assistant/1.0 (https://github.com/Golden-King05/Jarvys)";

export interface ImportedPoint {
  name: string;
  blurb: string;
  icon: string;
  urls: string[];
  lat: number | null;
  lon: number | null;
}

// Pulls a <title> tag out of raw HTML without a full parser — good enough
// for naming an imported link, not meant to handle every edge case.
function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : null;
}

// A user pasting a URL shouldn't have to also type a name — infer as much as
// possible. Wikipedia links get full treatment (title, summary, and
// coordinates when the article is geotagged); anything else just gets its
// page title, and the caller has to supply lat/lon since there's no general
// way to know where an arbitrary webpage is "about".
export async function importPointFromUrl(url: string): Promise<ImportedPoint | { error: string }> {
  const wikiTitle = wikipediaTitleFromUrl(url);
  if (wikiTitle) {
    const result = await getWikipediaByTitle(wikiTitle);
    if ("error" in result) return result;
    return {
      name: result.title,
      blurb: result.summary,
      icon: "📖",
      urls: [result.url],
      lat: result.coordinates?.lat ?? null,
      lon: result.coordinates?.lon ?? null,
    };
  }

  try {
    // A connection-level failure (unreachable host, DNS hiccup, timeout) —
    // as opposed to a normal HTTP error response — makes fetch() itself
    // throw. Left uncaught this propagates as an unhandled rejection and
    // crashes the whole server (confirmed in production for the same
    // pattern elsewhere), not just this one request.
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return { error: `Couldn't load that URL (${res.status})` };
    }
    const html = await res.text();
    const title = extractHtmlTitle(html) ?? url;
    return { name: title, blurb: "", icon: "🔗", urls: [url], lat: null, lon: null };
  } catch (err) {
    return { error: `Couldn't load that URL: ${err instanceof Error ? err.message : "network error"}` };
  }
}
