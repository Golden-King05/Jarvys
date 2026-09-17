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

// A large (though not exhaustive — OSM's real tag vocabulary runs into the
// thousands) set of node presets mapped to emoji, matching this app's
// existing style of emoji-as-icon (the toolbar's own gear/map buttons)
// rather than a bundled icon-sprite asset. The tag coverage here is
// derived from JOSM's own defaultpresets.xml (josm.openstreetmap.de/svn/
// trunk/resources/data/defaultpresets.xml) — the same tagging vocabulary
// JOSM itself recognizes — with each preset's real icon mapped to the
// closest matching emoji; a handful of generic per-key fallbacks at the
// end catch values JOSM's own list doesn't happen to include. Checked in
// priority order; a node without any match falls back to JOSM's own
// plain, unobtrusive default node look (see nodeIcon in
// OsmEditorMap.web.tsx / OsmEditorMap.tsx) instead of a made-up icon.
const NODE_ICON_RULES: { test: (tags: Record<string, string>) => boolean; icon: string }[] = [
  { test: (t) => ["column", "billboard", "poster_box", "totem"].includes(t.advertising), icon: "🎡" },
  { test: (t) => ["station", "pylon"].includes(t.aerialway), icon: "🚏" },
  { test: (t) => ["holding_position", "helipad", "hangar", "navigationaid", "windsock", "terminal"].includes(t.aeroway), icon: "✈️" },
  { test: (t) => t.aeroway === "parking_position", icon: "🅿️" },
  { test: (t) => t.aeroway === "gate", icon: "🚧" },
  { test: (t) => t.airmark === "beacon", icon: "✈️" },
  { test: (t) => t.amenity === "ferry_terminal", icon: "⛴️" },
  { test: (t) => ["parking", "parking_space", "trolley_bay", "parking_entrance", "motorcycle_parking", "bicycle_parking"].includes(t.amenity), icon: "🅿️" },
  { test: (t) => t.amenity === "charging_station", icon: "🔌" },
  { test: (t) => ["car_wash", "car_rental", "car_sharing", "driving_school", "driver_training"].includes(t.amenity), icon: "🚗" },
  { test: (t) => ["bicycle_rental", "bicycle_repair_station", "bicycle_wash"].includes(t.amenity), icon: "🚲" },
  { test: (t) => t.amenity === "vending_machine", icon: "🎫" },
  { test: (t) => t.amenity === "bus_station", icon: "🚌" },
  { test: (t) => t.amenity === "taxi", icon: "🚕" },
  { test: (t) => ["restaurant", "food_court"].includes(t.amenity), icon: "🍽️" },
  { test: (t) => t.amenity === "fast_food", icon: "🍔" },
  { test: (t) => ["cafe", "internet_cafe"].includes(t.amenity), icon: "☕" },
  { test: (t) => t.amenity === "ice_cream", icon: "🍦" },
  { test: (t) => ["pub", "biergarten", "bar"].includes(t.amenity), icon: "🍺" },
  { test: (t) => ["cinema", "gambling", "casino", "theatre"].includes(t.amenity), icon: "🎡" },
  { test: (t) => t.amenity === "public_bath", icon: "🛁" },
  { test: (t) => t.amenity === "dive_centre", icon: "🤿" },
  { test: (t) => t.amenity === "events_venue", icon: "🎪" },
  { test: (t) => t.amenity === "bbq", icon: "🍖" },
  { test: (t) => t.amenity === "nightclub", icon: "🍾" },
  { test: (t) => t.amenity === "stripclub", icon: "💃" },
  { test: (t) => t.amenity === "brothel", icon: "🔞" },
  { test: (t) => ["library", "public_bookcase"].includes(t.amenity), icon: "📚" },
  { test: (t) => ["arts_centre", "townhall", "courthouse"].includes(t.amenity), icon: "🏛️" },
  { test: (t) => t.amenity === "studio", icon: "🎙️" },
  { test: (t) => t.amenity === "place_of_worship", icon: "⛪" },
  { test: (t) => t.amenity === "monastery", icon: "🛐" },
  { test: (t) => t.amenity === "community_centre", icon: "🏢" },
  { test: (t) => t.amenity === "prison", icon: "🚔" },
  { test: (t) => t.amenity === "police", icon: "🚓" },
  { test: (t) => t.amenity === "ranger_station", icon: "🌲" },
  { test: (t) => t.amenity === "fire_station", icon: "🚒" },
  { test: (t) => t.amenity === "post_office", icon: "🏤" },
  { test: (t) => t.amenity === "kindergarten", icon: "🧸" },
  { test: (t) => t.amenity === "school", icon: "🏫" },
  { test: (t) => ["university", "college"].includes(t.amenity), icon: "🎓" },
  { test: (t) => t.amenity === "language_school", icon: "🗣️" },
  { test: (t) => t.amenity === "music_school", icon: "🎵" },
  { test: (t) => ["animal_boarding", "animal_breeding", "veterinary", "animal_shelter"].includes(t.amenity), icon: "🐾" },
  { test: (t) => ["hospital", "clinic", "social_facility", "nursing_home"].includes(t.amenity), icon: "🏥" },
  { test: (t) => ["doctors", "baby_hatch"].includes(t.amenity), icon: "⚕️" },
  { test: (t) => t.amenity === "dentist", icon: "🦷" },
  { test: (t) => t.amenity === "pharmacy", icon: "💊" },
  { test: (t) => t.amenity === "social_centre", icon: "🤝" },
  { test: (t) => t.amenity === "toilets", icon: "🚻" },
  { test: (t) => t.amenity === "shower", icon: "🚿" },
  { test: (t) => t.amenity === "post_box", icon: "📮" },
  { test: (t) => ["letter_box", "parcel_locker"].includes(t.amenity), icon: "🛎️" },
  { test: (t) => t.amenity === "telephone", icon: "☎️" },
  { test: (t) => t.amenity === "clock", icon: "🕐" },
  { test: (t) => t.amenity === "photo_booth", icon: "📷" },
  { test: (t) => ["recycling", "sanitary_dump_station"].includes(t.amenity), icon: "♻️" },
  { test: (t) => ["waste_basket", "waste_disposal"].includes(t.amenity), icon: "🗑️" },
  { test: (t) => t.amenity === "bench", icon: "🪑" },
  { test: (t) => t.amenity === "shelter", icon: "🏚️" },
  { test: (t) => t.amenity === "hunting_stand", icon: "📍" },
  { test: (t) => t.amenity === "drinking_water", icon: "🚰" },
  { test: (t) => t.amenity === "water_point", icon: "💧" },
  { test: (t) => t.amenity === "fountain", icon: "⛲" },
  { test: (t) => t.amenity === "marketplace", icon: "🛒" },
  { test: (t) => t.amenity === "bank", icon: "🏦" },
  { test: (t) => t.amenity === "bureau_de_change", icon: "💱" },
  { test: (t) => t.amenity === "money_transfer", icon: "💸" },
  { test: (t) => t.amenity === "atm", icon: "🏧" },
  { test: (t) => ["animal", "water_slide"].includes(t.attraction), icon: "🎡" },
  { test: (t) => ["block", "bollard", "cycle_barrier", "cattle_grid", "bus_trap", "spikes", "toll_booth", "border_control", "jersey_barrier", "log", "kerb", "entrance", "gate", "lift_gate", "swing_gate", "kissing_gate", "wicket_gate", "height_restrictor", "chain", "stile", "turnstile", "full-height_turnstile", "sally_port"].includes(t.barrier), icon: "🚧" },
  { test: (t) => t.boundary === "marker", icon: "📍" },
  { test: (t) => t.building === "construction", icon: "📍" },
  { test: (t) => t.building === "transformer_tower", icon: "⚡" },
  { test: (t) => t.craft === "beekeeper", icon: "🐝" },
  { test: (t) => t.craft === "brewery", icon: "🍺" },
  { test: (t) => t.craft === "winery", icon: "🍷" },
  { test: (t) => t.craft === "caterer", icon: "🍽️" },
  { test: (t) => ["upholsterer", "plumber", "painter", "tiler", "window_construction", "photographer", "handicraft", "metal_construction"].includes(t.craft), icon: "🔧" },
  { test: (t) => ["key_cutter", "locksmith"].includes(t.craft), icon: "🔑" },
  { test: (t) => ["electrician", "electronics_repair"].includes(t.craft), icon: "🔌" },
  { test: (t) => t.craft === "hvac", icon: "❄️" },
  { test: (t) => t.craft === "carpenter", icon: "🪚" },
  { test: (t) => t.craft === "roofer", icon: "🏠" },
  { test: (t) => t.craft === "pottery", icon: "🏺" },
  { test: (t) => t.craft === "gardener", icon: "🌱" },
  { test: (t) => t.craft === "shoemaker", icon: "👞" },
  { test: (t) => t.craft === "sawmill", icon: "🪵" },
  { test: (t) => t.craft === "stonemason", icon: "🧱" },
  { test: (t) => t.craft === "blacksmith", icon: "🔨" },
  { test: (t) => t.emergency === "ambulance_station", icon: "🚑" },
  { test: (t) => ["emergency_ward_entrance", "suction_point", "life_ring", "lifeguard", "siren"].includes(t.emergency), icon: "🚨" },
  { test: (t) => t.emergency === "defibrillator", icon: "🫀" },
  { test: (t) => ["fire_extinguisher", "fire_hose"].includes(t.emergency), icon: "🧯" },
  { test: (t) => t.emergency === "fire_hydrant", icon: "🚒" },
  { test: (t) => t.emergency === "water_tank", icon: "💧" },
  { test: (t) => t.emergency === "assembly_point", icon: "🚩" },
  { test: (t) => t.emergency === "phone", icon: "☎️" },
  { test: (t) => t.geological === "palaeontological_site", icon: "🏛️" },
  { test: (t) => ["tee", "pin", "driving_range"].includes(t.golf), icon: "🏅" },
  { test: (t) => t.healthcare === "laboratory", icon: "🔬" },
  { test: (t) => ["emergency_bay", "toll_gantry"].includes(t.highway), icon: "🚧" },
  { test: (t) => t.highway === "speed_camera", icon: "📷" },
  { test: (t) => t.highway === "trailhead", icon: "📍" },
  { test: (t) => t.highway === "elevator", icon: "🛎️" },
  { test: (t) => ["bus_stop", "platform"].includes(t.highway), icon: "🚌" },
  { test: (t) => t.highway === "emergency_access_point", icon: "🚨" },
  { test: (t) => ["castle", "fort"].includes(t.historic), icon: "🏰" },
  { test: (t) => ["ruins", "archaeological_site", "city_gate", "manor"].includes(t.historic), icon: "🏛️" },
  { test: (t) => t.historic === "battlefield", icon: "⚔️" },
  { test: (t) => t.historic === "church", icon: "⛪" },
  { test: (t) => ["monastery", "wayside_shrine"].includes(t.historic), icon: "🛐" },
  { test: (t) => ["mine", "mine_shaft", "shieling", "milestone"].includes(t.historic), icon: "📍" },
  { test: (t) => ["monument", "memorial"].includes(t.historic), icon: "🗿" },
  { test: (t) => t.historic === "wayside_cross", icon: "✝️" },
  { test: (t) => t.historic === "boundary_stone", icon: "🪨" },
  { test: (t) => t.leisure === "marina", icon: "⛵" },
  { test: (t) => t.leisure === "slipway", icon: "🛥️" },
  { test: (t) => t.leisure === "outdoor_seating", icon: "🏕️" },
  { test: (t) => ["bandstand", "dance"].includes(t.leisure), icon: "🎶" },
  { test: (t) => ["bleachers", "resort", "hackerspace", "bird_hide", "amusement_arcade", "garden"].includes(t.leisure), icon: "🎡" },
  { test: (t) => t.leisure === "dog_park", icon: "🐕" },
  { test: (t) => t.leisure === "water_park", icon: "🌊" },
  { test: (t) => t.leisure === "beach_resort", icon: "🏖️" },
  { test: (t) => t.leisure === "swimming_pool", icon: "🏊" },
  { test: (t) => ["fitness_station", "fitness_centre"].includes(t.leisure), icon: "🏋️" },
  { test: (t) => t.leisure === "sauna", icon: "🧖" },
  { test: (t) => t.leisure === "horse_riding", icon: "🐎" },
  { test: (t) => t.leisure === "playground", icon: "🛝" },
  { test: (t) => t.leisure === "picnic_table", icon: "🧺" },
  { test: (t) => t.leisure === "firepit", icon: "🔥" },
  { test: (t) => t.leisure === "fishing", icon: "🎣" },
  { test: (t) => t.leisure === "adult_gaming_centre", icon: "🎰" },
  { test: (t) => ["stadium", "sports_centre"].includes(t.leisure), icon: "🏟️" },
  { test: (t) => t.leisure === "pitch", icon: "🏅" },
  { test: (t) => t.leisure === "track", icon: "🏎️" },
  { test: (t) => ["golf_course", "miniature_golf"].includes(t.leisure), icon: "⛳" },
  { test: (t) => ["reservoir_covered", "cross", "works", "pump", "petroleum_well", "gasometer", "mineshaft", "cairn", "adit", "survey_point", "beacon"].includes(t.man_made), icon: "📍" },
  { test: (t) => t.man_made === "pier", icon: "🛥️" },
  { test: (t) => t.man_made === "flagpole", icon: "🚩" },
  { test: (t) => ["chimney", "kiln"].includes(t.man_made), icon: "🏭" },
  { test: (t) => ["windmill", "windpump"].includes(t.man_made), icon: "🎡" },
  { test: (t) => ["silo", "storage_tank", "bunker_silo"].includes(t.man_made), icon: "🛢️" },
  { test: (t) => t.man_made === "crane", icon: "🏗️" },
  { test: (t) => ["utility_pole", "street_cabinet"].includes(t.man_made), icon: "⚡" },
  { test: (t) => t.man_made === "telescope", icon: "🔭" },
  { test: (t) => t.man_made === "surveillance", icon: "📷" },
  { test: (t) => t.man_made === "lighthouse", icon: "🚨" },
  { test: (t) => ["water_tower", "water_works", "watermill", "water_well"].includes(t.man_made), icon: "💧" },
  { test: (t) => ["antenna", "mast", "communications_tower"].includes(t.man_made), icon: "📡" },
  { test: (t) => t.man_made === "tower", icon: "🗼" },
  { test: (t) => t.man_made === "manhole", icon: "🕳️" },
  { test: (t) => t.man_made === "wastewater_plant", icon: "🚰" },
  { test: (t) => t.military === "airfield", icon: "✈️" },
  { test: (t) => t.military === "bunker", icon: "🪖" },
  { test: (t) => t.military === "range", icon: "🏅" },
  { test: (t) => t.mountain_pass === "yes", icon: "📍" },
  { test: (t) => t.natural === "spring", icon: "💧" },
  { test: (t) => ["bay", "cape", "strait"].includes(t.natural), icon: "🌊" },
  { test: (t) => ["peak", "saddle", "cliff"].includes(t.natural), icon: "⛰️" },
  { test: (t) => t.natural === "volcano", icon: "🌋" },
  { test: (t) => ["sinkhole", "cave_entrance"].includes(t.natural), icon: "🕳️" },
  { test: (t) => t.natural === "reef", icon: "🪸" },
  { test: (t) => t.natural === "shrub", icon: "🌿" },
  { test: (t) => t.natural === "tree", icon: "🌳" },
  { test: (t) => ["rock", "stone"].includes(t.natural), icon: "🪨" },
  { test: (t) => t.office === "accountant", icon: "🧮" },
  { test: (t) => ["advertising_agency", "association", "company", "educational_institution", "financial", "foundation", "ngo", "political_party", "religion", "tax_advisor"].includes(t.office), icon: "🏢" },
  { test: (t) => t.office === "architect", icon: "📐" },
  { test: (t) => ["diplomatic", "government"].includes(t.office), icon: "🏛️" },
  { test: (t) => t.office === "employment_agency", icon: "💼" },
  { test: (t) => t.office === "estate_agent", icon: "🏠" },
  { test: (t) => t.office === "insurance", icon: "🛡️" },
  { test: (t) => t.office === "it", icon: "💻" },
  { test: (t) => ["lawyer", "notary"].includes(t.office), icon: "⚖️" },
  { test: (t) => t.office === "newspaper", icon: "📰" },
  { test: (t) => t.office === "research", icon: "🔬" },
  { test: (t) => t.office === "telecommunication", icon: "📡" },
  { test: (t) => ["continent", "country", "state", "region", "county", "isolated_dwelling", "suburb", "quarter", "neighbourhood", "municipality", "locality", "square", "islet"].includes(t.place), icon: "📍" },
  { test: (t) => ["city", "city_block"].includes(t.place), icon: "🏙️" },
  { test: (t) => ["town", "village", "hamlet"].includes(t.place), icon: "🏘️" },
  { test: (t) => t.place === "farm", icon: "🚜" },
  { test: (t) => t.place === "island", icon: "🏝️" },
  { test: (t) => ["heliostat", "substation", "transformer", "switch", "converter", "compensator", "terminal", "portal", "tower", "pole", "connection", "insulator"].includes(t.power), icon: "⚡" },
  { test: (t) => t.power === "catenary_mast", icon: "📡" },
  { test: (t) => ["stop_position", "platform", "station"].includes(t.public_transport), icon: "🚏" },
  { test: (t) => t.railway === "level_crossing", icon: "🚦" },
  { test: (t) => ["crossing", "turntable", "buffer_stop", "switch", "railway_crossing", "signal", "milestone"].includes(t.railway), icon: "🚏" },
  { test: (t) => t.railway === "subway_entrance", icon: "🚇" },
  { test: (t) => ["station", "halt"].includes(t.railway), icon: "🚉" },
  { test: (t) => t.railway === "tram_stop", icon: "🚊" },
  { test: (t) => ["car", "car_parts"].includes(t.shop), icon: "🚗" },
  { test: (t) => t.shop === "tyres", icon: "🛞" },
  { test: (t) => t.shop === "motorcycle", icon: "🏍️" },
  { test: (t) => t.shop === "bicycle", icon: "🚲" },
  { test: (t) => t.shop === "supermarket", icon: "🛒" },
  { test: (t) => ["convenience", "kiosk"].includes(t.shop), icon: "🏪" },
  { test: (t) => t.shop === "bakery", icon: "🥖" },
  { test: (t) => t.shop === "butcher", icon: "🥩" },
  { test: (t) => t.shop === "seafood", icon: "🐟" },
  { test: (t) => t.shop === "dairy", icon: "🥛" },
  { test: (t) => ["cheese", "deli"].includes(t.shop), icon: "🧀" },
  { test: (t) => t.shop === "pastry", icon: "🥐" },
  { test: (t) => t.shop === "confectionery", icon: "🍬" },
  { test: (t) => t.shop === "chocolate", icon: "🍫" },
  { test: (t) => ["herbalist", "frozen_food", "vacuum_cleaner", "video", "pawnbroker", "doors", "interior_decoration", "medical_supply", "jewelry", "department_store", "general", "mall", "craft", "gas", "wholesale", "trade", "variety_store", "party", "security"].includes(t.shop), icon: "🏬" },
  { test: (t) => t.shop === "tea", icon: "🍵" },
  { test: (t) => t.shop === "coffee", icon: "☕" },
  { test: (t) => t.shop === "greengrocer", icon: "🥦" },
  { test: (t) => ["farm", "agrarian"].includes(t.shop), icon: "🚜" },
  { test: (t) => t.shop === "alcohol", icon: "🍾" },
  { test: (t) => t.shop === "beverages", icon: "🥤" },
  { test: (t) => t.shop === "wine", icon: "🍷" },
  { test: (t) => t.shop === "clothes", icon: "👕" },
  { test: (t) => t.shop === "boutique", icon: "👗" },
  { test: (t) => t.shop === "shoes", icon: "👟" },
  { test: (t) => t.shop === "outdoor", icon: "🏕️" },
  { test: (t) => t.shop === "sports", icon: "🏅" },
  { test: (t) => ["dry_cleaning", "laundry"].includes(t.shop), icon: "🧺" },
  { test: (t) => ["tailor", "fabric", "curtain"].includes(t.shop), icon: "🧵" },
  { test: (t) => t.shop === "computer", icon: "💻" },
  { test: (t) => t.shop === "electronics", icon: "🔌" },
  { test: (t) => t.shop === "mobile_phone", icon: "📱" },
  { test: (t) => t.shop === "watches", icon: "⌚" },
  { test: (t) => t.shop === "hifi", icon: "🔊" },
  { test: (t) => ["video_games", "games"].includes(t.shop), icon: "🎲" },
  { test: (t) => t.shop === "music", icon: "🎵" },
  { test: (t) => t.shop === "furniture", icon: "🛋️" },
  { test: (t) => t.shop === "kitchen", icon: "🍳" },
  { test: (t) => t.shop === "houseware", icon: "🍽️" },
  { test: (t) => ["pottery", "antiques"].includes(t.shop), icon: "🏺" },
  { test: (t) => ["art", "tattoo", "paint"].includes(t.shop), icon: "🎨" },
  { test: (t) => t.shop === "frame", icon: "🖼️" },
  { test: (t) => t.shop === "bed", icon: "🛏️" },
  { test: (t) => t.shop === "carpet", icon: "🧶" },
  { test: (t) => t.shop === "lighting", icon: "💡" },
  { test: (t) => t.shop === "swimming_pool", icon: "🏊" },
  { test: (t) => t.shop === "storage_rental", icon: "📦" },
  { test: (t) => t.shop === "stationery", icon: "✏️" },
  { test: (t) => t.shop === "copyshop", icon: "🖨️" },
  { test: (t) => t.shop === "books", icon: "📚" },
  { test: (t) => t.shop === "newsagent", icon: "📰" },
  { test: (t) => t.shop === "ticket", icon: "🎫" },
  { test: (t) => t.shop === "chemist", icon: "💊" },
  { test: (t) => ["cosmetics", "perfumery", "beauty"].includes(t.shop), icon: "💄" },
  { test: (t) => ["tobacco", "e-cigarette"].includes(t.shop), icon: "🚬" },
  { test: (t) => t.shop === "hairdresser", icon: "💇" },
  { test: (t) => t.shop === "massage", icon: "💆" },
  { test: (t) => t.shop === "optician", icon: "👓" },
  { test: (t) => t.shop === "hearing_aids", icon: "👂" },
  { test: (t) => t.shop === "erotic", icon: "🔞" },
  { test: (t) => t.shop === "florist", icon: "💐" },
  { test: (t) => t.shop === "garden_centre", icon: "🌱" },
  { test: (t) => ["doityourself", "hardware"].includes(t.shop), icon: "🔨" },
  { test: (t) => t.shop === "travel_agency", icon: "🧳" },
  { test: (t) => t.shop === "scuba_diving", icon: "🤿" },
  { test: (t) => t.shop === "fishing", icon: "🎣" },
  { test: (t) => t.shop === "musical_instrument", icon: "🎸" },
  { test: (t) => t.shop === "toys", icon: "🧸" },
  { test: (t) => t.shop === "gift", icon: "🎁" },
  { test: (t) => t.shop === "charity", icon: "🎗️" },
  { test: (t) => t.shop === "second_hand", icon: "♻️" },
  { test: (t) => ["bookmaker", "lottery"].includes(t.shop), icon: "🎟️" },
  { test: (t) => t.shop === "bag", icon: "👜" },
  { test: (t) => ["pet", "pet_grooming"].includes(t.shop), icon: "🐾" },
  { test: (t) => t.shop === "photo", icon: "📷" },
  { test: (t) => t.shop === "weapons", icon: "🔫" },
  { test: (t) => t.shop === "funeral_directors", icon: "⚰️" },
  { test: (t) => ["nursing_home", "assisted_living"].includes(t.social_facility), icon: "🏥" },
  { test: (t) => t.social_facility === "group_home", icon: "🏠" },
  { test: (t) => t.social_facility === "outreach", icon: "🤝" },
  { test: (t) => t.social_facility === "shelter", icon: "🏚️" },
  { test: (t) => t.social_facility === "food_bank", icon: "🍱" },
  { test: (t) => ["multi", "athletics", "equestrian", "roller_skating", "handball", "golf", "boules", "cricket", "croquet", "field_hockey", "curling", "pelota", "racquet", "motor", "motocross", "rc_car"].includes(t.sport), icon: "🏅" },
  { test: (t) => ["9pin", "10pin", "bowls"].includes(t.sport), icon: "🎳" },
  { test: (t) => t.sport === "archery", icon: "🏹" },
  { test: (t) => t.sport === "running", icon: "🏃" },
  { test: (t) => t.sport === "climbing", icon: "🧗" },
  { test: (t) => t.sport === "canoe", icon: "🛶" },
  { test: (t) => t.sport === "rowing", icon: "🚣" },
  { test: (t) => t.sport === "cycling", icon: "🚴" },
  { test: (t) => t.sport === "dog_racing", icon: "🐕" },
  { test: (t) => t.sport === "horse_racing", icon: "🐎" },
  { test: (t) => t.sport === "gymnastics", icon: "🤸" },
  { test: (t) => t.sport === "ice_skating", icon: "⛸️" },
  { test: (t) => t.sport === "skateboard", icon: "🛹" },
  { test: (t) => t.sport === "swimming", icon: "🏊" },
  { test: (t) => t.sport === "scuba_diving", icon: "🤿" },
  { test: (t) => t.sport === "shooting", icon: "🎯" },
  { test: (t) => t.sport === "chess", icon: "♟️" },
  { test: (t) => ["soccer", "gaelic_games"].includes(t.sport), icon: "⚽" },
  { test: (t) => ["australian_football", "american_football", "canadian_football", "rugby_league", "rugby_union"].includes(t.sport), icon: "🏈" },
  { test: (t) => t.sport === "baseball", icon: "⚾" },
  { test: (t) => t.sport === "basketball", icon: "🏀" },
  { test: (t) => t.sport === "volleyball", icon: "🏐" },
  { test: (t) => t.sport === "beachvolleyball", icon: "🏖️" },
  { test: (t) => t.sport === "billiards", icon: "🎱" },
  { test: (t) => t.sport === "ice_hockey", icon: "🏒" },
  { test: (t) => ["table_tennis", "tennis"].includes(t.sport), icon: "🎾" },
  { test: (t) => t.sport === "karting", icon: "🏎️" },
  { test: (t) => t.sport === "model_aerodrome", icon: "✈️" },
  { test: (t) => t.telecom === "exchange", icon: "☎️" },
  { test: (t) => ["connection_point", "service_device"].includes(t.telecom), icon: "📡" },
  { test: (t) => ["hotel", "motel"].includes(t.tourism), icon: "🏨" },
  { test: (t) => ["guest_house", "hostel"].includes(t.tourism), icon: "🛏️" },
  { test: (t) => t.tourism === "apartment", icon: "🏢" },
  { test: (t) => t.tourism === "chalet", icon: "🏠" },
  { test: (t) => ["alpine_hut", "wilderness_hut"].includes(t.tourism), icon: "🛖" },
  { test: (t) => t.tourism === "caravan_site", icon: "🚐" },
  { test: (t) => t.tourism === "camp_site", icon: "🏕️" },
  { test: (t) => t.tourism === "camp_pitch", icon: "⛺" },
  { test: (t) => ["attraction", "theme_park"].includes(t.tourism), icon: "🎡" },
  { test: (t) => t.tourism === "viewpoint", icon: "🔭" },
  { test: (t) => t.tourism === "zoo", icon: "🦁" },
  { test: (t) => t.tourism === "picnic_site", icon: "🧺" },
  { test: (t) => t.tourism === "museum", icon: "🏛️" },
  { test: (t) => ["gallery", "artwork"].includes(t.tourism), icon: "🖼️" },
  { test: (t) => t.traffic_calming === "island", icon: "🏝️" },
  { test: (t) => t.traffic_sign === "city_limit", icon: "🏙️" },
  { test: (t) => ["waterfall", "weir", "dam", "lock_gate"].includes(t.waterway), icon: "🌊" },
  { test: (t) => ["fuel", "turning_point"].includes(t.waterway), icon: "⚓" },
  { test: (t) => ["boatyard", "dock"].includes(t.waterway), icon: "⛵" },
  // Generic fallbacks for any value JOSM's own preset list above doesn't
  // happen to cover for that key — better than no icon at all for an
  // otherwise-recognized feature type.
  { test: (t) => t.shop !== undefined, icon: "🏬" },
  { test: (t) => t.office !== undefined, icon: "🏢" },
  { test: (t) => t.craft !== undefined, icon: "🔧" },
  { test: (t) => t.emergency !== undefined, icon: "🚨" },
  { test: (t) => t.tourism !== undefined, icon: "🎡" },
  { test: (t) => t.leisure !== undefined, icon: "🎡" },
  { test: (t) => t.historic !== undefined, icon: "🏛️" },
  { test: (t) => t.sport !== undefined, icon: "🏅" },
];

