// Proxies USGS's dynamic 3DEP elevation service as ordinary {z}/{x}/{y} map
// tiles. The static USGSShadedReliefOnly tile cache (the first thing tried
// for this layer) turned out to be a coarse, low-contrast render with no
// tiles past zoom 13 — nowhere near the fine terrain texture (old roads,
// field lines, terracing) that similar lidar-detecting apps show. The
// 3DEPElevation ImageServer sits on the same underlying 3DEP lidar/DEM data
// (confirmed down to ~1m pixel size) but renders on demand via its
// "Hillshade Gray-Stretch" function, which produces that same
// high-contrast, richly textured look. It only speaks bbox-based
// exportImage requests, not a tile scheme, so this computes each tile's Web
// Mercator bbox and fetches it — and caches the result, since terrain never
// changes and the upstream service is a shared federal resource, not
// something to hit fresh on every pan.
const EXPORT_IMAGE_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";

const TILE_SIZE = 256;
const WEB_MERCATOR_EXTENT = 20037508.342789244;

function tileToBBox(z: number, x: number, y: number): [number, number, number, number] {
  const worldSize = WEB_MERCATOR_EXTENT * 2;
  const tileSpan = worldSize / 2 ** z;
  const minX = -WEB_MERCATOR_EXTENT + x * tileSpan;
  const maxX = minX + tileSpan;
  const maxY = WEB_MERCATOR_EXTENT - y * tileSpan;
  const minY = maxY - tileSpan;
  return [minX, minY, maxX, maxY];
}

interface CachedTile {
  body: Buffer;
  contentType: string;
}

// Capped, insertion-order eviction cache — good enough for a single
// personal-app instance without pulling in a real LRU dependency. ~500
// tiles at this render's typical size (tens of KB each) stays well under
// what's worth worrying about in memory.
const MAX_CACHED_TILES = 500;
const tileCache = new Map<string, CachedTile>();

export async function fetchLidarTile(z: number, x: number, y: number): Promise<CachedTile> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const [minX, minY, maxX, maxY] = tileToBBox(z, x, y);
  const params = new URLSearchParams({
    bbox: `${minX},${minY},${maxX},${maxY}`,
    bboxSR: "102100",
    imageSR: "102100",
    size: `${TILE_SIZE},${TILE_SIZE}`,
    format: "png",
    renderingRule: JSON.stringify({ rasterFunction: "Hillshade Gray-Stretch" }),
    f: "image",
  });

  const res = await fetch(`${EXPORT_IMAGE_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`USGS 3DEP exportImage failed (${res.status})`);
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  const body = Buffer.from(await res.arrayBuffer());
  const tile: CachedTile = { body, contentType };

  if (tileCache.size >= MAX_CACHED_TILES) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey !== undefined) tileCache.delete(oldestKey);
  }
  tileCache.set(key, tile);
  return tile;
}
