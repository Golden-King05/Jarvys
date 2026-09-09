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

// Asking the model to explicitly call a tool for "which states allow X"
// isn't reliable — it already knows the answer from training and just
// writes it out as a list, no tool needed as far as it's concerned
// (confirmed: it answered in plain bolded list form without ever calling
// highlight_regions). Instead of fighting that, read the region names back
// out of the answer it already wrote — the model reliably **bolds** or
// bullets each one — so a map appears with zero extra tokens spent asking
// it to also call a tool.
function extractCandidatePhrases(text: string): string[] {
  const candidates = new Set<string>();
  for (const m of text.matchAll(/\*\*([^*]{2,40})\*\*/g)) {
    candidates.add(m[1].trim());
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-•*]|\d+[.)])\s*\**([A-Za-z][A-Za-z .'-]{1,40}?)\**\s*[:\-–—]/);
    if (m) candidates.add(m[1].trim());
  }
  return [...candidates];
}

export function extractRegionsFromText(text: string): { regionType: RegionType; regions: RegionMatch[] } | null {
  const candidates = extractCandidatePhrases(text);
  if (candidates.length < 2) return null;

  const stateMatches: RegionMatch[] = [];
  const countryMatches: RegionMatch[] = [];
  const seenStates = new Set<string>();
  const seenCountries = new Set<string>();

  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    const stateFeature = STATES_INDEX.get(key) ?? STATES_INDEX.get(ALIASES[key] ?? "");
    if (stateFeature && !seenStates.has(stateFeature.properties.name)) {
      seenStates.add(stateFeature.properties.name);
      stateMatches.push({ name: stateFeature.properties.name, geometry: stateFeature.geometry });
    }
    const countryFeature = COUNTRIES_INDEX.get(key) ?? COUNTRIES_INDEX.get(ALIASES[key] ?? "");
    if (countryFeature && !seenCountries.has(countryFeature.properties.name)) {
      seenCountries.add(countryFeature.properties.name);
      countryMatches.push({ name: countryFeature.properties.name, geometry: countryFeature.geometry });
    }
  }

  // States win ties — "which states" questions are far more common than a
  // reply that happens to bold two country-shaped words for other reasons.
  if (stateMatches.length >= 2) return { regionType: "us_state", regions: stateMatches };
  if (countryMatches.length >= 2) return { regionType: "country", regions: countryMatches };
  return null;
}
