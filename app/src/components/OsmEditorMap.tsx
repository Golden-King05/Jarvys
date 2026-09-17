import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polygon, Polyline, PROVIDER_DEFAULT, UrlTile } from "react-native-maps";
import type { OsmEditorElement } from "../api";
import { USGS_LIDAR_TILE_URL } from "../utils/lidar";
import {
  areaFillColor,
  metersPerPixel,
  nodeGeometry,
  nodeIconGlyph,
  nodeVisibilityAtZoom,
  osmEditorElementKey,
  wayGeometry,
  wayLatLngs,
  wayLooksAreal,
} from "../utils/osmEditorGeometry";
import type { LatLonBox } from "../utils/geoBox";
import type { AiTraceStatus } from "../utils/aiTraceTypes";

// Native (react-native-maps) counterpart to OsmEditorMap.web.tsx — same
// props/imperative handle shape so JlosmeScreen can use either without
// knowing which one the bundler picked. Deliberately simpler than the web
// version per this codebase's established web/native asymmetry (see the
// lidar contrast slider being web-only, etc.): node/way rendering, tag
// editing, drag-to-move and delete all work the same; freeform boundary and
// new-way drawing use plain sequential taps (no live-preview polish) since
// react-native-maps has no direct equivalent to Leaflet's click-to-draw
// ergonomics. Bing imagery isn't wired up here — quadkey tile addressing
// needs a custom native tile provider react-native-maps' UrlTile can't
// express with a plain URL template — so "bing" falls back to the standard
// map style; the imagery picker (JlosmeScreen) hides the Bing option on
// native for that reason.
export type EditorMode =
  | "view"
  | "draw-boundary"
  // The toolbar's single "+" button's mode — see OsmEditorMap.web.tsx's
  // matching comment. "new-node"/"new-way" stay as their own explicit
  // modes, reachable by holding "+".
  | "add"
  | "new-node"
  | "new-way"
  | "ai-trace-building"
  | "ai-trace-road"
  | "ai-trace-stream";
export type EditorBaseLayer = "osm" | "satellite" | "bing";

// A new point that lands on an existing way's line gets "hooked" into
// it — spliced into that way's own node list as a new shared vertex,
// right between the two neighbors it snapped between — instead of just
// sitting there unconnected. Identifies the segment by its two node ids
// rather than a numeric array index, since inserting a node into the way
// shifts every index after it; the id pair stays correct regardless.
export interface WayHookTarget {
  wayId: number;
  nodeIdA: number;
  nodeIdB: number;
}

// `reattachId`: a brand-new position that should nonetheless reuse a
// parked tagged sub-node's real id (see redrawGuide below) — a modify of
// that node, not a fresh create, so a point feature riding along a
// redrawn way (a stop sign, a hydrant) keeps its own identity/tags/history
// instead of losing them to a plain new geometry-only node.
// `hook`: set on a brand-new point that landed on an existing way's line —
// see WayHookTarget.
export type WayDraftPoint =
  | { existingId: number }
  | { reattachId: number; lat: number; lon: number }
  | { lat: number; lon: number; hook?: WayHookTarget };

// Maps the raw draft points into the shape onWayFinish expects — shared by
// finishDraw (open way) and handleCloseLoop (area) below.
function mapDraftPoints(
  pts: { lat: number; lon: number; existingId?: number; reattachId?: number; hook?: WayHookTarget }[]
): WayDraftPoint[] {
  return pts.map((p) =>
    p.existingId !== undefined
      ? { existingId: p.existingId }
      : p.reattachId !== undefined
        ? { reattachId: p.reattachId, lat: p.lat, lon: p.lon }
        : { lat: p.lat, lon: p.lon, hook: p.hook }
  );
}

