// Classical-CV road/path centerline tracer — no ML model, since a road is
// a thin ridge (the point equidistant from its two edges), not a filled
// blob SAM-style segmentation would give a region for.
//
// Pulls BOTH Esri satellite imagery and this app's USGS lidar hillshade
// proxy for the traced region — independent of whichever base layer/overlay
// the user currently has toggled in the live map view — and fuses an
// edge/cost signal from each before path-finding. The two are
// complementary: satellite shows pavement color/contrast (good in the
// open, weak under tree canopy or heavy shadow), lidar shows grading and
// drainage relief (good under canopy or dense shadow, weak on a flat paved
// lot with no grade change). Fusing via a per-pixel MIN of the two cost
// surfaces means a spot either source is confident is cheap (i.e.
// plausibly the road's centerline) pulls the path toward it, so one
// source's blind spot doesn't drag the whole path off course as long as
// the other source has signal there.
import { computeTileGrid, fetchTileMosaic, type TileGrid } from "./tileMosaic";
import { SATELLITE_TILE_URL } from "./baseLayer";
import { USGS_LIDAR_TILE_URL } from "./lidar";
import { douglasPeucker, type Pt } from "./traceGeometry";

export interface LatLon {
  lat: number;
  lon: number;
}

// Keeps mosaics (and therefore the A* search grid) from growing
// unboundedly large for a long waypoint-to-waypoint hop — bounds both
// fetch/stitch cost and path-finding runtime.
const MAX_MOSAIC_DIM = 1100;
const CORRIDOR_HALF_WIDTH_PX = 90;
const SIMPLIFY_EPSILON_PX = 2.5;

function grayscaleWithAlpha(canvas: HTMLCanvasElement): { gray: Float32Array; alpha: Uint8Array; w: number; h: number } {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  const alpha = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    alpha[p] = data[i + 3];
  }
  return { gray, alpha, w, h };
}

// 3x3 Sobel operator, magnitude only (direction isn't needed here).
function sobelMagnitude(gray: Float32Array, w: number, h: number): Float32Array {
  const mag = new Float32Array(w * h);
  const at = (x: number, y: number) => gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      mag[y * w + x] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

// Two-pass chamfer (approximate Euclidean) distance transform: for each
// pixel, distance to the nearest pixel where `edge` is truthy.
function chamferDistanceTransform(edge: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e8;
  const dist = new Float32Array(w * h).fill(INF);
  for (let i = 0; i < w * h; i++) if (edge[i]) dist[i] = 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? INF : dist[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + Math.SQRT2, at(x + 1, y - 1) + Math.SQRT2);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      dist[i] = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + Math.SQRT2, at(x - 1, y + 1) + Math.SQRT2);
    }
  }
  return dist;
}

// The real bug behind "the trace wanders off into a field/lot for no
// reason": a bare `1 / (1 + dist)` cost keeps getting CHEAPER the farther
// a pixel is from any edge, with no ceiling — so a big open field 30px
// from the nearest edge scored roughly 5x cheaper than the actual road
// centerline (which sits only ~5px from its own two edges). That's not
// randomness, it's the pathfinder correctly finding the objectively
// cheapest route under a cost surface that rewards open space over the
// road itself (confirmed by hand: cost(5)=0.167 vs cost(30)=0.032).
// Capping the distance credit at a plausible real road half-width fixes
// this — past that cap, being farther from an edge buys nothing further,
// so an open field and the road's own centerline become cost-competitive
// instead of the field strictly winning, and the corridor/baseline-step
// cost then keeps the path from wandering somewhere that offers no actual
// advantage.
const ASSUMED_MAX_ROAD_HALF_WIDTH_M = 12; // generous — covers most residential/collector roads plus verge

function metersPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

