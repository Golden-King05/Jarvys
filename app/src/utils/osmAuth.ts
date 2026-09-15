import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useMemo } from "react";
import { makeKeyStorage } from "../storage";
import { osmClientIdFor, osmDiscoveryFor, OSM_OAUTH_SCOPES, type OsmTarget } from "./osmConfig";

// Required once per app for expo-web-browser's auth session flow to
// correctly close the in-app browser and hand control back after the OAuth
// redirect completes.
WebBrowser.maybeCompleteAuthSession();

// Keyed by target (sandbox vs production are entirely separate OSM
// accounts/tokens) and stored as one JSON blob rather than two storage
// keys, since both are read/written together often enough that one round
// trip is simpler.
const osmTokenStorage = makeKeyStorage("jarvys.osmToken");

type StoredTokens = Partial<Record<OsmTarget, string>>;

async function readStoredTokens(): Promise<StoredTokens> {
  const raw = await osmTokenStorage.get();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return {};
  }
}

export async function getOsmToken(target: OsmTarget): Promise<string | null> {
  const tokens = await readStoredTokens();
  return tokens[target] ?? null;
}

export async function saveOsmToken(target: OsmTarget, token: string): Promise<void> {
  const tokens = await readStoredTokens();
  tokens[target] = token;
  await osmTokenStorage.set(JSON.stringify(tokens));
}

export async function clearOsmToken(target: OsmTarget): Promise<void> {
  const tokens = await readStoredTokens();
  delete tokens[target];
  await osmTokenStorage.set(JSON.stringify(tokens));
}

// Remembers which upload target (sandbox/production) the user last picked,
// across sessions — defaults to sandbox everywhere it's read.
export const osmTargetStorage = makeKeyStorage("jarvys.osmTarget");

// Drives the OSM OAuth2 Authorization Code + PKCE flow for one target.
// Must be called unconditionally at component top level (rules of hooks) —
// callers switch `target` via state/props, not by conditionally calling
// this hook itself.
export function useOsmOAuthRequest(target: OsmTarget) {
  const clientId = osmClientIdFor(target);
  const discovery = useMemo(() => osmDiscoveryFor(target), [target]);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "jarvys", path: "osm-oauth-callback" });
  const [request, , promptAsync] = AuthSession.useAuthRequest(
    { clientId, redirectUri, scopes: OSM_OAUTH_SCOPES, usePKCE: true },
    discovery
  );

  // Runs the full login: opens the OSM authorization page, exchanges the
  // returned code for an access token, and saves it. Returns the token on
  // success, or null if the user cancelled/dismissed the login.
  async function login(): Promise<string | null> {
    if (!clientId) {
      throw new Error(
        `No OSM OAuth client ID is configured yet for ${target} — register an application on OpenStreetMap and fill it in (see app/src/utils/osmConfig.ts).`
      );
    }
    const result = await promptAsync();
    if (result.type !== "success" || !result.params.code) return null;
    const tokenResult = await AuthSession.exchangeCodeAsync(
      {
        clientId,
        code: result.params.code,
        redirectUri,
        extraParams: { code_verifier: request?.codeVerifier ?? "" },
      },
      discovery
    );
    await saveOsmToken(target, tokenResult.accessToken);
    return tokenResult.accessToken;
  }

  return { canLogin: Boolean(clientId), login };
}