// Returns the OSM-wiki-style emoji for a node's tags, or null when nothing
// matches — the caller then falls back to a plain, unobtrusive marker
// (this app's version of JOSM's own default node rendering) rather than a
// made-up generic icon.
export function nodeIconGlyph(tags: Record<string, string>): string | null {
  return NODE_ICON_RULES.find((rule) => rule.test(tags))?.icon ?? null;
}

// JOSM shrinks and fades node markers out at low zoom rather than keeping
// them a constant screen size — a busy area reads as clutter at a glance,
// and node-level precision isn't useful until you're zoomed in enough to
// actually place/drag one anyway. Shared by both maps (OsmEditorMap.web.tsx
// uses Leaflet's own zoom level directly; OsmEditorMap.tsx derives an
// approximate one from the native MapView's region). Below
// NODE_VISIBILITY_MIN_ZOOM markers bottom out at their smallest/faintest;
// at or above NODE_VISIBILITY_FULL_ZOOM they're full size, linear between.
const NODE_VISIBILITY_MIN_ZOOM = 11;
const NODE_VISIBILITY_FULL_ZOOM = 18;
export function nodeVisibilityAtZoom(zoom: number): { scale: number; opacity: number } {
  const t = Math.max(0, Math.min(1, (zoom - NODE_VISIBILITY_MIN_ZOOM) / (NODE_VISIBILITY_FULL_ZOOM - NODE_VISIBILITY_MIN_ZOOM)));
  return { scale: 0.3 + 0.7 * t, opacity: 0.45 + 0.55 * t };
}

// Real-world meters per screen pixel at a given zoom/latitude, standard
// web-mercator tile relationship (same formula roadTrace.ts uses for its
// own zoom-aware distance thresholds). Lets native's area-fill hole
// (OsmEditorMap.tsx, which has no direct latlng<->pixel projection the way
// Leaflet gives the web map) target a real fixed-pixel band width by
// converting it to meters at the shape's own latitude/zoom instead.
export function metersPerPixel(zoom: number, latDeg: number): number {
  return (156543.03392 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
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

// Same idea as pointToSegmentDistance but also returns the actual closest
// point on the segment, not just the distance to it — used to snap a new
// node exactly onto a way's line when "hooking" it into that way (see
// OsmEditorMap's findWayHookTarget) rather than leaving it sitting
// slightly off to one side.
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; dist: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: ax, y: ay, dist: Math.hypot(px - ax, py - ay) };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { x, y, dist: Math.hypot(px - x, py - y) };
}
