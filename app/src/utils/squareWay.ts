// "Square selection" — JOSM calls this Orthogonalize (its Q shortcut):
// nudges a way's vertices so its edges snap to alternating parallel/
// perpendicular directions, straightening the slightly-off corners a real
// building almost always has after hand-drawing or AI-tracing it. Only
// makes sense for a roughly rectilinear shape (the overwhelming majority of
// real building footprints — rectangular, L-shaped, T-shaped, etc.) — a
// genuinely diagonal wall gets rounded to whichever axis it's closer to,
// same limitation JOSM's own version has.
export interface LatLon {
  lat: number;
  lon: number;
}

// Union-find over vertex indices — used twice (once for "these vertices
// must share a u coordinate", once for v) since a shared edge constraint is
// really an equivalence relation, and a vertex can end up pulled into a
// group by either of its two adjacent edges.
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

// Squares a way's node list in place (geometrically) and returns the new
// positions in the same order/length as the input — including the
// duplicated closing point for a closed way, so callers don't need to
// special-case it. Returns null if there isn't a real ring to square
// (fewer than 3 distinct vertices).
export function squareWayNodes(nodes: LatLon[]): LatLon[] | null {
  const isClosed = nodes.length > 3 && nodes[0].lat === nodes[nodes.length - 1].lat && nodes[0].lon === nodes[nodes.length - 1].lon;
  const ring = isClosed ? nodes.slice(0, -1) : nodes;
  const n = ring.length;
  if (n < 3) return null;

  // Flat local projection around the ring's own latitude — lat/lon degrees
  // aren't equal-area, so squaring directly in raw coordinates would skew
  // with latitude; this only needs to be locally consistent, not a real
  // map projection.
  const avgLat = ring.reduce((s, p) => s + p.lat, 0) / n;
  const cosLat = Math.cos((avgLat * Math.PI) / 180) || 1e-9;
  const toXY = (p: LatLon) => ({ x: p.lon * cosLat, y: p.lat });

  const pts = ring.map(toXY);

  // Reference direction = the longest edge's angle — the dominant wall of
  // the building is the most reliable thing to align everything else to.
  let longestLen = -1;
  let refAngle = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > longestLen) {
      longestLen = len;
      refAngle = Math.atan2(dy, dx);
    }
  }

  // Rotate into a (u, v) frame where u runs along refAngle and v
  // perpendicular to it — an edge parallel to the reference becomes
  // "constant v", one perpendicular to it becomes "constant u".
  const cosR = Math.cos(refAngle);
  const sinR = Math.sin(refAngle);
  const uv = pts.map((p) => ({ u: p.x * cosR + p.y * sinR, v: -p.x * sinR + p.y * cosR }));

  const uGroups = new UnionFind(n); // vertices that must share a u
  const vGroups = new UnionFind(n); // vertices that must share a v

  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) continue; // duplicate/zero-length edge — nothing to classify
    const rel = Math.atan2(dy, dx) - refAngle;
    const norm = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const snapped = Math.round(norm / (Math.PI / 2)) % 2; // 0 = parallel to ref, 1 = perpendicular
    const j = (i + 1) % n;
    if (snapped === 0) vGroups.union(i, j); // parallel edge -> shared v
    else uGroups.union(i, j); // perpendicular edge -> shared u
  }

  function groupAverages(groups: UnionFind, values: number[]): number[] {
    const sums = new Map<number, { total: number; count: number }>();
    for (let i = 0; i < n; i++) {
      const root = groups.find(i);
      const entry = sums.get(root) ?? { total: 0, count: 0 };
      entry.total += values[i];
      entry.count += 1;
      sums.set(root, entry);
    }
    return Array.from({ length: n }, (_, i) => {
      const entry = sums.get(groups.find(i))!;
      return entry.total / entry.count;
    });
  }

  const newU = groupAverages(uGroups, uv.map((p) => p.u));
  const newV = groupAverages(vGroups, uv.map((p) => p.v));

  // Rotate back out of the (u, v) frame, then out of the flat projection.
  const squaredRing = ring.map((_, i) => {
    const u = newU[i];
    const v = newV[i];
    const x = u * cosR - v * sinR;
    const y = u * sinR + v * cosR;
    return { lat: y, lon: x / cosLat };
  });

  return isClosed ? [...squaredRing, squaredRing[0]] : squaredRing;
}
