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
export type RegionStatus = "green" | "yellow" | "red";

export interface RegionMatch {
  name: string;
  geometry: { type: string; coordinates: unknown };
  status?: RegionStatus;
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

export function getAllRegions(regionType: RegionType): RegionMatch[] {
  const index = regionType === "us_state" ? STATES_INDEX : COUNTRIES_INDEX;
  return [...index.values()].map((f) => ({ name: f.properties.name, geometry: f.geometry, status: "red" as const }));
}

// Green/yellow/red from whatever's written right around the region's name —
// a rough read, not a legal opinion, but enough to tell "allowed" from
// "allowed with a permit" from "not allowed" at a glance.
function classifyStatus(context: string): RegionStatus {
  const t = context.toLowerCase();
  if (/\b(illegal|prohibit|banned|ban on|not allowed|not permitted|outlaw|unlawful)/.test(t)) return "red";
  if (/\bno (permit|licen[sc]e)|without a (permit|licen[sc]e)/.test(t)) return "green";
  if (/\b(permit|licen[sc]e|regulat|restrict|condition|approval|register|special)/.test(t)) return "yellow";
  if (/\b(legal|allowed|permitted)\b/.test(t)) return "green";
  return "yellow";
}

// Asking the model to explicitly call a tool for "which states allow X"
// isn't reliable — it already knows the answer from training and just
// writes it out as a list, no tool needed as far as it's concerned
// (confirmed: it answered in plain bolded list form without ever calling
// highlight_regions). Instead of fighting that, read the region names back
// out of the answer it already wrote — the model reliably **bolds** or
// bullets each one, usually with a short note on legality right next to it —
// so a full map appears with zero extra tokens spent asking it to also call
// a tool.
function extractCandidates(text: string): { name: string; context: string }[] {
  const candidates: { name: string; context: string }[] = [];
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(/\*\*([^*]{2,40})\*\*/g)) {
      candidates.push({ name: m[1].trim(), context: line });
    }
    const listMatch = line.match(/^\s*(?:[-•*]|\d+[.)])\s*\**([A-Za-z][A-Za-z .'-]{1,40}?)\**\s*[:\-–—]/);
    if (listMatch) candidates.push({ name: listMatch[1].trim(), context: line });
  }
  return candidates;
}

// A region that's never mentioned defaults to red ("not allowed / unknown")
// — the model's list-style answers to these questions are almost always
// just the exceptions, not an exhaustive allowed/disallowed breakdown.
export function extractRegionsFromText(text: string): { regionType: RegionType; regions: RegionMatch[] } | null {
  const candidates = extractCandidates(text);
  if (candidates.length < 2) return null;

  const stateOverrides = new Map<string, RegionMatch>();
  const countryOverrides = new Map<string, RegionMatch>();

  for (const { name, context } of candidates) {
    const key = name.toLowerCase();
    const stateFeature = STATES_INDEX.get(key) ?? STATES_INDEX.get(ALIASES[key] ?? "");
    if (stateFeature && !stateOverrides.has(stateFeature.properties.name)) {
      stateOverrides.set(stateFeature.properties.name, {
        name: stateFeature.properties.name,
        geometry: stateFeature.geometry,
        status: classifyStatus(context),
      });
    }
    const countryFeature = COUNTRIES_INDEX.get(key) ?? COUNTRIES_INDEX.get(ALIASES[key] ?? "");
    if (countryFeature && !countryOverrides.has(countryFeature.properties.name)) {
      countryOverrides.set(countryFeature.properties.name, {
        name: countryFeature.properties.name,
        geometry: countryFeature.geometry,
        status: classifyStatus(context),
      });
    }
  }

  // States win ties — "which states" questions are far more common than a
  // reply that happens to bold two country-shaped words for other reasons.
  if (stateOverrides.size >= 2) {
    return { regionType: "us_state", regions: getAllRegions("us_state").map((r) => stateOverrides.get(r.name) ?? r) };
  }
  if (countryOverrides.size >= 2) {
    return { regionType: "country", regions: getAllRegions("country").map((r) => countryOverrides.get(r.name) ?? r) };
  }
  return null;
}
