import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simplified boundary sets — not survey-grade, but plenty to shade a map and
// make a point. Loaded once at startup and kept in memory (both files
// together are well under 1MB).
interface Feature {
  type: "Feature";
  properties: { name: string };
  geometry: { type: string; coordinates: unknown };
}
interface FeatureCollection {
  features: Feature[];
}

function loadIndex(fileName: string): Map<string, Feature> {
  const raw = fs.readFileSync(path.join(__dirname, "data", fileName), "utf-8");
  const data = JSON.parse(raw) as FeatureCollection;
  const index = new Map<string, Feature>();
  for (const feature of data.features) {
    const name = feature.properties?.name;
    if (name) index.set(name.toLowerCase(), feature);
  }
  return index;
}

const STATES_INDEX = loadIndex("us-states.geojson");
const COUNTRIES_INDEX = loadIndex("countries.geojson");

// Common alternate names the model might reasonably use instead of the
// dataset's exact spelling.
const ALIASES: Record<string, string> = {
  usa: "united states of america",
  us: "united states of america",
  "united states": "united states of america",
  uk: "united kingdom",
  "south korea": "korea, republic of",
  "north korea": "korea, dem. rep.",
  russia: "russian federation",
};

export type RegionType = "us_state" | "country";

export interface RegionMatch {
  name: string;
  geometry: { type: string; coordinates: unknown };
}

export function findRegions(regionType: RegionType, names: string[]): RegionMatch[] | { error: string } {
  const index = regionType === "us_state" ? STATES_INDEX : COUNTRIES_INDEX;
  const matches: RegionMatch[] = [];
  const notFound: string[] = [];

  for (const rawName of names) {
    const key = rawName.trim().toLowerCase();
    const feature = index.get(key) ?? index.get(ALIASES[key] ?? "");
    if (feature) {
      matches.push({ name: feature.properties.name, geometry: feature.geometry });
    } else {
      notFound.push(rawName);
    }
  }

  if (matches.length === 0) {
    return { error: `Couldn't match any of these to a known ${regionType === "us_state" ? "US state" : "country"}: ${names.join(", ")}` };
  }
  return matches;
}
