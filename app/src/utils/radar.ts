// RainViewer's public API is free, keyless, and covers the whole globe
// (unlike NOAA, which is US-only and needs WMS bounding-box requests
// instead of simple {z}/{x}/{y} tiles) — a good fit for a map layer toggle.
const FRAMES_URL = "https://api.rainviewer.com/public/weather-maps.json";

interface RainviewerFrame {
  path: string;
}
interface RainviewerResponse {
  radar?: { past?: RainviewerFrame[] };
}

let cached: { template: string; fetchedAt: number } | null = null;
const CACHE_MS = 5 * 60 * 1000; // RainViewer publishes a new frame roughly every 10 minutes.

export async function getRadarTileTemplate(): Promise<string | null> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.template;
  }
  try {
    const res = await fetch(FRAMES_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as RainviewerResponse;
    const frames = data.radar?.past;
    const latest = frames?.[frames.length - 1];
    if (!latest?.path) return null;
    const template = `https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;
    cached = { template, fetchedAt: Date.now() };
    return template;
  } catch {
    return null;
  }
}
