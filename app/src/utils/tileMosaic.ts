// Fetches and stitches slippy-map tiles (by URL template, standard
// {z}/{x}/{y} scheme) covering a lat/lon bbox into an offscreen canvas,
// independent of whatever's actually rendered in the live Leaflet map.
// Used by the road tracer, which needs *both* satellite and lidar imagery
// for a region regardless of which base layer/overlay the user currently
// has toggled on screen (see roadTrace.ts).
//
// Not used by the building tracer, which instead reads Leaflet's own
// already-loaded tile <img> elements straight out of the DOM (see
// mapCapture.ts) — that's simpler and avoids a duplicate fetch when the
// relevant imagery (satellite) is already on screen.

export interface LatLonBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface TileGrid {
  zoom: number;
  widthPx: number;
  heightPx: number;
  // Web Mercator pixel-space origin (in "world pixels" at this zoom) of the
  // mosaic canvas's top-left corner — everything else is derived from this.
  originPxX: number;
  originPxY: number;
  pixelToLatLon: (x: number, y: number) => { lat: number; lon: number };
  latLonToPixel: (lat: number, lon: number) => { x: number; y: number };
}

const TILE_SIZE = 256;

function lonToWorldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}
function latToWorldY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    TILE_SIZE *
    2 ** zoom
  );
}
function worldXToLon(x: number, zoom: number): number {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}
function worldYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// Builds the pixel-space grid for a bbox at a given zoom, without fetching
// anything yet — callers use this to size the mosaic and to convert
// between pixel and lat/lon coordinates both before and after fetching.
export function computeTileGrid(bbox: LatLonBounds, zoom: number): TileGrid {
  const x0 = lonToWorldX(bbox.west, zoom);
  const x1 = lonToWorldX(bbox.east, zoom);
  // North has a smaller world-Y than south (Y grows downward/southward).
  const y0 = latToWorldY(bbox.north, zoom);
  const y1 = latToWorldY(bbox.south, zoom);
  const originPxX = Math.floor(Math.min(x0, x1));
  const originPxY = Math.floor(Math.min(y0, y1));
  const widthPx = Math.max(1, Math.ceil(Math.max(x0, x1) - originPxX));
  const heightPx = Math.max(1, Math.ceil(Math.max(y0, y1) - originPxY));
  return {
    zoom,
    widthPx,
    heightPx,
    originPxX,
    originPxY,
    pixelToLatLon: (x, y) => ({
      lat: worldYToLat(originPxY + y, zoom),
      lon: worldXToLon(originPxX + x, zoom),
    }),
    latLonToPixel: (lat, lon) => ({
      x: lonToWorldX(lon, zoom) - originPxX,
      y: latToWorldY(lat, zoom) - originPxY,
    }),
  };
}

function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

// Fetches every tile overlapping `grid` from `urlTemplate` and draws it
// into an offscreen canvas at the right offset. A tile that fails to load
// (network error, 404, out-of-coverage at this zoom) is just left blank —
// callers treat blank regions as "no signal" from that source rather than
// failing the whole mosaic, since the road tracer is designed to fuse two
// independent sources and tolerate one having gaps.
export async function fetchTileMosaic(
  urlTemplate: string,
  grid: TileGrid
): Promise<{ canvas: HTMLCanvasElement; loadedTileCount: number; totalTileCount: number }> {
  const canvas = document.createElement("canvas");
  canvas.width = grid.widthPx;
  canvas.height = grid.heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const minTileX = Math.floor(grid.originPxX / TILE_SIZE);
  const minTileY = Math.floor(grid.originPxY / TILE_SIZE);
  const maxTileX = Math.floor((grid.originPxX + grid.widthPx - 1) / TILE_SIZE);
  const maxTileY = Math.floor((grid.originPxY + grid.heightPx - 1) / TILE_SIZE);

  const loads: Promise<void>[] = [];
  let loadedTileCount = 0;
  let totalTileCount = 0;
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      totalTileCount++;
      const dx = tx * TILE_SIZE - grid.originPxX;
      const dy = ty * TILE_SIZE - grid.originPxY;
      loads.push(
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          // A single tile request can stall indefinitely under a flaky
          // network without ever firing onload/onerror (confirmed
          // empirically this session) — bound each tile so one bad
          // connection can't hang the whole mosaic forever.
          const timer = setTimeout(() => resolve(), 15000);
          img.onload = () => {
            clearTimeout(timer);
            try {
              ctx.drawImage(img, dx, dy);
              loadedTileCount++;
            } catch {
              // Tainted/undecodable — leave that region blank.
            }
            resolve();
          };
          img.onerror = () => {
            clearTimeout(timer);
            resolve(); // leave blank, don't fail the mosaic
          };
          img.src = tileUrl(urlTemplate, grid.zoom, tx, ty);
        })
      );
    }
  }
  await Promise.all(loads);
  return { canvas, loadedTileCount, totalTileCount };
}