interface OsmEditorMapProps {
  elements: OsmEditorElement[];
  selectedKey: string | null;
  // Fired on every tap/press selection. Unlike the web map
  // (OsmEditorMap.web.tsx), this always reports a single-element list —
  // react-native-maps doesn't reliably hand back the press's own map
  // coordinate across every shape type/platform combination, so there's no
  // solid way to search for nearby overlapping candidates here. JlosmeScreen's
  // cycle-arrows UI simply has nothing to cycle through on native.
  onSelectCandidates: (keys: string[]) => void;
  mode: EditorMode;
  onBoundaryFinish: (points: { lat: number; lon: number }[]) => void;
  onWayFinish: (points: WayDraftPoint[], closeLoop?: boolean) => void;
  // `hook`: set when the tap landed on an existing way's line — see
  // WayHookTarget.
  onCreateNode: (lat: number, lon: number, hook?: WayHookTarget) => void;
  onNodeDragEnd: (id: number, lat: number, lon: number) => void;
  // The three AI-assisted tracing tools (ai-trace-building, ai-trace-road,
  // ai-trace-stream) are web-only — see OsmEditorMap.web.tsx. Their toolbar
  // buttons in JlosmeScreen only render on web, so `mode` never actually
  // becomes any of these values here; this prop exists purely so both platform files
  // share one prop interface.
  onAiTraceStatus: (status: AiTraceStatus) => void;
  baseLayer: EditorBaseLayer;
  showLidar: boolean;
  lidarOpacity: number;
  initialRegion?: { latitude: number; longitude: number };
  // Original node positions of whichever way is currently armed for a
  // Save-ID redraw (see JlosmeScreen's savedRedrawIds) — rendered as small
  // guide markers so the freshly drawn shape can visually line up with the
  // one it's replacing. A tagged entry (e.g. a stop sign that rode along
  // the old way) is highlighted and pressable — tapping it adds a
  // reattachId draft point (see WayDraftPoint) so that spot's own id/tags
  // carry forward onto the new shape. A plain (untagged) entry stays a
  // subtle, non-interactive reference point. Null/undefined outside a way
  // redraw.
  redrawGuide?: { id: number; lat: number; lon: number; tags: Record<string, string> }[] | null;
}

export interface OsmEditorMapHandle {
  finishDraw: () => void;
  cancelDraw: () => void;
  getViewportBounds: () => Promise<LatLonBox | null>;
}

const DEFAULT_REGION = { latitude: 39.8283, longitude: -98.5795, latitudeDelta: 30, longitudeDelta: 30 };

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Target width, in screen pixels, of the tinted border band drawn around
// an area's outline — see insetRingMeters below.
const AREA_FILL_BAND_PX = 24;

// Shrinks a ring toward its own centroid so an area's fill stays strictly
// inside the boundary (JOSM tints only a band near the edge, not the whole
// interior) rather than straddling it like a centered stroke would, and
// keeps that band a genuinely fixed screen-pixel width across zoom levels
// (so it shrinks relative to the shape as you zoom in, same as the web map
// — OsmEditorMap.web.tsx does this directly via Leaflet's latlng<->pixel
// projection). Native has no such projection, so this converts the target
// pixel width to real-world meters at the shape's own latitude/zoom
// (metersPerPixel) instead, then insets each vertex toward the centroid by
// that many meters. Returns null when the shape is too small on screen to
// keep a hole open at all, so it just reads as fully filled — same
// small-shape behavior as web's insetRingPx.
function insetRingMeters(
  latlngs: { latitude: number; longitude: number }[],
  bandPx: number,
  zoom: number
): { latitude: number; longitude: number }[] | null {
  if (latlngs.length < 3) return null;
  const cLat = latlngs.reduce((sum, p) => sum + p.latitude, 0) / latlngs.length;
  const cLon = latlngs.reduce((sum, p) => sum + p.longitude, 0) / latlngs.length;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
  const radiiMeters = latlngs.map((p) => Math.hypot((p.latitude - cLat) * metersPerDegLat, (p.longitude - cLon) * metersPerDegLon));
  const minRadiusMeters = Math.min(...radiiMeters);
  const bandMeters = bandPx * metersPerPixel(zoom, cLat);
  if (minRadiusMeters <= bandMeters) return null;
  const scale = (minRadiusMeters - bandMeters) / minRadiusMeters;
  return latlngs.map((p) => ({
    latitude: cLat + (p.latitude - cLat) * scale,
    longitude: cLon + (p.longitude - cLon) * scale,
  }));
}

