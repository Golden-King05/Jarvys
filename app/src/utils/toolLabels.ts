const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  search_wikipedia: { label: "Wikipedia", icon: "📖" },
  find_places: { label: "OpenStreetMap", icon: "🗺️" },
  calculate_distance: { label: "OpenStreetMap", icon: "🗺️" },
  highlight_regions: { label: "Region data", icon: "🌎" },
  verify_map: { label: "Gemini (verified)", icon: "✅" },
  get_weather: { label: "Open-Meteo", icon: "🌤️" },
  get_local_time: { label: "Open-Meteo", icon: "🕒" },
  convert_currency: { label: "Frankfurter", icon: "💱" },
};

// De-duped, human-friendly source names for the "API used" badge — several
// tool names can point at the same underlying source (e.g. find_places and
// calculate_distance both hit OpenStreetMap), so this collapses those to
// one badge instead of listing the same source twice.
export function describeToolsUsed(names: string[]): { label: string; icon: string }[] {
  const seen = new Set<string>();
  const result: { label: string; icon: string }[] = [];
  for (const name of names) {
    const info = TOOL_LABELS[name] ?? { label: name, icon: "🔧" };
    if (seen.has(info.label)) continue;
    seen.add(info.label);
    result.push(info);
  }
  return result;
}
