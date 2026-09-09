const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

// Kept small — each result becomes part of the tool response fed back into
// the model's context, and this session has already hit a real Groq
// per-minute token cap once from underestimated per-request overhead.
const MAX_RESULTS = 5;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BraveSearchResponse {
  web?: { results?: { title: string; url: string; description?: string }[] };
}

// Brave's description field can contain <strong> tags highlighting the
// matched terms — strip them since this is fed to the model as plain text.
function stripHtml(text: string): string {
  return text.replace(/<\/?[^>]+>/g, "");
}

// General web search, for real-world places, businesses, or topics that
// don't have a Wikipedia article — complements search_wikipedia rather than
// replacing it. Requires a free Brave Search API key (2,000 queries/month
// free, no card required) since — unlike Wikipedia/OSM/weather — there's no
// good keyless option for general web search.
export async function searchWeb(query: string): Promise<WebSearchResult[] | { error: string }> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return {
      error:
        "Web search needs a free Brave Search API key configured as BRAVE_API_KEY on the server. Get one at https://api.search.brave.com.",
    };
  }

  const params = new URLSearchParams({ q: query, count: String(MAX_RESULTS) });
  try {
    const res = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { error: `Web search failed (${res.status})` };
    }
    const data = (await res.json()) as BraveSearchResponse;
    const results = data.web?.results ?? [];
    return results.slice(0, MAX_RESULTS).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: stripHtml(r.description ?? ""),
    }));
  } catch (err) {
    return { error: `Web search failed: ${err instanceof Error ? err.message : "network error"}` };
  }
}
