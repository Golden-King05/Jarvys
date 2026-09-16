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

// Area fill colors by feature type — the same rough hues OSM's own standard
// map style (and JOSM/iD) use, so they read as familiar rather than
// arbitrary: buildings tan, water blue, forest/wood green, grass/parks
// lighter green, farmland pale yellow, parking a dull yellow-grey,
// residential/commercial/industrial land pale neutral tints. Checked in
// priority order (a feature can carry several matching tags at once —
// building takes precedence since it's the physical structure). Editing
// state (new/modified/deleted) stays on the OUTLINE color (actionColor, in
// OsmEditorMap.web.tsx) rather than the fill, so both are visible on the
// same shape at once — what it is vs. what you've done to it.
const AREA_FILL_RULES: { test: (tags: Record<string, string>) => boolean; color: string }[] = [
  { test: (t) => t.building !== undefined, color: "#d9c9a8" },
  { test: (t) => t.natural === "water" || t.landuse === "reservoir" || t.waterway === "riverbank", color: "#8fc3e0" },
  { test: (t) => t.natural === "wetland", color: "#8fd0c8" },
  { test: (t) => t.natural === "wood" || t.landuse === "forest", color: "#9dca8a" },
  { test: (t) => t.natural === "sand" || t.natural === "beach", color: "#f2e6b3" },
  { test: (t) => t.landuse === "grass" || t.leisure === "park" || t.leisure === "garden", color: "#c8eaa0" },
  { test: (t) => t.leisure === "pitch" || t.leisure === "sports_centre" || t.leisure === "golf_course", color: "#b3e0a0" },
  { test: (t) => t.landuse === "farmland" || t.landuse === "farmyard" || t.landuse === "orchard", color: "#eef0c5" },
  { test: (t) => t.amenity === "parking" || t.landuse === "garages", color: "#e0d9a0" },
  { test: (t) => t.landuse === "residential", color: "#e3e0dc" },
  { test: (t) => t.landuse === "commercial" || t.landuse === "retail", color: "#f0cdd0" },
  { test: (t) => t.landuse === "industrial", color: "#e6d3ea" },
  { test: (t) => t.amenity === "school" || t.amenity === "university" || t.amenity === "hospital", color: "#f2d9a8" },
];
const AREA_FILL_DEFAULT = "#c4c4c4"; // no recognized area-type tag yet

export function areaFillColor(tags: Record<string, string>): string {
  return AREA_FILL_RULES.find((rule) => rule.test(tags))?.color ?? AREA_FILL_DEFAULT;
}