function actionColor(action: OsmEditorElement["action"]): string {
  if (action === "create") return "#27ae60";
  if (action === "modify") return "#e67e22";
  if (action === "delete") return "#c0392b";
  return "#2980b9";
}

// Fill color for a selected default (no-preset) node square — see the
// node marker rendering below.
const SELECTED_NODE_FILL = "#e67e22";

const OsmEditorMap = React.forwardRef<OsmEditorMapHandle, OsmEditorMapProps>(function OsmEditorMap(
  {
    elements,
    selectedKey,
    onSelectCandidates,
    mode,
    onBoundaryFinish,
    onWayFinish,
    onCreateNode,
    onNodeDragEnd,
    baseLayer,
    showLidar,
    lidarOpacity,
    initialRegion,
    redrawGuide,
  },
  ref
) {
  const mapRef = useRef<MapView>(null);
  const [draftPoints, setDraftPoints] = useState<
    { lat: number; lon: number; existingId?: number; reattachId?: number; hook?: WayHookTarget }[]
  >([]);

  useEffect(() => {
    setDraftPoints([]);
  }, [mode]);

  const nodesById = useMemo(() => {
    const map = new Map<number, OsmEditorElement>();
    for (const el of elements) if (el.type === "node") map.set(el.id, el);
    return map;
  }, [elements]);

  function handleMapPress(lat: number, lon: number) {
    if (mode === "draw-boundary") {
      setDraftPoints((pts) => [...pts, { lat, lon }]);
    } else if (mode === "new-way" || mode === "add") {
      const hook = findWayHookTarget(lat, lon);
      setDraftPoints((pts) => [...pts, hook ? { lat: hook.lat, lon: hook.lon, hook } : { lat, lon }]);
    } else if (mode === "new-node") {
      const hook = findWayHookTarget(lat, lon);
      onCreateNode(hook ? hook.lat : lat, hook ? hook.lon : lon, hook ?? undefined);
    } else {
      onSelectCandidates([]);
    }
  }

  // Same tolerance the web map uses for its own click-candidate/hook
  // search, converted to real-world meters at the tap's own latitude/zoom
  // since native has no direct pixel-space projection to work in (see
  // insetRingMeters above).
  const HOOK_TOLERANCE_PX = 18;

  // Looks for the nearest way segment to a tapped lat/lon, within
  // HOOK_TOLERANCE_PX — used while placing a new node/way vertex so it can
  // be "hooked" into that way (spliced in as a new shared vertex, snapped
  // exactly onto the line) instead of just sitting nearby, unconnected.
  // Getting a new node onto an existing way this way is the whole point —
  // otherwise there'd be no way to add a stop sign, a driveway, or a
  // branching path at a precise point along a road that isn't already a
  // node. Returns null if nothing's close enough.
  function findWayHookTarget(lat: number, lon: number): (WayHookTarget & { lat: number; lon: number }) | null {
    const metersPerDegLat = 111320;
    const metersPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const toXY = (p: { lat: number; lon: number }) => ({ x: (p.lon - lon) * metersPerDegLon, y: (p.lat - lat) * metersPerDegLat });
    const toleranceMeters = HOOK_TOLERANCE_PX * metersPerPixel(zoom, lat);
    let best: (WayHookTarget & { lat: number; lon: number; dist: number }) | null = null;
    for (const el of elements) {
      if (el.type !== "way") continue;
      const nodeIds = wayGeometry(el).nodeIds;
      for (let i = 0; i < nodeIds.length - 1; i++) {
        const n1 = nodesById.get(nodeIds[i]);
        const n2 = nodesById.get(nodeIds[i + 1]);
        if (!n1 || !n2) continue;
        const p1 = toXY(nodeGeometry(n1));
        const p2 = toXY(nodeGeometry(n2));
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (-p1.x * dx + -p1.y * dy) / lengthSq));
        const sx = p1.x + t * dx;
        const sy = p1.y + t * dy;
        const dist = Math.hypot(sx, sy);
        if (dist <= toleranceMeters && (!best || dist < best.dist)) {
          best = {
            wayId: el.id,
            nodeIdA: nodeIds[i],
            nodeIdB: nodeIds[i + 1],
            lat: lat + sy / metersPerDegLat,
            lon: lon + sx / metersPerDegLon,
            dist,
          };
        }
      }
    }
    return best;
  }

  function handleNodePress(id: number, lat: number, lon: number) {
    if (mode === "new-way" || mode === "add") {
      setDraftPoints((pts) => [...pts, { lat, lon, existingId: id }]);
      return;
    }
    onSelectCandidates([osmEditorElementKey("node", id)]);
  }

  // A way's own rendered line/fill was pressed. While placing a node/way,
  // this should hook into that way the same as a press landing just next
  // to it (handleMapPress's own findWayHookTarget search), not select the
  // way instead. `coordinate` isn't reliably present on every platform for
  // a Polyline/Polygon press event (missing on at least iOS+Google Maps —
  // see react-native-maps' own PolylinePressEvent typing), in which case
  // there's no way to tell where on the way this landed, so it's a silent
  // no-op there rather than guessing; tapping just off the line instead
  // always gets a real coordinate via the map's own onPress.
  function handleWayPress(wayId: number, coordinate?: { latitude: number; longitude: number }) {
    if (mode === "new-way" || mode === "add" || mode === "new-node") {
      if (coordinate) handleMapPress(coordinate.latitude, coordinate.longitude);
      return;
    }
    onSelectCandidates([osmEditorElementKey("way", wayId)]);
  }

  // A tagged redraw-guide marker was pressed (see redrawGuide) — adds a
  // draft point at that same spot, marked to reattach the parked node's
  // real id rather than create a fresh one.
  function handleGuidePress(id: number, lat: number, lon: number) {
    if (mode !== "new-way" && mode !== "add") return;
    setDraftPoints((pts) => [...pts, { lat, lon, reattachId: id }]);
  }

  // The way-draft's starting point was pressed again — closes it into an
  // area by reusing the first point's own resolved id at the end (the same
  // closeLoop mechanic the AI building tracer uses on web).
  function handleCloseLoop() {
    if (draftPoints.length < 3) return;
    onWayFinish(mapDraftPoints(draftPoints), true);
    setDraftPoints([]);
  }

  useImperativeHandle(
    ref,
    () => ({
      finishDraw: () => {
        if (mode === "draw-boundary" && draftPoints.length >= 3) {
          onBoundaryFinish(draftPoints.map((p) => ({ lat: p.lat, lon: p.lon })));
        } else if (mode === "new-way" && draftPoints.length >= 2) {
          onWayFinish(mapDraftPoints(draftPoints));
        } else if (mode === "add") {
          // The single "+" mode: one pending point alone becomes a
          // standalone node, two or more become an (open) way.
          if (draftPoints.length === 1) {
            onCreateNode(draftPoints[0].lat, draftPoints[0].lon, draftPoints[0].hook);
          } else if (draftPoints.length >= 2) {
            onWayFinish(mapDraftPoints(draftPoints));
          }
        }
        setDraftPoints([]);
      },
      cancelDraw: () => setDraftPoints([]),
      getViewportBounds: async () => {
        const bounds = await mapRef.current?.getMapBoundaries();
        if (!bounds) return null;
        return {
          south: bounds.southWest.latitude,
          west: bounds.southWest.longitude,
          north: bounds.northEast.latitude,
          east: bounds.northEast.longitude,
        };
      },
    }),
    [mode, draftPoints, onBoundaryFinish, onWayFinish, onCreateNode]
  );

  const draftColor = mode === "draw-boundary" ? "#8e44ad" : "#16a085";

  // Approximate Leaflet-style zoom level derived from the region's own
  // span (log2(360°/span), the standard web-mercator tile relationship) —
  // react-native-maps doesn't expose a zoom number directly, only the
  // lat/lon deltas. Feeds nodeVisibilityAtZoom (see the node marker
  // rendering below) so node markers shrink/fade out at low zoom here too.
  const [zoom, setZoom] = useState(() => Math.log2(360 / (initialRegion ? 0.05 : DEFAULT_REGION.longitudeDelta)));

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      mapType={baseLayer === "satellite" ? "satellite" : "standard"}
      initialRegion={initialRegion ? { ...initialRegion, latitudeDelta: 0.05, longitudeDelta: 0.05 } : DEFAULT_REGION}
      onPress={(e) => handleMapPress(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
      onRegionChangeComplete={(region) => setZoom(Math.log2(360 / region.longitudeDelta))}
      // Same reasoning as the web map's MAP_MAX_ZOOM — precise editing
      // benefits from zooming in past whatever the imagery itself supports.
      // The underlying platform map SDK (Apple/Google Maps) has its own
      // real ceiling this can't exceed, but nothing here should be the one
      // stopping it short of that.
      maxZoomLevel={24}
    >
      {showLidar ? <UrlTile urlTemplate={USGS_LIDAR_TILE_URL} zIndex={0} opacity={lidarOpacity} /> : null}

      {elements
        .filter((el) => el.type === "way")
        .map((el) => {
          const latlngs = wayLatLngs(el, nodesById).map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
          if (latlngs.length < 2) return null;
          const selected = osmEditorElementKey("way", el.id) === selectedKey;
          const color = actionColor(el.action);
          const geom = wayGeometry(el);
          const closed = geom.nodeIds.length >= 2 && geom.nodeIds[0] === geom.nodeIds[geom.nodeIds.length - 1];
          const key = `way-${el.id}`;
          if (wayLooksAreal(el) && closed) {
            // JOSM only tints a band near an area's outline rather than
            // solid-filling the whole interior, so a big polygon doesn't
            // fully hide the imagery underneath — see insetRingMeters above.
            const onPress = (e: { nativeEvent: { coordinate?: { latitude: number; longitude: number } } }) =>
              handleWayPress(el.id, e.nativeEvent.coordinate);
            const hole = insetRingMeters(latlngs, AREA_FILL_BAND_PX, zoom);
            return (
              <React.Fragment key={key}>
                <Polygon
                  coordinates={latlngs}
                  holes={hole ? [hole] : undefined}
                  strokeColor="transparent"
                  fillColor={withAlpha(areaFillColor(el.tags), 0.55)}
                  tappable
                  onPress={onPress}
                />
                <Polygon
                  coordinates={latlngs}
                  strokeColor={color}
                  fillColor="transparent"
                  strokeWidth={selected ? 5 : 3}
                  tappable
                  onPress={onPress}
                />
              </React.Fragment>
            );
          }
          return (
            <Polyline
              key={key}
              coordinates={latlngs}
              strokeColor={color}
              strokeWidth={selected ? 5 : 3}
              tappable
              onPress={(e) => handleWayPress(el.id, e.nativeEvent.coordinate)}
            />
          );
        })}

      {elements
        .filter((el) => el.type === "node")
        .map((el) => {
          const g = nodeGeometry(el);
          const selected = osmEditorElementKey("node", el.id) === selectedKey;
          const glyph = nodeIconGlyph(el.tags);
          const color = actionColor(el.action);
          const { scale, opacity } = nodeVisibilityAtZoom(zoom);
          return (
            <Marker
              key={`node-${el.id}`}
              coordinate={{ latitude: g.lat, longitude: g.lon }}
              draggable
              anchor={{ x: 0.5, y: 0.5 }}
              opacity={opacity}
              onPress={() => handleNodePress(el.id, g.lat, g.lon)}
              onDragEnd={(e) => onNodeDragEnd(el.id, e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
            >
              {glyph ? (
                // A recognized preset gets its OSM-wiki emoji in a small
                // white badge — the action color moves to the badge's ring
                // so edit-state stays visible without fighting the icon.
                <View
                  style={[
                    styles.nodeBadge,
                    {
                      borderColor: color,
                      width: Math.round((selected ? 26 : 20) * scale),
                      height: Math.round((selected ? 26 : 20) * scale),
                      borderRadius: Math.round((selected ? 13 : 10) * scale),
                    },
                  ]}
                >
                  <Text style={{ fontSize: Math.round((selected ? 16 : 12) * scale) }}>{glyph}</Text>
                </View>
              ) : (
                // No recognized preset — JOSM's own default node look is a
                // small, plain square rather than a bold circle. Hollow
                // (just the action-colored outline) until selected, at
                // which point it fills solid orange.
                <View
                  style={[
                    styles.nodeDot,
                    {
                      borderColor: color,
                      backgroundColor: selected ? SELECTED_NODE_FILL : "transparent",
                      width: Math.max(1, Math.round((selected ? 11 : 7) * scale)),
                      height: Math.max(1, Math.round((selected ? 11 : 7) * scale)),
                    },
                  ]}
                />
              )}
            </Marker>
          );
        })}

      {(redrawGuide ?? []).map((p) => {
        const tagged = Object.keys(p.tags).length > 0;
        const glyph = nodeIconGlyph(p.tags);
        if (tagged) {
          // A real point feature (a stop sign, a hydrant) that just
          // happened to ride along the old way — highlighted and
          // pressable, unlike a plain geometry-only guide dot: tapping it
          // reattaches its own id/tags to the new shape instead of losing
          // them to a fresh, tagless node.
          return (
            <Marker
              key={`redraw-guide-${p.id}`}
              coordinate={{ latitude: p.lat, longitude: p.lon }}
              anchor={{ x: 0.5, y: 0.5 }}
              onPress={() => handleGuidePress(p.id, p.lat, p.lon)}
            >
              <View style={styles.redrawGuideDotTagged}>{glyph ? <Text style={styles.redrawGuideGlyph}>{glyph}</Text> : null}</View>
            </Marker>
          );
        }
        return (
          // Purely visual (no press handler), a reference for lining the
          // new shape up with the old one rather than an auto-snap.
          <Marker key={`redraw-guide-${p.id}`} coordinate={{ latitude: p.lat, longitude: p.lon }} anchor={{ x: 0.5, y: 0.5 }} opacity={0.85}>
            <View style={styles.redrawGuideDot} />
          </Marker>
        );
      })}

      {draftPoints.length >= 2 ? (
        <Polyline
          coordinates={draftPoints.map((p) => ({ latitude: p.lat, longitude: p.lon }))}
          strokeColor={draftColor}
          strokeWidth={2}
          lineDashPattern={[6, 4]}
        />
      ) : null}
      {draftPoints.map((p, i) => {
        // Once there are enough points to form an area (3+), the first one
        // becomes its own tappable target — pressing it closes the way
        // into a loop, the same as tapping back on a way's starting node
        // in JOSM, instead of requiring the "+"/Finish button.
        const closable = (mode === "new-way" || mode === "add") && draftPoints.length >= 3 && i === 0;
        if (closable) {
          return (
            <Marker key={`draft-${i}`} coordinate={{ latitude: p.lat, longitude: p.lon }} anchor={{ x: 0.5, y: 0.5 }} onPress={handleCloseLoop}>
              <View style={[styles.draftDotClosable, { borderColor: draftColor }]} />
            </Marker>
          );
        }
        // A point that snapped onto an existing way's line (see
        // findWayHookTarget) gets an orange ring — confirms at a glance
        // that it hooked in rather than just landing nearby unconnected.
        return (
          <Marker key={`draft-${i}`} coordinate={{ latitude: p.lat, longitude: p.lon }} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={[styles.draftDot, { backgroundColor: draftColor }, p.hook && styles.draftDotHooked]} />
          </Marker>
        );
      })}
    </MapView>
  );
});

export default OsmEditorMap;

const styles = StyleSheet.create({
  nodeDot: { borderWidth: 1.5 },
  nodeBadge: { backgroundColor: "#fff", borderWidth: 2, alignItems: "center", justifyContent: "center" },
  draftDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: "#fff" },
  draftDotHooked: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: "#e67e22" },
  draftDotClosable: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, backgroundColor: "#fff" },
  redrawGuideDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#9b59b6",
    backgroundColor: "#fff",
  },
  redrawGuideDotTagged: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 3,
    borderColor: "#e74c3c",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  redrawGuideGlyph: { fontSize: 14 },
});
