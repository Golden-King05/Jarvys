import type { MapPoint } from "./llm.js";

// Anonymous (keyless) access works but is capped at only 400 credits/day,
// bucketed by IP — a free OpenSky account (no ADS-B receiver needed) raises
// that to 4,000/day. Set OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET (from
// https://opensky-network.org/my-opensky/account → "API Client") to use it;
// left unset, this falls back to anonymous access exactly as before.
const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

interface OpenSkyTokenResponse {
  access_token: string;
  expires_in?: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

// OpenSky's tokens last ~30 minutes; refreshed a bit early so a request
// already in flight doesn't get a token that expires mid-call. Returns null
// (falling back to anonymous access) when no client credentials are set, or
// if the auth server itself is unreachable — a broken token flow shouldn't
// take flight data offline entirely when anonymous access still works.
async function getAccessToken(): Promise<string | null> {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  try {
    const res = await fetch(OPENSKY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`OpenSky auth failed (${res.status}) — falling back to anonymous access`);
      return null;
    }
    const data = (await res.json()) as OpenSkyTokenResponse;
    const expiresInMs = (data.expires_in ?? 1800) * 1000;
    cachedToken = { token: data.access_token, expiresAt: Date.now() + expiresInMs - 30000 };
    return cachedToken.token;
  } catch (err) {
    console.error("OpenSky auth request failed — falling back to anonymous access:", err);
    return null;
  }
}

interface OpenSkyResponse {
  time: number;
  states: (string | number | boolean | null)[][] | null;
}