// A curated (not exhaustive — OSM's real tag vocabulary runs into the
// thousands) set of common node presets, each mapped to the emoji OSM's
// own wiki uses to illustrate that feature, matching this app's existing
// style of emoji-as-icon (the toolbar's own gear/map buttons) rather than
// a bundled icon-sprite asset. Checked in priority order; a node without a
// match here falls back to JOSM's own plain, unobtrusive default node
// look (see nodeIcon in OsmEditorMap.web.tsx / OsmEditorMap.tsx) instead
// of a made-up generic icon.
const NODE_ICON_RULES: { test: (tags: Record<string, string>) => boolean; icon: string }[] = [
  // Natural
  { test: (t) => t.natural === "tree", icon: "🌳" },
  { test: (t) => t.natural === "peak", icon: "🗻" },
  { test: (t) => t.natural === "volcano", icon: "🌋" },
  { test: (t) => t.natural === "spring", icon: "💧" },
  { test: (t) => t.natural === "cave_entrance", icon: "🕳️" },
  { test: (t) => t.natural === "beach", icon: "🏖️" },
  { test: (t) => t.natural === "saddle" || t.natural === "cliff", icon: "⛰️" },
  // Amenities
  { test: (t) => t.amenity === "restaurant", icon: "🍽️" },
  { test: (t) => t.amenity === "fast_food", icon: "🍔" },
  { test: (t) => t.amenity === "cafe", icon: "☕" },
  { test: (t) => t.amenity === "bar" || t.amenity === "pub", icon: "🍺" },
  { test: (t) => t.amenity === "ice_cream", icon: "🍦" },
  { test: (t) => t.amenity === "bank", icon: "🏦" },
  { test: (t) => t.amenity === "atm", icon: "🏧" },
  { test: (t) => t.amenity === "hospital", icon: "🏥" },
  { test: (t) => t.amenity === "pharmacy", icon: "💊" },
  { test: (t) => t.amenity === "dentist" || t.amenity === "clinic" || t.amenity === "doctors", icon: "⚕️" },
  { test: (t) => t.amenity === "school", icon: "🏫" },
  { test: (t) => t.amenity === "university" || t.amenity === "college", icon: "🎓" },
  { test: (t) => t.amenity === "library", icon: "📚" },
  { test: (t) => t.amenity === "fuel", icon: "⛽" },
  { test: (t) => t.amenity === "charging_station", icon: "🔌" },
  { test: (t) => t.amenity === "parking", icon: "🅿️" },
  { test: (t) => t.amenity === "bicycle_parking" || t.amenity === "bicycle_rental", icon: "🚲" },
  { test: (t) => t.amenity === "drinking_water", icon: "🚰" },
  { test: (t) => t.amenity === "toilets", icon: "🚻" },
  { test: (t) => t.amenity === "bench", icon: "🪑" },
  { test: (t) => t.amenity === "waste_basket", icon: "🗑️" },
  { test: (t) => t.amenity === "place_of_worship", icon: "⛪" },
  { test: (t) => t.amenity === "fire_station", icon: "🚒" },
  { test: (t) => t.amenity === "police", icon: "🚓" },
  { test: (t) => t.amenity === "post_office" || t.amenity === "post_box", icon: "📮" },
  { test: (t) => t.amenity === "theatre", icon: "🎭" },
  { test: (t) => t.amenity === "cinema", icon: "🎬" },
  { test: (t) => t.amenity === "recycling", icon: "♻️" },
  { test: (t) => t.amenity === "car_wash", icon: "🚗" },
  { test: (t) => t.amenity === "telephone", icon: "☎️" },
  { test: (t) => t.amenity === "kindergarten", icon: "🧸" },
  // Shops
  { test: (t) => t.shop === "supermarket", icon: "🛒" },
  { test: (t) => t.shop === "bakery", icon: "🥖" },
  { test: (t) => t.shop === "butcher", icon: "🥩" },
  { test: (t) => t.shop === "clothes", icon: "👕" },
  { test: (t) => t.shop === "hairdresser", icon: "💇" },
  { test: (t) => t.shop === "books", icon: "📚" },
  { test: (t) => t.shop === "convenience", icon: "🏪" },
  { test: (t) => t.shop === "florist", icon: "💐" },
  { test: (t) => t.shop !== undefined, icon: "🏬" }, // any other shop=* — generic storefront
  // Tourism
  { test: (t) => t.tourism === "hotel" || t.tourism === "guest_house" || t.tourism === "motel", icon: "🏨" },
  { test: (t) => t.tourism === "museum", icon: "🏛️" },
  { test: (t) => t.tourism === "attraction", icon: "🎡" },
  { test: (t) => t.tourism === "viewpoint", icon: "🔭" },
  { test: (t) => t.tourism === "camp_site", icon: "🏕️" },
  { test: (t) => t.tourism === "picnic_site", icon: "🧺" },
  { test: (t) => t.tourism === "artwork", icon: "🖼️" },
  { test: (t) => t.tourism === "information", icon: "ℹ️" },
  // Historic
  { test: (t) => t.historic === "monument" || t.historic === "memorial", icon: "🗿" },
  { test: (t) => t.historic === "castle", icon: "🏰" },
  { test: (t) => t.historic === "ruins", icon: "🏛️" },
  // Leisure
  { test: (t) => t.leisure === "playground", icon: "🛝" },
  { test: (t) => t.leisure === "swimming_pool", icon: "🏊" },
  { test: (t) => t.leisure === "sports_centre" || t.leisure === "pitch" || t.leisure === "stadium", icon: "⚽" },
  { test: (t) => t.leisure === "golf_course", icon: "⛳" },
  { test: (t) => t.leisure === "fitness_centre", icon: "🏋️" },
  // Man-made / infrastructure / transport
  { test: (t) => t.man_made === "tower", icon: "🗼" },
  { test: (t) => t.man_made === "lighthouse", icon: "🚨" },
  { test: (t) => t.man_made === "water_well" || t.man_made === "water_tower" || t.man_made === "water_tap", icon: "💧" },
  { test: (t) => t.man_made === "windmill", icon: "🎡" },
  { test: (t) => t.man_made === "communications_tower", icon: "📡" },
  { test: (t) => t.railway === "station" || t.railway === "halt" || t.railway === "tram_stop", icon: "🚉" },
  { test: (t) => t.railway === "level_crossing", icon: "🚦" },
  { test: (t) => t.aeroway === "aerodrome", icon: "✈️" },
  { test: (t) => t.highway === "bus_stop", icon: "🚌" },
  { test: (t) => t.highway === "traffic_signals", icon: "🚦" },
  { test: (t) => t.highway === "crossing", icon: "🚸" },
  { test: (t) => t.barrier === "gate" || t.barrier === "lift_gate" || t.barrier === "bollard", icon: "🚧" },
  { test: (t) => t.power === "tower" || t.power === "pole" || t.power === "generator", icon: "⚡" },
  { test: (t) => t.emergency === "defibrillator", icon: "🫀" },
  { test: (t) => t.emergency !== undefined, icon: "🚑" },
];

// Returns the OSM-wiki-style emoji for a node's tags, or null when nothing
// matches — the caller then falls back to a plain, unobtrusive marker
// (this app's version of JOSM's own default node rendering) rather than a
// made-up generic icon.
export function nodeIconGlyph(tags: Record<string, string>): string | null {
  return NODE_ICON_RULES.find((rule) => rule.test(tags))?.icon ?? null;
}

// Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by) —
// plain 2D math, usable in any consistent unit (screen pixels in
// practice, for the click-candidate search in OsmEditorMap.web.tsx).
export function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
