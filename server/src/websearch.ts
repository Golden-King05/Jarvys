const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

// Kept small — each result becomes part of the tool response fed back into
// the model's context, and this session has already hit a real Groq
// per-minute token cap once from underestimated per-request overhead.
const MAX_RESULTS = 5;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface TavilySearchResponse {
  results?: { title: string; url: string; content?: string }[];
}

// General web search, for real-world places, businesses, or topics that
// don't have a Wikipedia article — complements search_wikipedia rather than
// replacing it. Requires a free Tavily API key (1,000 searches/month free,
// no card required) since — unlike Wikipedia/OSM/weather — there's no good
// keyless option for general web search. Chosen over Google Programmable
// Search Engine specifically to skip its "Search the entire web" setup step
// (a real, reported UI-toggle bug on that product) — Tavily searches the
// whole web by default with nothing to configure beyond the key itself.
export async function searchWeb(query: string): Promise<WebSearchResult[] | { error: string }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      error:
        "Web search needs a free Tavily API key configured as TAVILY_API_KEY on the server. Get one at https://tavily.com.",
    };
  }

  try {
    const res = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_RESULTS }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { error: `Web search failed (${res.status})` };
    }
    const data = (await res.json()) as TavilySearchResponse;
    const results = data.results ?? [];
    return results.slice(0, MAX_RESULTS).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? "",
    }));
  } catch (err) {
    return { error: `Web search failed: ${err instanceof Error ? err.message : "network error"}` };
  }
}