export interface Flight {
  icao24: string;
  callsign: string;
  originCountry: string;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  velocityMph: number | null;
  headingDeg: number | null;
  verticalRateFtMin: number | null;
  onGround: boolean;
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

// Keeps a single query from covering an unreasonably large area (slow, and
// anonymous OpenSky access has a modest daily credit budget).
const MAX_BBOX_DEGREES = 5;

async function getFlightsFromOpenSky(box: BoundingBox): Promise<Flight[] | { error: string }> {
  const south = Math.max(box.south, box.north - MAX_BBOX_DEGREES);
  const west = Math.max(box.west, box.east - MAX_BBOX_DEGREES);

  const params = new URLSearchParams({
    lamin: String(south),
    lomin: String(west),
    lamax: String(box.north),
    lomax: String(box.east),
  });

  let data: OpenSkyResponse;
  try {
    const token = await getAccessToken();
    // A plain `if (!res.ok)` only handles an HTTP-level error response — a
    // connection failure (OpenSky unreachable, DNS hiccup, timeout) makes
    // fetch() itself throw instead, which without this try/catch propagated
    // all the way out as an unhandled rejection and crashed the whole
    // server (confirmed in production). The explicit timeout keeps a hung
    // connection from stalling the request indefinitely either.
    const res = await fetch(`${OPENSKY_STATES_URL}?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { error: `OpenSky lookup failed (${res.status})` };
    }
    data = (await res.json()) as OpenSkyResponse;
  } catch (err) {
    return { error: `OpenSky lookup failed: ${err instanceof Error ? err.message : "network error"}` };
  }
  if (!data.states) return [];

  // Index positions per OpenSky's documented state-vector array order:
  // https://openskynetwork.github.io/opensky-api/rest.html#response
  return data.states.flatMap((s) => {
    const lon = s[5] as number | null;
    const lat = s[6] as number | null;
    if (lat == null || lon == null) return [];
    const baroAltitudeM = s[7] as number | null;
    const velocityMs = s[9] as number | null;
    const verticalRateMs = s[11] as number | null;
    return [
      {
        icao24: s[0] as string,
        callsign: ((s[1] as string) ?? "").trim() || "Unknown",
        originCountry: s[2] as string,
        lat,
        lon,
        altitudeFt: baroAltitudeM != null ? Math.round(baroAltitudeM * 3.28084) : null,
        velocityMph: velocityMs != null ? Math.round(velocityMs * 2.23694) : null,
        headingDeg: s[10] as number | null,
        verticalRateFtMin: verticalRateMs != null ? Math.round(verticalRateMs * 196.85) : null,
        onGround: Boolean(s[8]),
      },
    ];
  });
}

// Free, keyless community mirrors of ADS-B Exchange-style data — used as an
// automatic fallback when OpenSky is unreachable (e.g. it blocks traffic
// from cloud-host IP ranges like Render's, confirmed by OpenSky timing out
// consistently from production while every other external API this server
// calls works fine). Both expose a "point + radius" query rather than a
// bounding box, so the box is converted to a center point and a covering
// radius. Tried in order; adsb.fi is a second independent mirror in case
// adsb.lol is ever down or also blocked.
// Both mirrors reject requests without a descriptive User-Agent (a generic
// one gets a 403 with "User-Agent too generic; include valid contact info").
const ADSB_USER_AGENT = "JarvysApp/1.0 (personal assistant app; contact: theultimategoldenking@gmail.com)";

const ADSB_MIRRORS = [
  {
    name: "adsb.lol",
    aircraftKey: "ac" as const,
    buildUrl: (lat: number, lon: number, radiusNm: number) =>
      `https://api.adsb.lol/v2/point/${lat}/${lon}/${radiusNm}`,
  },
  {
    name: "adsb.fi",
    aircraftKey: "aircraft" as const,
    buildUrl: (lat: number, lon: number, radiusNm: number) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radiusNm}`,
  },
];

const EARTH_RADIUS_NM = 3440.065;
const MAX_MIRROR_RADIUS_NM = 250;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxToPointRadius(box: BoundingBox): { lat: number; lon: number; radiusNm: number } {
  const south = Math.max(box.south, box.north - MAX_BBOX_DEGREES);
  const west = Math.max(box.west, box.east - MAX_BBOX_DEGREES);
  const lat = (south + box.north) / 2;
  const lon = (west + box.east) / 2;
  const radiusNm = Math.min(
    MAX_MIRROR_RADIUS_NM,
    Math.max(haversineNm(lat, lon, box.north, box.east), haversineNm(lat, lon, south, west))
  );
  return { lat, lon, radiusNm };
}

interface AdsbAircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  baro_rate?: number;
}

async function getFlightsFromAdsbMirror(
  mirror: (typeof ADSB_MIRRORS)[number],
  box: BoundingBox
): Promise<Flight[] | { error: string }> {
  const { lat, lon, radiusNm } = bboxToPointRadius(box);
  try {
    const res = await fetch(mirror.buildUrl(lat, lon, Math.round(radiusNm)), {
      headers: { "User-Agent": ADSB_USER_AGENT },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { error: `${mirror.name} lookup failed (${res.status})` };
    }
    const data = (await res.json()) as Record<string, AdsbAircraft[] | undefined>;
    const aircraft = data[mirror.aircraftKey] ?? [];
    return aircraft.flatMap((a) => {
      if (a.lat == null || a.lon == null) return [];
      const onGround = a.alt_baro === "ground";
      return [
        {
          icao24: a.hex,
          callsign: (a.flight ?? "").trim() || "Unknown",
          originCountry: "",
          lat: a.lat,
          lon: a.lon,
          altitudeFt: !onGround && typeof a.alt_baro === "number" ? Math.round(a.alt_baro) : null,
          velocityMph: a.gs != null ? Math.round(a.gs * 1.15078) : null,
          headingDeg: a.track ?? null,
          verticalRateFtMin: a.baro_rate ?? null,
          onGround,
        },
      ];
    });
  } catch (err) {
    return { error: `${mirror.name} lookup failed: ${err instanceof Error ? err.message : "network error"}` };
  }
}

export async function getFlightsInBoundingBox(box: BoundingBox): Promise<Flight[] | { error: string }> {
  const openSkyResult = await getFlightsFromOpenSky(box);
  if (!("error" in openSkyResult)) return openSkyResult;

  console.error(`OpenSky unavailable (${openSkyResult.error}) — falling back to ADS-B mirrors`);
  const errors = [openSkyResult.error];
  for (const mirror of ADSB_MIRRORS) {
    const result = await getFlightsFromAdsbMirror(mirror, box);
    if (!("error" in result)) return result;
    errors.push(result.error);
  }

  return { error: `Flight lookup failed: ${errors.join("; ")}` };
}

export function flightToMapPoint(f: Flight): MapPoint {
  const blurb = [
    `Callsign: ${f.callsign}`,
    `From: ${f.originCountry}`,
    f.onGround ? "On the ground" : `Altitude: ${f.altitudeFt ?? "?"} ft`,
    f.velocityMph != null ? `Speed: ${f.velocityMph} mph` : null,
    f.headingDeg != null ? `Heading: ${Math.round(f.headingDeg)}°` : null,
    f.verticalRateFtMin != null && Math.abs(f.verticalRateFtMin) > 100
      ? `${f.verticalRateFtMin > 0 ? "Climbing" : "Descending"} ${Math.abs(f.verticalRateFtMin)} ft/min`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    label: f.callsign,
    lat: f.lat,
    lon: f.lon,
    icon: "✈️",
    category: "flight",
    blurb,
  };
}
