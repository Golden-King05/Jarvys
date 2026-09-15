// Proxies the OSM API v0.6 changeset create/upload/close calls that JLOSME's
// upload panel triggers — kept server-side for consistency with every other
// external API this app calls (Overpass, Wikipedia, USGS lidar tiles all go
// through our own server rather than being called directly from the RN
// client), even though OSM's own API hosts already send permissive CORS
// headers. The user's OSM OAuth2 access token is relayed per-request (sent
// by the client on the /osm-editor/upload call, see routes/osmEditor.ts) —
// never stored server-side, so no DB migration was needed for it.
import type { OsmElementType } from "./osmEditorOverpass.js";
import type { OsmEditorElementRow, OsmGeometry, OsmNodeGeometry, OsmRelationGeometry, OsmWayGeometry } from "./db.js";

const USER_AGENT = "JarvysApp/1.0 (personal assistant app; contact: theultimategoldenking@gmail.com)";

export type OsmTarget = "sandbox" | "production";

// Sandbox (master.apis.dev.openstreetmap.org) is the default upload target
// everywhere in this feature — a deliberate safety choice so a new, unproven
// editor can't put a bad edit onto live OpenStreetMap.org data or the
// user's real OSM reputation. Production is only ever used when the user
// explicitly flips the upload panel's target toggle.
export const OSM_API_HOSTS: Record<OsmTarget, string> = {
  sandbox: "https://master.apis.dev.openstreetmap.org",
  production: "https://api.openstreetmap.org",
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function osmApiRequest(
  target: OsmTarget,
  path: string,
  token: string,
  init: { method: string; body?: string; headers?: Record<string, string> }
): Promise<{ text: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`${OSM_API_HOSTS[target]}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return { error: `Couldn't reach the OpenStreetMap API: ${err instanceof Error ? err.message : "network error"}` };
  }
  const text = await res.text();
  if (!res.ok) {
    // OSM's own error bodies are plain, human-readable text (e.g. "Version
    // mismatch: Provided 1, server had: 2 of Node 123") — surfaced as-is
    // rather than wrapped, since that's already the clearest message
    // available for a 409 version conflict or a bad/expired token.
    return { error: text.trim() || `OpenStreetMap API request failed (${res.status})` };
  }
  return { text };
}

export async function createChangeset(
  target: OsmTarget,
  token: string,
  comment: string
): Promise<{ changesetId: number } | { error: string }> {
  const body = `<osm><changeset><tag k="created_by" v="Jarvys JLOSME editor"/><tag k="comment" v="${escapeXml(comment)}"/></changeset></osm>`;
  const result = await osmApiRequest(target, "/api/0.6/changeset/create", token, {
    method: "PUT",
    body,
    headers: { "Content-Type": "text/xml" },
  });
  if ("error" in result) return result;
  const changesetId = Number(result.text.trim());
  if (!Number.isFinite(changesetId)) {
    return { error: `Unexpected response creating changeset: ${result.text}` };
  }
  return { changesetId };
}

export async function uploadChangeset(
  target: OsmTarget,
  token: string,
  changesetId: number,
  osmChangeXml: string
): Promise<{ diffXml: string } | { error: string }> {
  const result = await osmApiRequest(target, `/api/0.6/changeset/${changesetId}/upload`, token, {
    method: "POST",
    body: osmChangeXml,
    headers: { "Content-Type": "text/xml" },
  });
  if ("error" in result) return result;
  return { diffXml: result.text };
}

export async function closeChangeset(target: OsmTarget, token: string, changesetId: number): Promise<void> {
  // Best-effort — the upload itself already succeeded (the whole point of
  // the changeset) by the time this is called, so a failure to close just
  // leaves the changeset open on OSM's side rather than losing any data.
  await osmApiRequest(target, `/api/0.6/changeset/${changesetId}/close`, token, { method: "PUT" });
}

export interface OsmDiffMapping {
  type: OsmElementType;
  oldId: number;
  newId: number;
  newVersion: number;
}

