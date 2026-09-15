import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polygon, Polyline, PROVIDER_DEFAULT, UrlTile } from "react-native-maps";
import type { OsmEditorElement } from "../api";
import { USGS_LIDAR_TILE_URL } from "../utils/lidar";
import { nodeGeometry, osmEditorElementKey, wayGeometry, wayLatLngs, wayLooksAreal } from "../utils/osmEditorGeometry";
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
export type EditorMode = "view" | "draw-boundary" | "new-node" | "new-way" | "ai-trace-building" | "ai-trace-road";
export type EditorBaseLayer = "osm" | "satellite" | "bing";

export type WayDraftPoint = { existingId: number } | { lat: number; lon: number };

interface OsmEditorMapProps {
  elements: OsmEditorElement[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  mode: EditorMode;
  onBoundaryFinish: (points: { lat: number; lon: number }[]) => void;
  onWayFinish: (points: WayDraftPoint[], closeLoop?: boolean) => void;
  onCreateNode: (lat: number, lon: number) => void;
  onNodeDragEnd: (id: number, lat: number, lon: number) => void;
  // The two AI-assisted tracing tools (ai-trace-building, ai-trace-road)
  // are web-only — see OsmEditorMap.web.tsx. Their toolbar buttons in
  // JlosmeScreen only render on web, so `mode` never actually becomes
  // either value here; this prop exists purely so both platform files
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

function actionColor(action: OsmEditorElement["action"]): string {
  if (action === "create") return "#27ae60";
  if (action === "modify") return "#e67e22";
  if (action === "delete") return "#c0392b";
  return "#2980b9";
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const OsmEditorMap = React.forwardRef<OsmEditorMapHandle, OsmEditorMapProps>(function OsmEditorMap(
  {
    elements,
    selectedKey,
    onSelect,
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
      onSelect(null);
    }
  }

  function handleNodePress(id: number, lat: number, lon: number) {
    if (mode === "new-way") {
      setDraftPoints((pts) => [...pts, { lat, lon, existingId: id }]);
      return;
    }
    onSelect(osmEditorElementKey("node", id));
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

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      mapType={baseLayer === "satellite" ? "satellite" : "standard"}
      initialRegion={initialRegion ? { ...initialRegion, latitudeDelta: 0.05, longitudeDelta: 0.05 } : DEFAULT_REGION}
      onPress={(e) => handleMapPress(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
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
            return (
              <Polygon
                key={key}
                coordinates={latlngs}
                strokeColor={color}
                fillColor={withAlpha(color, 0.25)}
                strokeWidth={selected ? 5 : 3}
                tappable
                onPress={() => onSelect(osmEditorElementKey("way", el.id))}
              />
            );
          }
          return (
            <Polyline
              key={key}
              coordinates={latlngs}
              strokeColor={color}
              strokeWidth={selected ? 5 : 3}
              tappable
              onPress={() => onSelect(osmEditorElementKey("way", el.id))}
            />
          );
        })}

      {elements
        .filter((el) => el.type === "node")
        .map((el) => {
          const g = nodeGeometry(el);
          const selected = osmEditorElementKey("node", el.id) === selectedKey;
          return (
            <Marker
              key={`node-${el.id}`}
              coordinate={{ latitude: g.lat, longitude: g.lon }}
              draggable
              anchor={{ x: 0.5, y: 0.5 }}
              onPress={() => handleNodePress(el.id, g.lat, g.lon)}
              onDragEnd={(e) => onNodeDragEnd(el.id, e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
            >
              <View
                style={[
                  styles.nodeDot,
                  {
                    backgroundColor: actionColor(el.action),
                    width: selected ? 16 : 10,
                    height: selected ? 16 : 10,
                    borderRadius: selected ? 8 : 5,
                  },
                ]}
              />
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
  nodeDot: { borderWidth: 2, borderColor: "#fff" },
  draftDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: "#fff" },
});
