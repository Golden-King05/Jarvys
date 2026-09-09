import { geocode } from "./geo.js";

// Same provider as weather.ts's current-conditions call, just the sibling
// air-quality endpoint — free, no API key.
const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

interface AirQualityResponse {
  current: {
    us_aqi: number | null;
    pm2_5: number | null;
    pm10: number | null;
    ozone: number | null;
    carbon_monoxide: number | null;
  };
}

export interface AirQuality {
  location: string;
  lat: number;
  lon: number;
  aqi: number | null;
  category: string;
  pm2_5: number | null;
  pm10: number | null;
  ozone: number | null;
  carbonMonoxide: number | null;
}

// EPA's standard US AQI bands (airnow.gov).
function categorizeAqi(aqi: number | null): string {
  if (aqi == null) return "unknown";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

export async function getAirQuality(place: string): Promise<AirQuality | { error: string }> {
  const point = await geocode(place);
  if ("error" in point) return point;

  const params = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lon),
    current: "us_aqi,pm2_5,pm10,ozone,carbon_monoxide",
    timezone: "auto",
  });
  const res = await fetch(`${AIR_QUALITY_URL}?${params}`);
  if (!res.ok) {
    return { error: `Air quality lookup failed (${res.status})` };
  }
  const data = (await res.json()) as AirQualityResponse;

  return {
    location: point.name,
    lat: point.lat,
    lon: point.lon,
    aqi: data.current.us_aqi,
    category: categorizeAqi(data.current.us_aqi),
    pm2_5: data.current.pm2_5,
    pm10: data.current.pm10,
    ozone: data.current.ozone,
    carbonMonoxide: data.current.carbon_monoxide,
  };
}
