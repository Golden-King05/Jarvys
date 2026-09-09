const WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php";
const WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";

// Wikimedia asks API clients to identify themselves with a descriptive
// User-Agent (see https://meta.wikimedia.org/wiki/User-Agent_policy).
const USER_AGENT = "Jarvys-personal-assistant/1.0 (https://github.com/Golden-King05/Jarvys)";

interface WikiSearchResponse {
  query?: { search?: { title: string }[] };
}

interface WikiSummaryResponse {
  title: string;
  extract: string;
  content_urls?: { desktop?: { page?: string } };
  coordinates?: { lat: number; lon: number };
}

export interface WikipediaResult {
  title: string;
  summary: string;
  url: string;
  // Only set for geotagged articles (places, landmarks) — lets a factual
  // lookup like "the oldest building still standing in NYC" drop a real pin
  // instead of just answering in text.
  coordinates?: { lat: number; lon: number };
}

async function fetchSummary(title: string): Promise<WikipediaResult | { error: string }> {
  const summaryRes = await fetch(`${WIKI_SUMMARY_URL}${encodeURIComponent(title)}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!summaryRes.ok) {
    return { error: `Could not load the Wikipedia summary for "${title}" (${summaryRes.status})` };
  }
  const summaryData = (await summaryRes.json()) as WikiSummaryResponse;

  return {
    title: summaryData.title,
    summary: summaryData.extract,
    url:
      summaryData.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    ...(summaryData.coordinates ? { coordinates: summaryData.coordinates } : {}),
  };
}

export async function searchWikipedia(query: string): Promise<WikipediaResult | { error: string }> {
  const searchParams = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1",
    format: "json",
  });

  const searchRes = await fetch(`${WIKI_SEARCH_URL}?${searchParams}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!searchRes.ok) {
    return { error: `Wikipedia search failed (${searchRes.status})` };
  }
  const searchData = (await searchRes.json()) as WikiSearchResponse;
  const topTitle = searchData.query?.search?.[0]?.title;
  if (!topTitle) {
    return { error: `No Wikipedia article found for "${query}"` };
  }

  return fetchSummary(topTitle);
}

// For URL imports — pulls the article title straight out of a
// wikipedia.org/wiki/<title> URL rather than re-searching for it.
export function wikipediaTitleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)wikipedia\.org$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/wiki\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export async function getWikipediaByTitle(title: string): Promise<WikipediaResult | { error: string }> {
  return fetchSummary(title);
}
