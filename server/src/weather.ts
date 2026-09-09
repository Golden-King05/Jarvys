import { geocode } from "./geo.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather codes, as used by Open-Meteo (free, no API key).
const WEATHER_CODES: Record<number, { text: string; icon: string }> = {
  0: { text: "clear sky", icon: "☀️" },
  1: { text: "mainly clear", icon: "🌤️" },
  2: { text: "partly cloudy", icon: "⛅" },
  3: { text: "overcast", icon: "☁️" },
  45: { text: "fog", icon: "🌫️" },
  48: { text: "depositing rime fog", icon: "🌫️" },
  51: { text: "light drizzle", icon: "🌦️" },
  53: { text: "moderate drizzle", icon: "🌦️" },
  55: { text: "dense drizzle", icon: "🌦️" },
  56: { text: "light freezing drizzle", icon: "🌧️" },
  57: { text: "dense freezing drizzle", icon: "🌧️" },
  61: { text: "slight rain", icon: "🌧️" },
  63: { text: "moderate rain", icon: "🌧️" },
  65: { text: "heavy rain", icon: "🌧️" },
  66: { text: "light freezing rain", icon: "🌨️" },
  67: { text: "heavy freezing rain", icon: "🌨️" },
  71: { text: "slight snow fall", icon: "🌨️" },
  73: { text: "moderate snow fall", icon: "🌨️" },
  75: { text: "heavy snow fall", icon: "❄️" },
  77: { text: "snow grains", icon: "❄️" },
  80: { text: "slight rain showers", icon: "🌦️" },
  81: { text: "moderate rain showers", icon: "🌦️" },
  82: { text: "violent rain showers", icon: "⛈️" },
  85: { text: "slight snow showers", icon: "🌨️" },
  86: { text: "heavy snow showers", icon: "🌨️" },
  95: { text: "thunderstorm", icon: "⛈️" },
  96: { text: "thunderstorm with slight hail", icon: "⛈️" },
  99: { text: "thunderstorm with heavy hail", icon: "⛈️" },
};

function describeWeatherCode(code: number): { text: string; icon: string } {
  return WEATHER_CODES[code] ?? { text: "unknown conditions", icon: "🌡️" };
}

interface OpenMeteoResponse {
  timezone: string;
  timezone_abbreviation: string;
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    weather_code: number;
  };
}

interface Conditions {
  location: string;
  lat: number;
  lon: number;
  timezone: string;
  timezoneAbbreviation: string;
  localTime: string;
  temperatureF: number;
  humidity: number;
  windMph: number;
  condition: string;
  icon: string;
}

// One Open-Meteo call gets both current weather and local time/timezone for
// a place — timezone=auto has it detect the zone from the coordinates and
// return the current time already converted to it, so the get_weather and
// get_local_time tools share this instead of needing two different free
// APIs; each just surfaces the fields it cares about.
export async function getConditions(place: string): Promise<Conditions | { error: string }> {
  const point = await geocode(place);
  if ("error" in point) return point;

  const params = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lon),
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) {
    return { error: `Weather lookup failed (${res.status})` };
  }
  const data = (await res.json()) as OpenMeteoResponse;
  const { text, icon } = describeWeatherCode(data.current.weather_code);

  return {
    location: point.name,
    lat: point.lat,
    lon: point.lon,
    timezone: data.timezone,
    timezoneAbbreviation: data.timezone_abbreviation,
    localTime: data.current.time,
    temperatureF: data.current.temperature_2m,
    humidity: data.current.relative_humidity_2m,
    windMph: data.current.wind_speed_10m,
    condition: text,
    icon,
  };
}

interface OpenMeteoDailyResponse {
  timezone: string;
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
}

export interface ForecastDay {
  date: string;
  highF: number;
  lowF: number;
  condition: string;
  icon: string;
  precipitationChance: number;
}

export interface Forecast {
  location: string;
  lat: number;
  lon: number;
  timezone: string;
  days: ForecastDay[];
}

// Same Open-Meteo endpoint as getConditions, just asking for daily
// aggregates instead of the current snapshot — free, no API key, up to 16
// days out.
export async function getForecast(place: string, days = 5): Promise<Forecast | { error: string }> {
  const point = await geocode(place);
  if ("error" in point) return point;

  const params = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lon),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    timezone: "auto",
    forecast_days: String(Math.min(Math.max(1, Math.round(days)), 16)),
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) {
    return { error: `Forecast lookup failed (${res.status})` };
  }
  const data = (await res.json()) as OpenMeteoDailyResponse;

  return {
    location: point.name,
    lat: point.lat,
    lon: point.lon,
    timezone: data.timezone,
    days: data.daily.time.map((date, i) => {
      const { text, icon } = describeWeatherCode(data.daily.weather_code[i]);
      return {
        date,
        highF: data.daily.temperature_2m_max[i],
        lowF: data.daily.temperature_2m_min[i],
        condition: text,
        icon,
        precipitationChance: data.daily.precipitation_probability_max[i],
      };
    }),
  };
}