// Builds a per-pixel traversal cost surface from one imagery source: low
// near the ridge equidistant between edges (the presumed centerline), high
// right on an edge, +Infinity where this source has no data at all (a
// blank/failed tile) so a blank patch never looks artificially attractive.
function buildCostSurface(canvas: HTMLCanvasElement, maxDistPx: number): Float32Array {
  const { gray, alpha, w, h } = grayscaleWithAlpha(canvas);
  const mag = sobelMagnitude(gray, w, h);
  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
  const threshold = maxMag * 0.18; // moderate edges count; tuned loosely, not from a real dataset
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) edge[i] = mag[i] > threshold ? 1 : 0;
  const dist = chamferDistanceTransform(edge, w, h);
  const cost = new Float32Array(w * h);
  for (let i = 0; i < cost.length; i++) {
    const cappedDist = Math.min(dist[i], maxDistPx);
    cost[i] = alpha[i] === 0 ? Infinity : 1 / (1 + cappedDist);
  }
  return cost;
}

interface MinHeapNode {
  f: number;
  i: number;
}
class MinHeap {
  private a: MinHeapNode[] = [];
  push(node: MinHeapNode) {
    this.a.push(node);
    let i = this.a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.a[parent].f <= this.a[i].f) break;
      [this.a[parent], this.a[i]] = [this.a[i], this.a[parent]];
      i = parent;
    }
  }
  pop(): MinHeapNode | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < this.a.length && this.a[l].f < this.a[smallest].f) smallest = l;
        if (r < this.a.length && this.a[r].f < this.a[smallest].f) smallest = r;
        if (smallest === i) break;
        [this.a[smallest], this.a[i]] = [this.a[i], this.a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

const BASELINE_STEP_COST = 0.12; // keeps the A* heuristic admissible and discourages needless wiggling

// A* from `start` to `end` pixel, restricted to a corridor around the
// straight line between them (bounds both the search space and runtime).
function aStarPath(cost: Float32Array, w: number, h: number, start: Pt, end: Pt): Pt[] | null {
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  const ex = Math.round(end.x);
  const ey = Math.round(end.y);
  const dx = ex - sx;
  const dy = ey - sy;
  const lineLenSq = dx * dx + dy * dy || 1;

  function inCorridor(x: number, y: number): boolean {
    const t = ((x - sx) * dx + (y - sy) * dy) / lineLenSq;
    const clampedT = Math.max(-0.05, Math.min(1.05, t));
    const px = sx + clampedT * dx;
    const py = sy + clampedT * dy;
    return Math.hypot(x - px, y - py) <= CORRIDOR_HALF_WIDTH_PX;
  }

  const idx = (x: number, y: number) => y * w + x;
  const startI = idx(sx, sy);
  const endI = idx(ex, ey);

  const gScore = new Float32Array(w * h).fill(Infinity);
  const visited = new Uint8Array(w * h);
  const cameFrom = new Int32Array(w * h).fill(-1);
  gScore[startI] = 0;

  const heap = new MinHeap();
  const heuristic = (x: number, y: number) => Math.hypot(ex - x, ey - y) * BASELINE_STEP_COST;
  heap.push({ f: heuristic(sx, sy), i: startI });

  const neighbors: [number, number, number][] = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2],
  ];

  let iterations = 0;
  const maxIterations = w * h * 4 + 10000;
  while (heap.size > 0 && iterations < maxIterations) {
    iterations++;
    const cur = heap.pop()!;
    if (visited[cur.i]) continue;
    visited[cur.i] = 1;
    if (cur.i === endI) break;
    const cx = cur.i % w;
    const cy = (cur.i - cx) / w;
    for (const [ddx, ddy, stepLen] of neighbors) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!inCorridor(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (visited[ni]) continue;
      const c = cost[ni];
      if (!isFinite(c)) continue;
      const stepCost = stepLen * (BASELINE_STEP_COST + c);
      const tentativeG = gScore[cur.i] + stepCost;
      if (tentativeG < gScore[ni]) {
        gScore[ni] = tentativeG;
        cameFrom[ni] = cur.i;
        heap.push({ f: tentativeG + heuristic(nx, ny), i: ni });
      }
    }
  }

  if (!visited[endI]) return null;

  const path: Pt[] = [];
  let cur = endI;
  const guard = w * h + 10;
  let steps = 0;
  while (cur !== -1 && steps < guard) {
    const x = cur % w;
    const y = (cur - x) / w;
    path.push({ x, y });
    if (cur === startI) break;
    cur = cameFrom[cur];
    steps++;
  }
  path.reverse();
  return path;
}

