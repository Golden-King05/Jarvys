import type { OsmElement } from "../api";

export interface OsmCluster {
  lat: number;
  lon: number;
  elements: OsmElement[];
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Groups OSM elements sitting at essentially the same spot (a shop node
// inside the building way that contains it, say) into one pin, so tapping
// it can page through everything there instead of stacking overlapping
// markers. Tighter than the Wikipedia layer's 150m — OSM elements genuinely
// on top of each other are usually within a few meters, not spread across
// a block.
const CLUSTER_RADIUS_METERS = 25;

export function clusterOsmElements(elements: OsmElement[]): OsmCluster[] {
  const clusters: OsmCluster[] = [];
  for (const el of elements) {
    const nearby = clusters.find((c) => haversineMeters(c.lat, c.lon, el.lat, el.lon) <= CLUSTER_RADIUS_METERS);
    if (nearby) {
      nearby.elements.push(el);
    } else {
      clusters.push({ lat: el.lat, lon: el.lon, elements: [el] });
    }
  }
  return clusters;
}

// A stable identity for one element, independent of which query returned
// it — lets the layer dedupe across repeated "Query" presses as the user
// pans around, and lets an import remove exactly this element afterward.
export function osmElementKey(el: OsmElement): string {
  return `${el.osmType}/${el.osmId}`;
}

export function osmElementName(el: OsmElement): string {
  return el.tags.name ?? el.tags["name:en"] ?? `Unnamed ${el.osmType}`;
}

// The handful of OSM keys that most often say what a place actually *is* —
// checked in this order so the most specific match wins (e.g. an `amenity`
// wins over an incidental `building=yes` on the same element).
const CATEGORY_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "historic",
  "leisure",
  "natural",
  "craft",
  "office",
  "man_made",
  "railway",
  "waterway",
  "building",
];

// Best-guess category/subcategory from an element's raw tags, so the import
// form doesn't start out completely blank — e.g. {amenity: "cafe"} becomes
// category "amenity", subcategory "cafe", which also gives suggestIcon
// something to match against.
export function inferOsmCategory(tags: Record<string, string>): { category: string; subcategory: string } {
  for (const key of CATEGORY_KEYS) {
    const value = tags[key];
    if (value && value !== "yes") {
      return { category: key, subcategory: value.replace(/_/g, " ") };
    }
  }
  return { category: "", subcategory: "" };
}
