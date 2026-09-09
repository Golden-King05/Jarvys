const GOOGLE_SEARCH_URL = "https://www.googleapis.com/customsearch/v1";

// Kept small — each result becomes part of the tool response fed back into
// the model's context, and this session has already hit a real Groq
// per-minute token cap once from underestimated per-request overhead.
// Also Google Custom Search caps a single request at 10 results anyway.
const MAX_RESULTS = 5;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface GoogleSearchResponse {
  items?: { title: string; link: string; snippet?: string }[];
}

// General web search, for real-world places, businesses, or topics that
// don't have a Wikipedia article — complements search_wikipedia rather than
// replacing it. Requires a free Google Programmable Search Engine (100
// queries/day free) since — unlike Wikipedia/OSM/weather — there's no good
// keyless option for general web search. Needs TWO values: an API key
// (Google Cloud Console → enable "Custom Search API" → Credentials) and a
// search engine ID (programmablesearchengine.google.com → create one with
// "Search the entire web" turned on → its "Search engine ID").
export async function searchWeb(query: string): Promise<WebSearchResult[] | { error: string }> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const searchEngineId = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !searchEngineId) {
    return {
      error:
        "Web search needs a free Google Programmable Search Engine configured as GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX on the server. Set one up at https://programmablesearchengine.google.com (turn on \"Search the entire web\") and https://console.cloud.google.com (enable the Custom Search API for a key).",
    };
  }

  const params = new URLSearchParams({
    key: apiKey,
    cx: searchEngineId,
    q: query,
    num: String(MAX_RESULTS),
  });
  try {
    const res = await fetch(`${GOOGLE_SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { error: `Web search failed (${res.status})` };
    }
    const data = (await res.json()) as GoogleSearchResponse;
    const items = data.items ?? [];
    return items.slice(0, MAX_RESULTS).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet ?? "",
    }));
  } catch (err) {
    return { error: `Web search failed: ${err instanceof Error ? err.message : "network error"}` };
  }
}