// diffResult only ever contains predictable self-closing tags like
// <node old_id="-1" new_id="123" new_version="1"/> — a regex is all that's
// needed, no reason to pull in a new XML parsing dependency for it.
const DIFF_RESULT_PATTERN = /<(node|way|relation) old_id="(-?\d+)" new_id="(\d+)" new_version="(\d+)"\s*\/>/g;

export function parseDiffResult(xml: string): OsmDiffMapping[] {
  const mappings: OsmDiffMapping[] = [];
  for (const match of xml.matchAll(DIFF_RESULT_PATTERN)) {
    mappings.push({
      type: match[1] as OsmElementType,
      oldId: Number(match[2]),
      newId: Number(match[3]),
      newVersion: Number(match[4]),
    });
  }
  return mappings;
}

function tagsXml(tagsJson: string): string {
  const tags = JSON.parse(tagsJson) as Record<string, string>;
  return Object.entries(tags)
    .filter(([k]) => k.length > 0)
    .map(([k, v]) => `<tag k="${escapeXml(k)}" v="${escapeXml(v)}"/>`)
    .join("");
}

function elementXml(row: OsmEditorElementRow, changesetId: number, includeVersion: boolean): string {
  const geometry = JSON.parse(row.geometry_json) as OsmGeometry;
  const versionAttr = includeVersion ? ` version="${row.version ?? 1}"` : "";
  if (row.el_type === "node") {
    const g = geometry as OsmNodeGeometry;
    return `<node id="${row.el_id}" changeset="${changesetId}"${versionAttr} lat="${g.lat}" lon="${g.lon}">${tagsXml(row.tags_json)}</node>`;
  }
  if (row.el_type === "way") {
    const g = geometry as OsmWayGeometry;
    const nds = g.nodeIds.map((id) => `<nd ref="${id}"/>`).join("");
    return `<way id="${row.el_id}" changeset="${changesetId}"${versionAttr}>${nds}${tagsXml(row.tags_json)}</way>`;
  }
  const g = geometry as OsmRelationGeometry;
  const members = g.members.map((m) => `<member type="${m.type}" ref="${m.ref}" role="${escapeXml(m.role)}"/>`).join("");
  return `<relation id="${row.el_id}" changeset="${changesetId}"${versionAttr}>${members}${tagsXml(row.tags_json)}</relation>`;
}

// Builds the osmChange XML for one upload. Order matters within <create>:
// nodes before ways before relations, so a way's <nd ref="-3"/> to a
// locally-created node always refers to something already declared earlier
// in the same document — sufficient for the normal case (this editor never
// produces circular references). <delete> goes in the reverse dependency
// order (relations, then ways, then nodes) so nothing still-referenced
// within this same diff gets deleted out from under something else in it.
// <modify> order doesn't matter.
export function buildOsmChangeXml(changesetId: number, batch: OsmEditorElementRow[]): string {
  const creates = batch.filter((r) => r.action === "create");
  const modifies = batch.filter((r) => r.action === "modify");
  const deletes = batch.filter((r) => r.action === "delete");

  const order: OsmElementType[] = ["node", "way", "relation"];
  const createXml = order.map((t) => creates.filter((r) => r.el_type === t)).flat().map((r) => elementXml(r, changesetId, false)).join("");
  const modifyXml = modifies.map((r) => elementXml(r, changesetId, true)).join("");
  const deleteOrder: OsmElementType[] = ["relation", "way", "node"];
  const deleteXml = deleteOrder
    .map((t) => deletes.filter((r) => r.el_type === t))
    .flat()
    .map((r) => `<${r.el_type} id="${r.el_id}" changeset="${changesetId}" version="${r.version ?? 1}"/>`)
    .join("");

  return (
    `<osmChange version="0.6">` +
    (createXml ? `<create>${createXml}</create>` : "") +
    (modifyXml ? `<modify>${modifyXml}</modify>` : "") +
    (deleteXml ? `<delete if-unused="true">${deleteXml}</delete>` : "") +
    `</osmChange>`
  );
}
