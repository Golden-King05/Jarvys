// Small, dependency-free raster/polyline geometry helpers shared by the two
// AI-assisted tracing tools (mobileSam.ts for the building tracer,
// roadTrace.ts for the road centerline tracer).

export interface Pt {
  x: number;
  y: number;
}

// Ramer-Douglas-Peucker polyline simplification. Keeps the first and last
// points fixed; recursively drops points that lie within `epsilon` pixels
// of the line between the current segment's endpoints. Used to turn a
// one-point-per-pixel-step raw trace into a sane number of vertices before
// converting to lat/lon and creating OSM nodes.
export function douglasPeucker(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points;

  function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    // Distance from p to the infinite line through a,b.
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
  }

  function simplify(pts: Pt[]): Pt[] {
    if (pts.length < 3) return pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistance(pts[i], first, last);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist <= epsilon) return [first, last];
    const left = simplify(pts.slice(0, maxIdx + 1));
    const right = simplify(pts.slice(maxIdx));
    return [...left.slice(0, -1), ...right];
  }

  // Recursion depth for a raw pixel-boundary trace (thousands of points)
  // can blow the stack with the naive recursive form above; iterate over
  // large inputs in coarse chunks first to bound recursion depth, then
  // finish with a normal DP pass over the (much smaller) result.
  const CHUNK = 500;
  if (points.length > CHUNK * 4) {
    const pre: Pt[] = [points[0]];
    for (let i = CHUNK; i < points.length - 1; i += CHUNK) {
      const chunk = points.slice(i - CHUNK, Math.min(i + 1, points.length));
      const reduced = simplify(chunk);
      pre.push(...reduced.slice(1));
    }
    if (pre[pre.length - 1] !== points[points.length - 1]) pre.push(points[points.length - 1]);
    return simplify(pre);
  }
  return simplify(points);
}

// Labels 4-connected foreground components of a binary mask (1 = mask,
// non-4-connected diagonal touches don't count, matching how the mask is
// eventually filled) and returns the component containing `seedX,seedY` —
// or, if that exact pixel isn't foreground (the click landed a pixel or two
// off the mask boundary, which happens), the nearest foreground pixel
// within a small search radius instead. Returns null if nothing foreground
// is found nearby at all.
export function connectedComponentAt(
  mask: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number
): Uint8Array | null {
  const idx = (x: number, y: number) => y * width + x;
  let sx = seedX;
  let sy = seedY;
  if (!mask[idx(sx, sy)]) {
    let found = false;
    for (let r = 1; r <= 24 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const x = seedX + dx;
          const y = seedY + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          if (mask[idx(x, y)]) {
            sx = x;
            sy = y;
            found = true;
          }
        }
      }
    }
    if (!found) return null;
  }

  const out = new Uint8Array(width * height);
  const stack: number[] = [idx(sx, sy)];
  out[idx(sx, sy)] = 1;
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    const neighbors: [number, number][] = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny);
      if (mask[ni] && !out[ni]) {
        out[ni] = 1;
        stack.push(ni);
      }
    }
  }
  return out;
}

// Moore-neighbor boundary tracing: walks the outer contour of a single
// connected binary blob (8-connectivity) and returns it as an ordered,
// closed ring of pixel-center points (first point repeated at the end).
// Standard algorithm — see e.g. Gonzalez & Woods; equivalent in spirit to
// marching squares for this purpose (both turn a raster mask edge into a
// vector contour), simpler to get right for a single-blob binary mask like
// a SAM output where we don't need marching squares' sub-pixel
// interpolation between mixed cells.
export function traceComponentBoundary(mask: Uint8Array, width: number, height: number): Pt[] | null {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x]);

  // Find the topmost, then leftmost-within-that-row, foreground pixel —
  // guaranteed to have background immediately to its west, which fixes a
  // safe, unambiguous starting direction for the tracer.
  let startX = -1;
  let startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y)) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX === -1) return null;

  // 8 neighbor directions in clockwise order starting from "west".
  const dirs: [number, number][] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];

  const boundary: Pt[] = [];
  let cx = startX;
  let cy = startY;
  // The pixel we arrived "from" was background to the west of start.
  let backtrackDir = 0; // index into dirs pointing west
  const maxSteps = width * height * 4 + 8;
  let steps = 0;
  do {
    boundary.push({ x: cx + 0.5, y: cy + 0.5 });
    let dir = (backtrackDir + 1) % 8; // start scanning just past where we came from
    let found = false;
    for (let i = 0; i < 8; i++) {
      const [ddx, ddy] = dirs[dir];
      const nx = cx + ddx;
      const ny = cy + ddy;
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        backtrackDir = (dir + 4) % 8; // direction back to the pixel we just left
        found = true;
        break;
      }
      dir = (dir + 1) % 8;
    }
    if (!found) break; // isolated single pixel
    steps++;
  } while ((cx !== startX || cy !== startY) && steps < maxSteps);

  boundary.push({ x: startX + 0.5, y: startY + 0.5 });
  return boundary;
}
