import React, { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { OsmEditorElement } from "../api";
import { bingTileUrl, BING_ATTRIBUTION, getBingMapsKey, isBingConfigured } from "../utils/bingImagery";
import { OSM_ATTRIBUTION, OSM_TILE_URL, SATELLITE_ATTRIBUTION, SATELLITE_TILE_URL } from "../utils/baseLayer";
import { USGS_LIDAR_ATTRIBUTION, USGS_LIDAR_TILE_URL } from "../utils/lidar";
import { osmEditorElementKey, wayGeometry, wayLatLngs, wayLooksAreal } from "../utils/osmEditorGeometry";
import type { LatLonBox } from "../utils/geoBox";

// Same runtime-loaded Leaflet (CDN, no npm package) as MapCanvas.web.tsx —
// reuses that exact loader rather than a second copy of the load logic.
const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Leaflet = any;
let leafletLoadPromise: Promise<Leaflet> | null = null;
function loadLeaflet(): Promise<Leaflet> {
  const w = window as unknown as { L?: Leaflet };
  if (w.L) return Promise.resolve(w.L);
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => resolve((window as unknown as { L: Leaflet }).L);
    script.onerror = () => reject(new Error("Failed to load Leaflet"));
    document.body.appendChild(script);
  });
  return leafletLoadPromise;
}

export type EditorMode = "view" | "draw-boundary" | "new-node" | "new-way";
export type EditorBaseLayer = "osm" | "satellite" | "bing";

// One vertex picked while drawing a new way — either a reference to an
// already-existing node (clicked on the map) or a brand-new point (clicked
// on empty space), which the caller creates as a new node before creating
// the way itself.
export type WayDraftPoint = { existingId: number } | { lat: number; lon: number };

interface OsmEditorMapProps {
  elements: OsmEditorElement[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  mode: EditorMode;
  onBoundaryFinish: (points: { lat: number; lon: number }[]) => void;
  onWayFinish: (points: WayDraftPoint[]) => void;
  onCreateNode: (lat: number, lon: number) => void;
  onNodeDragEnd: (id: number, lat: number, lon: number) => void;
  baseLayer: EditorBaseLayer;
  showLidar: boolean;
  initialRegion?: { latitude: number; longitude: number };
}

export interface OsmEditorMapHandle {
  // Finalizes whatever's being drawn (a boundary or a new way) and clears
  // the draft. No-op if the current mode has nothing to finish.
  finishDraw: () => void;
  cancelDraw: () => void;
  getViewportBounds: () => Promise<LatLonBox | null>;
}

const DEFAULT_CENTER: [number, number] = [39.8283, -98.5795];

function actionColor(action: OsmEditorElement["action"]): string {
  if (action === "create") return "#27ae60";
  if (action === "modify") return "#e67e22";
  if (action === "delete") return "#c0392b";
  return "#2980b9";
}

function nodeIcon(L: Leaflet, color: string, selected: boolean) {
  const size = selected ? 14 : 9;
  const border = selected ? "3px solid #fff" : "2px solid #fff";
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border};box-shadow:0 0 3px rgba(0,0,0,0.5);transform:translate(-50%,-50%)"></div>`,
    className: "",
    iconSize: [0, 0],
  });
}

function draftVertexIcon(L: Leaflet, color: string) {
  return L.divIcon({
    html: `<div style="width:8px;height:8px;border-radius:50%;background:${color};border:2px solid #fff;transform:translate(-50%,-50%)"></div>`,
    className: "",
    iconSize: [0, 0],
  });
}

