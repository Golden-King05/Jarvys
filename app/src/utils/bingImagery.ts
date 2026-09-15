// The "bones" for a Bing aerial imagery base layer in JLOSME — a real key
// isn't something this build can obtain, so this is the config slot + the
// pieces a working layer needs, wired up but inert until a key exists. The
// imagery picker shows "Bing" greyed out with a hint to add a key until
// isBingConfigured() is true, then it lights up automatically — no other
// code change needed once EXPO_PUBLIC_BING_MAPS_KEY is set.
//
// EXPO_PUBLIC_ is Expo's own prefix for env vars that must reach client
// bundles (web and native alike) — anything without it stays server-only
// and would be undefined here. Set it in app/.env (see Expo's docs on
// environment variables) or your shell before running `expo start`/build.
export const BING_MAPS_KEY_ENV_VAR = "EXPO_PUBLIC_BING_MAPS_KEY";

// process.env is statically inlined by Metro/Expo at build time for
// EXPO_PUBLIC_-prefixed vars, so this needs the literal expression (not a
// dynamic process.env[name] lookup) to actually get replaced.
const BING_MAPS_KEY = process.env.EXPO_PUBLIC_BING_MAPS_KEY ?? "";

export function isBingConfigured(): boolean {
  return BING_MAPS_KEY.trim().length > 0;
}

export function getBingMapsKey(): string {
  return BING_MAPS_KEY;
}

export const BING_ATTRIBUTION = "Bing Maps aerial imagery — © Microsoft and its suppliers";

// Standard Bing Maps tile addressing: each z/x/y tile maps to one
// "quadkey" string (documented at Microsoft's Bing Maps Tile System docs).
// Used by the web map's custom Leaflet layer (see OsmEditorMap.web.tsx) to
// build each tile's request URL without needing a separate metadata-API
// round trip first.
export function tileToQuadKey(x: number, y: number, z: number): string {
  let quadKey = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadKey += digit.toString();
  }
  return quadKey;
}

export function bingTileUrl(x: number, y: number, z: number, key: string): string {
  const quadKey = tileToQuadKey(x, y, z);
  const subdomain = ["t0", "t1", "t2", "t3"][(x + y) % 4];
  return `https://ecn.${subdomain}.tiles.virtualearth.net/tiles/a${quadKey}.jpeg?g=1&key=${encodeURIComponent(key)}`;
}
