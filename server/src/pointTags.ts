// This app's own documented point-tag vocabulary — mirrors
// docs/point-tags/point-tags-glossary.md and point-tags.xlsx at the repo
// root (kept there for people to browse/edit). Embedded directly here
// rather than read from disk at runtime so it ships with the server
// regardless of deployment layout, and so it's available to the assistant
// as a tool result without bloating every turn's system prompt with it.
//
// Keep this in sync with the two docs whenever a tag is added or changed.
export const POINT_TAG_REFERENCE = `Documented point tags (key: accepted values — meaning):

- start_date: YYYY or DD/MM/YYYY — when the thing began (built, founded, or a historical event's date). European date order, not month/day/year.
- end_date: YYYY or DD/MM/YYYY — the start_date counterpart, when the thing ended.
- building: yes;no — whether the point is an actual building structure. Auto-fill: yes when category is "building" or "hotel".
- building_type: barn;house;hotel;store;apartment;office;warehouse;garage;shed;cabin;church;school;hospital;factory;restaurant;library — what kind of building, for points where building is yes. Not exhaustive.
- water_type: freshwater;saltwater;brackish — the salinity of a body of water.
- current: yes;no (default yes) — whether the thing presently stands / is actively happening, vs. historical and no longer so. Auto-fill: no when category is "battle".
- military_installation: fort;castle;airbase;base;camp;garrison;bunker;outpost;military_installation_structure — a military site or a building belonging to one. IMPORTANT: the first eight values name what the installation IS (this point is a fort, is an airbase, etc.); military_installation_structure is a different kind of answer, meaning this point is NOT the installation itself, just a secondary building belonging to one (a barracks, a kitchen, a mess hall, a garage) — it is not a ninth type to weigh against the other eight. current:no plus amenity:museum (see amenity) on a military_installation point means it still stands and is now a museum, not fallen; current:no with no amenity tag means it's simply gone.
- military_installation_structure: barracks;kitchen;mess_hall;garage;armory;watchtower;gatehouse;infirmary;stable;guardhouse — its own separate tag, only meaningful together with military_installation:military_installation_structure on the same point. That value on military_installation is step one (flags "some secondary military building"); this tag is step two (says which kind). Not exhaustive.
- amenity: museum — what a place currently functions as when different from its historical purpose. Only one value defined so far.
- brand: free text, e.g. "McDonald's", "Shake Shack" — the chain/business a point belongs to. Exception to the usual convention: written exactly as the brand writes it (spaces, apostrophes), not underscore_joined.
- name: free text — mirrors the point's own name, as a tag for find_points_by_tag searches. Rarely set since the point already has a name field. Same free-text exception as brand.
- brand_historic_location: first;first_without_name;first_with_name;municipality;registered;unique_location — what's notable about this specific location of a brand, almost always set alongside brand.
  - first: the first location of this brand, period.
  - first_without_name / first_with_name: a pair used instead of plain "first" when an owner opened an earlier, nearly-identical business before the brand name existed (first_without_name), then later opened the first one that officially carried the brand name (first_with_name).
  - municipality: the first location of this brand within a specific city/town, not the first anywhere.
  - registered: listed on the country's official historic register (the National Register of Historic Places, for the US). Combine with another value when both apply.
  - unique_location: a distinctive, unusual gimmick or theme, independent of historical significance.

General rules:
- A single point's tag value can hold more than one applicable value at once, joined by ";" with no space before or after it — e.g. brand_historic_location: "first;registered". This is different from the ";"-separated lists above, which are each tag's full menu of possible values, not multiple values on one point.
- find_points_by_tag's value match is a case-insensitive substring match, not exact — searching brand_historic_location for "first" will also match "first_with_name" and "first_without_name" (both start with "first"), so one search already covers all three; no need for separate fallback calls.`;