function createBaseLayer(L: Leaflet, kind: EditorBaseLayer): Leaflet {
  if (kind === "satellite") {
    return L.tileLayer(SATELLITE_TILE_URL, { attribution: SATELLITE_ATTRIBUTION });
  }
  if (kind === "bing" && isBingConfigured()) {
    const key = getBingMapsKey();
    const BingLayer = L.TileLayer.extend({
      getTileUrl: (coords: { x: number; y: number; z: number }) => bingTileUrl(coords.x, coords.y, coords.z, key),
    });
    return new BingLayer("", { attribution: BING_ATTRIBUTION });
  }
  return L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION });
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
    initialRegion,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Leaflet>(null);
  const elementsLayerRef = useRef<Leaflet>(null);
  const draftLayerRef = useRef<Leaflet>(null);
  const baseTileLayerRef = useRef<Leaflet>(null);
  const lidarLayerRef = useRef<Leaflet>(null);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onBoundaryFinishRef = useRef(onBoundaryFinish);
  onBoundaryFinishRef.current = onBoundaryFinish;
  const onWayFinishRef = useRef(onWayFinish);
  onWayFinishRef.current = onWayFinish;
  const onCreateNodeRef = useRef(onCreateNode);
  onCreateNodeRef.current = onCreateNode;
  const onNodeDragEndRef = useRef(onNodeDragEnd);
  onNodeDragEndRef.current = onNodeDragEnd;

  // Draft points for draw-boundary / new-way modes. Kept in a ref (not
  // state) since it's mutated on every map click and only ever needs to
  // redraw the draft layer, not re-run React's own render — using state
  // here would work too, but this keeps click handling and draft rendering
  // in one place without fighting stale-closure issues from Leaflet's own
  // event callbacks.
  const draftPoints = useRef<{ lat: number; lon: number; existingId?: number }[]>([]);

  const nodesById = useMemo(() => {
    const map = new Map<number, OsmEditorElement>();
    for (const el of elements) if (el.type === "node") map.set(el.id, el);
    return map;
  }, [elements]);

  function redrawDraft(L: Leaflet) {
    const layer = draftLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const pts = draftPoints.current;
    if (pts.length === 0) return;
    const color = modeRef.current === "draw-boundary" ? "#8e44ad" : "#16a085";
    if (pts.length >= 2) {
      L.polyline(
        pts.map((p) => [p.lat, p.lon]),
        { color, weight: 2, dashArray: "6 4" }
      ).addTo(layer);
    }
    pts.forEach((p) => {
      L.marker([p.lat, p.lon], { icon: draftVertexIcon(L, color), interactive: false }).addTo(layer);
    });
  }

  function clearDraft(L: Leaflet) {
    draftPoints.current = [];
    redrawDraft(L);
  }

  function handleMapClick(L: Leaflet, lat: number, lon: number) {
    const m = modeRef.current;
    if (m === "draw-boundary") {
      draftPoints.current = [...draftPoints.current, { lat, lon }];
      redrawDraft(L);
    } else if (m === "new-way") {
      draftPoints.current = [...draftPoints.current, { lat, lon }];
      redrawDraft(L);
    } else if (m === "new-node") {
      onCreateNodeRef.current(lat, lon);
    } else {
      onSelectRef.current(null);
    }
  }

  function handleNodeClick(L: Leaflet, id: number, lat: number, lon: number) {
    if (modeRef.current === "new-way") {
      draftPoints.current = [...draftPoints.current, { lat, lon, existingId: id }];
      redrawDraft(L);
      return;
    }
    onSelectRef.current(osmEditorElementKey("node", id));
  }

  function finishDraw() {
    const pts = draftPoints.current;
    if (modeRef.current === "draw-boundary" && pts.length >= 3) {
      onBoundaryFinishRef.current(pts.map((p) => ({ lat: p.lat, lon: p.lon })));
    } else if (modeRef.current === "new-way" && pts.length >= 2) {
      onWayFinishRef.current(
        pts.map((p) => (p.existingId !== undefined ? { existingId: p.existingId } : { lat: p.lat, lon: p.lon }))
      );
    }
    loadLeaflet().then((L) => clearDraft(L));
  }

  function cancelDraw() {
    loadLeaflet().then((L) => clearDraft(L));
  }

  // Map init.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapInstance.current) return;
      const center = initialRegion ? [initialRegion.latitude, initialRegion.longitude] : DEFAULT_CENTER;
      const map = L.map(containerRef.current).setView(center, initialRegion ? 15 : 4);
      const base = createBaseLayer(L, baseLayer).addTo(map);
      baseTileLayerRef.current = base;
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        handleMapClick(L, e.latlng.lat, e.latlng.lng);
      });
      mapInstance.current = map;
      elementsLayerRef.current = L.layerGroup().addTo(map);
      draftLayerRef.current = L.layerGroup().addTo(map);
      setTimeout(() => map.invalidateSize(), 0);
    });
    return () => {
      cancelled = true;
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disable double-click-zoom while drawing (dblclick would otherwise both
  // add a vertex via the click handler and zoom the map) and clear any
  // in-progress draft whenever the mode changes away from a drawing mode.
  useEffect(() => {
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      if (!map) return;
      if (mode === "draw-boundary" || mode === "new-way") {
        map.doubleClickZoom.disable();
      } else {
        map.doubleClickZoom.enable();
        clearDraft(L);
      }
    });
  }, [mode]);

  // Base layer swap.
  useEffect(() => {
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      const current = baseTileLayerRef.current;
      if (!map || !current) return;
      map.removeLayer(current);
      const next = createBaseLayer(L, baseLayer).addTo(map);
      next.bringToBack();
      baseTileLayerRef.current = next;
    });
  }, [baseLayer]);

  // Lidar hillshade overlay — same tile source/behavior as the main Map
  // screen's layer.
  useEffect(() => {
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      if (!map) return;
      if (showLidar) {
        if (!lidarLayerRef.current) {
          lidarLayerRef.current = L.tileLayer(USGS_LIDAR_TILE_URL, {
            opacity: 0.7,
            attribution: USGS_LIDAR_ATTRIBUTION,
          }).addTo(map);
        }
      } else if (lidarLayerRef.current) {
        map.removeLayer(lidarLayerRef.current);
        lidarLayerRef.current = null;
      }
    });
  }, [showLidar]);

  // Renders every node/way in the working set. Relations aren't drawn (per
  // scope — a relation's constituent ways already render with normal way
  // styling; the relation itself is edited via its member list, not as a
  // merged shape on the map).
  useEffect(() => {
    loadLeaflet().then((L) => {
      const layer = elementsLayerRef.current;
      if (!layer) return;
      layer.clearLayers();

      for (const el of elements) {
        const key = osmEditorElementKey(el.type, el.id);
        const selected = key === selectedKey;
        const color = actionColor(el.action);

        if (el.type === "way") {
          const latlngs = wayLatLngs(el, nodesById);
          if (latlngs.length < 2) continue;
          const areal = wayLooksAreal(el);
          const geom = wayGeometry(el);
          const closed = geom.nodeIds.length >= 2 && geom.nodeIds[0] === geom.nodeIds[geom.nodeIds.length - 1];
          const shape = areal && closed
            ? L.polygon(latlngs, {
                color,
                weight: selected ? 5 : 3,
                fillColor: color,
                fillOpacity: 0.25,
                dashArray: el.action === "delete" ? "6 4" : undefined,
              })
            : L.polyline(latlngs, {
                color,
                weight: selected ? 5 : 3,
                dashArray: el.action === "delete" ? "6 4" : undefined,
              });
          shape.addTo(layer).on("click", (e: { originalEvent: Event }) => {
            e.originalEvent.stopPropagation();
            onSelectRef.current(key);
          });
        }
      }

      // Nodes drawn after ways so their handles sit on top and stay
      // clickable/draggable even where a way passes through them.
      for (const el of elements) {
        if (el.type !== "node") continue;
        const key = osmEditorElementKey("node", el.id);
        const selected = key === selectedKey;
        const geom = el.geometry as { lat: number; lon: number };
        const marker = L.marker([geom.lat, geom.lon], {
          icon: nodeIcon(L, actionColor(el.action), selected),
          draggable: true,
        }).addTo(layer);
        marker.on("click", (e: { originalEvent: Event }) => {
          e.originalEvent.stopPropagation();
          handleNodeClick(L, el.id, geom.lat, geom.lon);
        });
        marker.on("dragend", () => {
          const { lat, lng } = marker.getLatLng();
          onNodeDragEndRef.current(el.id, lat, lng);
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, selectedKey, nodesById]);

  useImperativeHandle(ref, () => ({
    finishDraw,
    cancelDraw,
    getViewportBounds: async () => {
      const map = mapInstance.current;
      if (!map) return null;
      const bounds = map.getBounds();
      return {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      };
    },
  }));

  return <div ref={containerRef} style={{ flex: 1, width: "100%", height: "100%" }} />;
});

export default OsmEditorMap;
