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
  | "new-node"
  | "new-way"
  | "ai-trace-building"
  | "ai-trace-road"
  | "ai-trace-stream";
export type EditorBaseLayer = "osm" | "satellite" | "bing";

export type WayDraftPoint = { existingId: number } | { lat: number; lon: number };

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
  onCreateNode: (lat: number, lon: number) => void;
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
  },
  ref
) {
  const mapRef = useRef<MapView>(null);
  const [draftPoints, setDraftPoints] = useState<{ lat: number; lon: number; existingId?: number }[]>([]);

  useEffect(() => {
    setDraftPoints([]);
  }, [mode]);

  const nodesById = useMemo(() => {
    const map = new Map<number, OsmEditorElement>();
    for (const el of elements) if (el.type === "node") map.set(el.id, el);
    return map;
  }, [elements]);

  function handleMapPress(lat: number, lon: number) {
    if (mode === "draw-boundary" || mode === "new-way") {
      setDraftPoints((pts) => [...pts, { lat, lon }]);
    } else if (mode === "new-node") {
      onCreateNode(lat, lon);
    } else {
      onSelectCandidates([]);
    }
  }

  function handleNodePress(id: number, lat: number, lon: number) {
    if (mode === "new-way") {
      setDraftPoints((pts) => [...pts, { lat, lon, existingId: id }]);
      return;
    }
    onSelectCandidates([osmEditorElementKey("node", id)]);
  }

  useImperativeHandle(
    ref,
    () => ({
      finishDraw: () => {
        if (mode === "draw-boundary" && draftPoints.length >= 3) {
          onBoundaryFinish(draftPoints.map((p) => ({ lat: p.lat, lon: p.lon })));
        } else if (mode === "new-way" && draftPoints.length >= 2) {
          onWayFinish(
            draftPoints.map((p) => (p.existingId !== undefined ? { existingId: p.existingId } : { lat: p.lat, lon: p.lon }))
          );
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
    [mode, draftPoints, onBoundaryFinish, onWayFinish]
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
            const onPress = () => onSelectCandidates([osmEditorElementKey("way", el.id)]);
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
              onPress={() => onSelectCandidates([osmEditorElementKey("way", el.id)])}
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

      {draftPoints.length >= 2 ? (
        <Polyline
          coordinates={draftPoints.map((p) => ({ latitude: p.lat, longitude: p.lon }))}
          strokeColor={draftColor}
          strokeWidth={2}
          lineDashPattern={[6, 4]}
        />
      ) : null}
      {draftPoints.map((p, i) => (
        <Marker key={`draft-${i}`} coordinate={{ latitude: p.lat, longitude: p.lon }} anchor={{ x: 0.5, y: 0.5 }}>
          <View style={[styles.draftDot, { backgroundColor: draftColor }]} />
        </Marker>
      ))}
    </MapView>
  );
});

export default OsmEditorMap;

const styles = StyleSheet.create({
  nodeDot: { borderWidth: 1.5 },
  nodeBadge: { backgroundColor: "#fff", borderWidth: 2, alignItems: "center", justifyContent: "center" },
  draftDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: "#fff" },
});
