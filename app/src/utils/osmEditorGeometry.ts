import type {
  OsmEditorElement,
  OsmEditorNodeGeometry,
  OsmEditorRelationGeometry,
  OsmEditorWayGeometry,
  PointTag,
} from "../api";

// OSM elements store tags as a plain Record<string,string> (that's the wire
// shape server/src/routes/osmEditor.ts hands back); TagsEditor.tsx works in
// terms of PointTag[] (this app's own {key,value} shape) — these convert at
// the boundary so TagsEditor can be reused as-is for OSM tags too.
export function tagsRecordToList(tags: Record<string, string>): PointTag[] {
  return Object.entries(tags).map(([key, value]) => ({ key, value }));
}

export function tagsListToRecord(tags: PointTag[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const t of tags) if (t.key.trim()) record[t.key.trim()] = t.value;
  return record;
}

// A stable identity for one element in the working set — same shape as
// osm.ts's osmElementKey, kept separate since this side's elements carry
// version/action/full-tag state the read-only layer's OsmElement doesn't.
export function osmEditorElementKey(type: OsmEditorElement["type"], id: number): string {
  return `${type}/${id}`;
}

export function nodeGeometry(el: OsmEditorElement): OsmEditorNodeGeometry {
  return el.geometry as OsmEditorNodeGeometry;
}
export function wayGeometry(el: OsmEditorElement): OsmEditorWayGeometry {
  return el.geometry as OsmEditorWayGeometry;
}
export function relationGeometry(el: OsmEditorElement): OsmEditorRelationGeometry {
  return el.geometry as OsmEditorRelationGeometry;
}

// The handful of tag keys that most often mean "this closed way is an area
// you'd fill in, not just a loop-shaped line" — a simple heuristic (not
// meant to be a complete areal-tag ruleset) good enough to tell a building
// footprint or a park boundary from an ordinary closed way like a
// roundabout.
const AREAL_TAG_KEYS = ["building", "landuse", "natural", "leisure", "area:highway"];

export function wayIsClosed(way: OsmEditorWayGeometry): boolean {
  return way.nodeIds.length >= 4 && way.nodeIds[0] === way.nodeIds[way.nodeIds.length - 1];
}

export function wayLooksAreal(el: OsmEditorElement): boolean {
  if (el.type !== "way") return false;
  const way = wayGeometry(el);
  if (!wayIsClosed(way)) return false;
  if (el.tags.area === "no") return false;
  return AREAL_TAG_KEYS.some((k) => el.tags[k] !== undefined) || el.tags.area === "yes";
}

// Resolves a way's node ids to actual lat/lon pairs, skipping any id whose
// node isn't in the working set (can happen if a way references a node
// outside the downloaded area — nothing to draw for that vertex).
export function wayLatLngs(
  el: OsmEditorElement,
  nodesById: Map<number, OsmEditorElement>
): [number, number][] {
  return wayGeometry(el)
    .nodeIds.map((id) => nodesById.get(id))
    .filter((n): n is OsmEditorElement => n !== undefined)
    .map((n) => {
      const g = nodeGeometry(n);
      return [g.lat, g.lon] as [number, number];
    });
}

export function elementDisplayName(el: OsmEditorElement): string {
  return el.tags.name ?? el.tags["name:en"] ?? `${el.type} ${el.id}`;
}
