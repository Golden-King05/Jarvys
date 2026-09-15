// Configuration for JLOSME's OSM OAuth2 login and upload target. The
// sandbox instance (master.apis.dev.openstreetmap.org) is the default
// everywhere in this feature — a deliberate safety choice so a new,
// unproven editor can't put a bad edit onto live OpenStreetMap.org data or
// the user's real OSM account reputation. Production is only ever used
// once the user explicitly flips the upload panel's target toggle.
export type OsmTarget = "sandbox" | "production";

export const OSM_API_HOSTS: Record<OsmTarget, string> = {
  sandbox: "https://master.apis.dev.openstreetmap.org",
  production: "https://api.openstreetmap.org",
};

export const OSM_TARGET_LABELS: Record<OsmTarget, string> = {
  sandbox: "Sandbox (dev.openstreetmap.org — safe for testing)",
  production: "Production (openstreetmap.org — real, live map data)",
};

// OAuth2 Authorization Code + PKCE, no client_secret needed for a public/
// native app (expo-auth-session handles the PKCE code_verifier/challenge).
// Register an application per target:
//   sandbox:    https://master.apis.dev.openstreetmap.org/oauth2/applications/new
//   production: https://www.openstreetmap.org/oauth2/applications/new
// Redirect URI to register on both: the value AuthSession.makeRedirectUri
// produces for scheme "jarvys" + path "osm-oauth-callback" (see
// useOsmOAuthRequest in osmAuth.ts) — on web that's this app's own origin
// plus that path; on native it's "jarvys://osm-oauth-callback".
// These are intentionally blank placeholders — fill them in after
// registering each application. Nothing in this build can guess them.
export const OSM_SANDBOX_CLIENT_ID = ""; // TODO: OSM sandbox OAuth2 application client_id
export const OSM_PRODUCTION_CLIENT_ID = ""; // TODO: OSM production OAuth2 application client_id

export const OSM_OAUTH_SCOPES = ["write_api"];

export function osmClientIdFor(target: OsmTarget): string {
  return target === "sandbox" ? OSM_SANDBOX_CLIENT_ID : OSM_PRODUCTION_CLIENT_ID;
}

export function osmDiscoveryFor(target: OsmTarget) {
  return {
    authorizationEndpoint: `${OSM_API_HOSTS[target]}/oauth2/authorize`,
    tokenEndpoint: `${OSM_API_HOSTS[target]}/oauth2/token`,
  };
}
