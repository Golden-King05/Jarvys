import { geocode } from "./geo.js";

const NWS_BASE = "https://api.weather.gov";
// NWS requires a descriptive User-Agent identifying the app (see
// https://www.weather.gov/documentation/services-web-api) — no API key needed.
const USER_AGENT = "Jarvys-personal-assistant/1.0 (https://github.com/Golden-King05/Jarvys)";

interface NwsPointResponse {
  properties: {
    forecast: string;
  };
}

interface NwsForecastResponse {
  properties: {
    periods: {
      name: string;
      temperature: number;
      probabilityOfPrecipitation: { value: number | null };
      windSpeed: string;
      windDirection: string;
      shortForecast: string;
      detailedForecast: string;
    }[];
  };
}

export interface NwsForecastPeriod {
  name: string;
  temperatureF: number;
  precipitationChance: number | null;
  wind: string;
  shortForecast: string;
  detailedForecast: string;
}

export interface NwsForecast {
  location: string;
  lat: number;
  lon: number;
  periods: NwsForecastPeriod[];
}

// NWS only covers US territory (and its forecast grid resolution beats
// Open-Meteo's for US locations) — a non-US or ocean point returns a
// non-200 here, which callers use as the signal to fall back to Open-Meteo.
export async function getNwsForecast(place: string, periods = 6): Promise<NwsForecast | { error: string }> {
  const point = await geocode(place);
  if ("error" in point) return point;

  const pointRes = await fetch(`${NWS_BASE}/points/${point.lat.toFixed(4)},${point.lon.toFixed(4)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
  });
  if (!pointRes.ok) {
    return { error: `NWS doesn't cover this location (${pointRes.status})` };
  }
  const pointData = (await pointRes.json()) as NwsPointResponse;

  const forecastRes = await fetch(pointData.properties.forecast, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
  });
  if (!forecastRes.ok) {
    return { error: `NWS forecast lookup failed (${forecastRes.status})` };
  }
  const forecastData = (await forecastRes.json()) as NwsForecastResponse;

  return {
    location: point.name,
    lat: point.lat,
    lon: point.lon,
    periods: forecastData.properties.periods.slice(0, periods).map((p) => ({
      name: p.name,
      temperatureF: p.temperature,
      precipitationChance: p.probabilityOfPrecipitation.value,
      wind: `${p.windSpeed} ${p.windDirection}`,
      shortForecast: p.shortForecast,
      detailedForecast: p.detailedForecast,
    })),
  };
}

interface NwsAlertsResponse {
  features: {
    properties: {
      event: string;
      headline: string;
      severity: string;
      urgency: string;
      areaDesc: string;
      description: string;
      instruction: string | null;
      effective: string;
      expires: string;
    };
  }[];
}

export interface NwsAlert {
  event: string;
  headline: string;
  severity: string;
  urgency: string;
  areaDesc: string;
  description: string;
  instruction: string | null;
  effective: string;
  expires: string;
}

export interface NwsAlerts {
  location: string;
  lat: number;
  lon: number;
  alerts: NwsAlert[];
}

// Active severe weather alerts (warnings, watches, advisories) for a point —
// US only, same NWS coverage limit as the forecast above.
export async function getActiveAlerts(place: string): Promise<NwsAlerts | { error: string }> {
  const point = await geocode(place);
  if ("error" in point) return point;

  const res = await fetch(`${NWS_BASE}/alerts/active?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
  });
  if (!res.ok) {
    return { error: `NWS alerts lookup failed (${res.status}) — NWS only covers the US.` };
  }
  const data = (await res.json()) as NwsAlertsResponse;

  return {
    location: point.name,
    lat: point.lat,
    lon: point.lon,
    alerts: data.features.map((f) => f.properties),
  };
}
