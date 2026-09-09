export interface TimezoneBand {
  offset: number;
  centerLon: number;
  westLon: number;
}

// A rough, "nautical" approximation — real timezone borders follow country
// and state lines, not clean 15°-of-longitude bands (China, for instance, is
// one zone despite spanning what would be five). This is a visual
// approximation to show roughly how time shifts across the map, not a
// legally accurate boundary layer — that would need a much heavier
// boundary dataset than fits a bundled, free-tier-friendly app.
export function getTimezoneBands(): TimezoneBand[] {
  const bands: TimezoneBand[] = [];
  for (let offset = -12; offset <= 12; offset++) {
    const centerLon = offset * 15;
    bands.push({ offset, centerLon, westLon: centerLon - 7.5 });
  }
  return bands;
}

export function formatOffset(offset: number): string {
  if (offset === 0) return "UTC";
  return offset > 0 ? `UTC+${offset}` : `UTC${offset}`;
}
