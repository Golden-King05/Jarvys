// The direct OSM API's /api/0.6/map endpoint — a bounding-box read straight
// off the live (or sandbox) database, the same thing JOSM's own "Download"
// dialog uses by default for a rectangle. It's dramatically faster and more
// reliable than Overpass for this shape of request: Overpass is a shared,
// free, third-party analytical query engine (great for arbitrary polygons
// and complex filters, but visibly slower and occasionally rate-limited/
// overloaded, per osmEditorOverpass.ts's own mirror-racing fix), while this
// hits the map data provider's own primary read API. It only accepts a
// plain bbox though (no polygon filter), so a freeform boundary draw still
// needs Overpass — see routes/osmEditor.ts for how the two are combined.
//
// Which host this reads from has to match the upload target the user has
// selected (sandbox vs production) — the two are separate databases with
// disjoint element ids/versions, so editing data read from one and trying
// to upload it to the other would just fail every modify/delete with a
// "not found" or version mismatch the moment it left brand-new (negative
// id) creations.
import { MAX_ELEMENTS, type DownloadedOsmElement, type OsmElementType, type OsmGeometry } from "./osmEditorOverpass.js";
import { OSM_API_HOSTS, type OsmTarget } from "./osmEditorUpload.js";

const USER_AGENT = "JarvysApp/1.0 (personal assistant app; contact: theultimategoldenking@gmail.com)";

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last, so a decoded "&lt;" etc. above isn't re-decoded
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString))) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

// OSM's map-data XML is a flat, fixed grammar — <node>/<way>/<relation> at
// the top level, each either self-closing or wrapping only self-closing
// <tag>/<nd>/<member> children (never further nesting) — so a couple of
// targeted regexes can parse it correctly without a general XML library.
const ELEMENT_RE = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
const TAG_RE = /<tag\s+([^>]*?)\/>/g;
const ND_RE = /<nd\s+([^>]*?)\/>/g;
const MEMBER_RE = /<member\s+([^>]*?)\/>/g;

export function parseOsmXml(xml: string): DownloadedOsmElement[] {
  const elements: DownloadedOsmElement[] = [];
  let match: RegExpExecArray | null;
  ELEMENT_RE.lastIndex = 0;
  while ((match = ELEMENT_RE.exec(xml))) {
    const type = match[1] as OsmElementType;
    const attrs = parseAttrs(match[2]);
    const inner = match[4] ?? "";
    const id = Number(attrs.id);
    const version = attrs.version ? Number(attrs.version) : null;
    if (!Number.isFinite(id)) continue;

    const tags: Record<string, string> = {};
    TAG_RE.lastIndex = 0;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = TAG_RE.exec(inner))) {
      const tagAttrs = parseAttrs(tagMatch[1]);
      if (tagAttrs.k !== undefined) tags[tagAttrs.k] = tagAttrs.v ?? "";
    }

    let geometry: OsmGeometry;
    if (type === "node") {
      const lat = Number(attrs.lat);
      const lon = Number(attrs.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      geometry = { lat, lon };
    } else if (type === "way") {
      const nodeIds: number[] = [];
      ND_RE.lastIndex = 0;
      let ndMatch: RegExpExecArray | null;
      while ((ndMatch = ND_RE.exec(inner))) {
        const ref = Number(parseAttrs(ndMatch[1]).ref);
        if (Number.isFinite(ref)) nodeIds.push(ref);
      }
      geometry = { nodeIds };
    } else {
      const members: { type: OsmElementType; ref: number; role: string }[] = [];
      MEMBER_RE.lastIndex = 0;
      let memberMatch: RegExpExecArray | null;
      while ((memberMatch = MEMBER_RE.exec(inner))) {
        const memberAttrs = parseAttrs(memberMatch[1]);
        const ref = Number(memberAttrs.ref);
        const memberType = memberAttrs.type as OsmElementType;
        if (Number.isFinite(ref) && (memberType === "node" || memberType === "way" || memberType === "relation")) {
          members.push({ type: memberType, ref, role: memberAttrs.role ?? "" });
        }
      }
      geometry = { members };
    }

    elements.push({ type, id, version, tags, geometry });
  }
  return elements;
}

export interface MapApiBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export async function downloadOsmMapApi(
  target: OsmTarget,
  bbox: MapApiBbox
): Promise<{ elements: DownloadedOsmElement[]; truncated: boolean } | { error: string }> {
  // Bbox param order per the OSM API: left,bottom,right,top (west,south,east,north).
  const url = `${OSM_API_HOSTS[target]}/api/0.6/map?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    return { error: `Couldn't reach the OpenStreetMap API: ${err instanceof Error ? err.message : "network error"}` };
  }
  const text = await res.text();
  if (!res.ok) {
    return { error: text.trim() || `OpenStreetMap API request failed (${res.status})` };
  }
  const elements = parseOsmXml(text);
  const truncated = elements.length > MAX_ELEMENTS;
  return { elements: elements.slice(0, MAX_ELEMENTS), truncated };
}