function padBounds(a: LatLon, b: LatLon) {
  const south = Math.min(a.lat, b.lat);
  const north = Math.max(a.lat, b.lat);
  const west = Math.min(a.lon, b.lon);
  const east = Math.max(a.lon, b.lon);
  const latPad = Math.max((north - south) * 0.35, 0.0006);
  const lonPad = Math.max((east - west) * 0.35, 0.0006);
  return { south: south - latPad, north: north + latPad, west: west - lonPad, east: east + lonPad };
}

export interface RoadTraceResult {
  points: LatLon[];
  sourcesUsed: { satellite: boolean; lidar: boolean };
  fellBackToStraightLine: boolean;
}

// Traces a plausible road/path centerline between two waypoints. Always
// returns a usable polyline segment — if pathfinding can't find a corridor
// route (e.g. both imagery sources had no usable data), it falls back to a
// straight line between the two points rather than failing the whole
// multi-waypoint draft, and says so via `fellBackToStraightLine`.
export async function traceRoadSegment(start: LatLon, end: LatLon, preferredZoom: number): Promise<RoadTraceResult> {
  const bounds = padBounds(start, end);
  let zoom = Math.round(preferredZoom);
  let grid: TileGrid = computeTileGrid(bounds, zoom);
  while ((grid.widthPx > MAX_MOSAIC_DIM || grid.heightPx > MAX_MOSAIC_DIM) && zoom > 1) {
    zoom -= 1;
    grid = computeTileGrid(bounds, zoom);
  }

  const [satelliteMosaic, lidarMosaic] = await Promise.all([
    fetchTileMosaic(SATELLITE_TILE_URL, grid).catch(() => null),
    fetchTileMosaic(USGS_LIDAR_TILE_URL, grid).catch(() => null),
  ]);

  const satelliteOk = !!satelliteMosaic && satelliteMosaic.loadedTileCount > 0;
  const lidarOk = !!lidarMosaic && lidarMosaic.loadedTileCount > 0;
  if (!satelliteOk && !lidarOk) {
    throw new Error("Could not load satellite or lidar imagery for this area");
  }

  const avgLat = (start.lat + end.lat) / 2;
  const maxDistPx = Math.max(3, ASSUMED_MAX_ROAD_HALF_WIDTH_M / metersPerPixel(zoom, avgLat));
  const costA = satelliteOk ? buildCostSurface(satelliteMosaic!.canvas, maxDistPx) : null;
  const costB = lidarOk ? buildCostSurface(lidarMosaic!.canvas, maxDistPx) : null;
  const fused = new Float32Array(grid.widthPx * grid.heightPx);
  for (let i = 0; i < fused.length; i++) {
    const a = costA ? costA[i] : Infinity;
    const b = costB ? costB[i] : Infinity;
    fused[i] = Math.min(a, b);
  }

  const startPx = grid.latLonToPixel(start.lat, start.lon);
  const endPx = grid.latLonToPixel(end.lat, end.lon);
  const rawPath = aStarPath(fused, grid.widthPx, grid.heightPx, startPx, endPx);

  const sourcesUsed = { satellite: satelliteOk, lidar: lidarOk };
  if (!rawPath || rawPath.length < 2) {
    return { points: [start, end], sourcesUsed, fellBackToStraightLine: true };
  }

  const simplified = douglasPeucker(rawPath, SIMPLIFY_EPSILON_PX);
  const points = simplified.map((p) => grid.pixelToLatLon(p.x, p.y));
  // Snap the endpoints exactly to the requested waypoints (the traced path
  // starts/ends on integer pixel centers, which round-trips to a lat/lon a
  // hair off from the click that was actually requested).
  points[0] = start;
  points[points.length - 1] = end;
  return { points, sourcesUsed, fellBackToStraightLine: false };
}
