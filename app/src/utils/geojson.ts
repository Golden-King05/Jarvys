export type GeoJsonGeometry = { type: string; coordinates: unknown };

// Only the outer ring of each polygon — good enough to shade a region on a
// map, not meant to render holes/enclaves precisely.
export function outerRings(geometry: GeoJsonGeometry): [number, number][][] {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as [number, number][][];
    return rings.length ? [rings[0]] : [];
  }
  if (geometry.type === "MultiPolygon") {
    const polys = geometry.coordinates as [number, number][][][];
    return polys.map((p) => p[0]).filter((r): r is [number, number][] => Boolean(r));
  }
  return [];
}
