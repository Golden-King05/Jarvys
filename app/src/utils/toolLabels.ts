interface ToolInfo {
  label: string;
  icon: string;
  // An "about"/explainer page for the source itself, not its homepage —
  // tapping a badge should explain what OpenStreetMap *is*, not just land
  // on the map-editing site.
  url: string;
}

const TOOL_LABELS: Record<string, ToolInfo> = {
  search_wikipedia: {
    label: "Wikipedia",
    icon: "📖",
    url: "https://en.wikipedia.org/wiki/Wikipedia:About",
  },
  find_places: {
    label: "OpenStreetMap",
    icon: "🗺️",
    url: "https://www.openstreetmap.org/about",
  },
  calculate_distance: {
    label: "OpenStreetMap",
    icon: "🗺️",
    url: "https://www.openstreetmap.org/about",
  },
  highlight_regions: {
    label: "Region data",
    icon: "🌎",
    url: "https://en.wikipedia.org/wiki/GeoJSON",
  },
  verify_map: {
    label: "Gemini (verified)",
    icon: "✅",
    url: "https://deepmind.google/technologies/gemini/",
  },
  get_weather: {
    label: "Open-Meteo",
    icon: "🌤️",
    url: "https://open-meteo.com/en/about",
  },
  get_local_time: {
    label: "Open-Meteo",
    icon: "🕒",
    url: "https://open-meteo.com/en/about",
  },
  convert_currency: {
    label: "Frankfurter",
    icon: "💱",
    url: "https://www.frankfurter.dev/",
  },
};

// De-duped, human-friendly source names for the "API used" badge — several
// tool names can point at the same underlying source (e.g. find_places and
// calculate_distance both hit OpenStreetMap), so this collapses those to
// one badge instead of listing the same source twice.
export function describeToolsUsed(names: string[]): ToolInfo[] {
  const seen = new Set<string>();
  const result: ToolInfo[] = [];
  for (const name of names) {
    const info = TOOL_LABELS[name] ?? { label: name, icon: "🔧", url: "" };
    if (seen.has(info.label)) continue;
    seen.add(info.label);
    result.push(info);
  }
  return result;
}
