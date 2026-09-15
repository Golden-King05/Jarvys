import React, { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { OsmEditorElement } from "../api";
import { bingTileUrl, BING_ATTRIBUTION, getBingMapsKey, isBingConfigured } from "../utils/bingImagery";
import { OSM_ATTRIBUTION, OSM_TILE_URL, SATELLITE_ATTRIBUTION, SATELLITE_TILE_URL } from "../utils/baseLayer";
import { USGS_LIDAR_ATTRIBUTION, USGS_LIDAR_TILE_URL } from "../utils/lidar";
import { areaFillColor, osmEditorElementKey, wayGeometry, wayLatLngs, wayLooksAreal } from "../utils/osmEditorGeometry";
import type { LatLonBox } from "../utils/geoBox";
import type { AiTraceStatus } from "../utils/aiTraceTypes";
import { captureMapRegion, type CapturedRegion } from "../utils/mapCapture";
import { decodeClick, encodeRegion, loadMobileSam, SAM_INPUT_SIZE, type MobileSamSession, type SamEmbedding } from "../utils/mobileSam";
import { connectedComponentAt, douglasPeucker, traceComponentBoundary, type Pt } from "../utils/traceGeometry";
import { traceRoadSegment, traceStreamSegment, type LatLon } from "../utils/roadTrace";

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

export type EditorMode =
  | "view"
  | "draw-boundary"
  | "new-node"
  | "new-way"
  | "ai-trace-building"
  | "ai-trace-road"
  | "ai-trace-stream";
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
  // `closeLoop`: when true, the caller should close the way by reusing the
  // first created node's id as the last node too (used by the AI building
  // tracer's closed-polygon draft) — the manual "new way" tool never sets
  // this.
  onWayFinish: (points: WayDraftPoint[], closeLoop?: boolean) => void;
  onCreateNode: (lat: number, lon: number) => void;
  onNodeDragEnd: (id: number, lat: number, lon: number) => void;
  // Reports progress/state for the two AI-assisted tracing tools so
  // JlosmeScreen can show the right mode-banner text/buttons without
  // needing to know how tracing actually works.
  onAiTraceStatus: (status: AiTraceStatus) => void;
  baseLayer: EditorBaseLayer;
  showLidar: boolean;
  lidarOpacity: number;
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

// crossOrigin is required so the AI tracing tools can read pixels back out
// of these tiles via canvas getImageData() — without it, drawing a
// cross-origin tile onto a canvas "taints" it and any later getImageData()
// call throws a SecurityError. All of OSM's, Esri's and this app's own
// lidar proxy's tile responses were confirmed (by hand, this session) to
// send permissive CORS headers, so this doesn't change what actually loads.
// Precise editing (placing a node exactly, squaring a building) benefits
// from zooming in well past whatever resolution the actual imagery
// supports — past that point every layer just keeps stretching its last
// real tile, blurrier but still useful as a rough guide. MAP_MAX_ZOOM is
// the ceiling everything zooms to; each layer's own maxNativeZoom is where
// IT stops requesting sharper tiles and starts stretching. Leaflet computes
// the whole map's actual zoom ceiling as the minimum `maxZoom` across every
// added layer (confirmed the hard way earlier working on the main Map
// tab's lidar layer) — so every layer below must also have its own
// `maxZoom` raised to match, or the map silently stays capped at whichever
// layer forgot to.
const MAP_MAX_ZOOM = 24;

function createBaseLayer(L: Leaflet, kind: EditorBaseLayer): Leaflet {
  if (kind === "satellite") {
    // Esri World Imagery confirmed (main Map tab, this session) to have
    // real tiles to zoom 21 in a dense city.
    return L.tileLayer(SATELLITE_TILE_URL, {
      attribution: SATELLITE_ATTRIBUTION,
      crossOrigin: true,
      maxNativeZoom: 21,
      maxZoom: MAP_MAX_ZOOM,
    });
  }
  if (kind === "bing" && isBingConfigured()) {
    const key = getBingMapsKey();
    const BingLayer = L.TileLayer.extend({
      getTileUrl: (coords: { x: number; y: number; z: number }) => bingTileUrl(coords.x, coords.y, coords.z, key),
    });
    return new BingLayer("", { attribution: BING_ATTRIBUTION, crossOrigin: true, maxNativeZoom: 21, maxZoom: MAP_MAX_ZOOM });
  }
  // Standard OSM raster tiles top out at zoom 19.
  return L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, crossOrigin: true, maxNativeZoom: 19, maxZoom: MAP_MAX_ZOOM });
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
    onAiTraceStatus,
    baseLayer,
    showLidar,
    lidarOpacity,
    initialRegion,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Leaflet>(null);
  const elementsLayerRef = useRef<Leaflet>(null);
  const draftLayerRef = useRef<Leaflet>(null);
  const aiDraftLayerRef = useRef<Leaflet>(null);
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
  const onAiTraceStatusRef = useRef(onAiTraceStatus);
  onAiTraceStatusRef.current = onAiTraceStatus;

  // Building tracer state: the traced closed-ring draft (lat/lon, not yet
  // closed — the caller closes it by reusing the first node's id), plus a
  // cache of the last captured 1024x1024 region + its MobileSAM encoder
  // output so repeated clicks in the same area only re-run the cheap
  // decoder. Invalidated wholesale on any pan/zoom (see the map-init
  // effect) since a stale capture would silently show old imagery.
  const aiBuildingDraftRef = useRef<{ points: LatLon[] } | null>(null);
  const samCacheRef = useRef<{ capture: CapturedRegion; embedding: SamEmbedding } | null>(null);

  // Road tracer state: accumulated waypoints plus the traced segment
  // between each consecutive pair (segments, not one flat polyline, so a
  // later waypoint's segment can be appended/retried independently).
  const aiRoadDraftRef = useRef<{ waypoints: LatLon[]; segments: LatLon[][] } | null>(null);

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

  // Flattens the road tracer's per-segment traces into one continuous
  // point list, dropping each segment's duplicated leading point (the
  // previous segment's own endpoint).
  function flattenRoadDraft(draft: { waypoints: LatLon[]; segments: LatLon[][] }): LatLon[] {
    if (draft.segments.length === 0) return draft.waypoints.slice(0, 1);
    const pts: LatLon[] = [];
    draft.segments.forEach((seg, i) => {
      pts.push(...(i === 0 ? seg : seg.slice(1)));
    });
    return pts;
  }

  function redrawAiDraft(L: Leaflet) {
    const layer = aiDraftLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const building = aiBuildingDraftRef.current;
    if (building && building.points.length >= 3) {
      L.polygon(
        building.points.map((p) => [p.lat, p.lon]),
        { color: "#e91e63", weight: 3, dashArray: "4 4", fillColor: "#e91e63", fillOpacity: 0.15 }
      ).addTo(layer);
      building.points.forEach((p) => {
        L.marker([p.lat, p.lon], { icon: draftVertexIcon(L, "#e91e63"), interactive: false }).addTo(layer);
      });
    }
    const road = aiRoadDraftRef.current;
    if (road) {
      const lineColor = modeRef.current === "ai-trace-stream" ? "#1e88e5" : "#ff6f00";
      const flat = flattenRoadDraft(road);
      if (flat.length >= 2) {
        L.polyline(
          flat.map((p) => [p.lat, p.lon]),
          { color: lineColor, weight: 3, dashArray: "4 4" }
        ).addTo(layer);
      }
      road.waypoints.forEach((p) => {
        L.marker([p.lat, p.lon], { icon: draftVertexIcon(L, lineColor), interactive: false }).addTo(layer);
      });
    }
  }

  function clearAiDraft(L: Leaflet) {
    aiBuildingDraftRef.current = null;
    aiRoadDraftRef.current = null;
    samCacheRef.current = null;
    redrawAiDraft(L);
    onAiTraceStatusRef.current({ kind: "idle" });
  }

  // Building tracer: captures a 1024x1024 region around the click (reusing
  // the last capture/encoder output if the click falls safely inside it —
  // see samCacheRef), runs MobileSAM's decoder for that single point, then
  // contour-traces + simplifies the resulting mask into a draft polygon.
  async function runBuildingTrace(L: Leaflet, map: Leaflet, latlng: { lat: number; lng: number }, containerPoint: { x: number; y: number }) {
    // If the user cancels or switches modes while an async step below is
    // in flight, its eventual result should be silently dropped rather
    // than popping up a draft/status for a mode that's no longer active.
    const stillActive = () => modeRef.current === "ai-trace-building";

    onAiTraceStatusRef.current({ kind: "busy", message: "Loading AI model…" });
    let session: MobileSamSession;
    try {
      session = await loadMobileSam((message) => {
        if (stillActive()) onAiTraceStatusRef.current({ kind: "loading-model", message });
      });
    } catch (e) {
      if (stillActive()) onAiTraceStatusRef.current({ kind: "error", message: e instanceof Error ? e.message : "Could not load AI model" });
      return;
    }
    if (!stillActive()) return;

    try {
      const cache = samCacheRef.current;
      const MARGIN = 90;
      let localPt: { x: number; y: number } | null = cache ? cache.capture.latLonToPixel(latlng.lat, latlng.lng) : null;
      const withinCache =
        cache && localPt && localPt.x > MARGIN && localPt.y > MARGIN && localPt.x < SAM_INPUT_SIZE - MARGIN && localPt.y < SAM_INPUT_SIZE - MARGIN;

      let capture: CapturedRegion;
      let embedding: SamEmbedding;
      if (withinCache && cache) {
        capture = cache.capture;
        embedding = cache.embedding;
      } else {
        onAiTraceStatusRef.current({ kind: "busy", message: "Capturing map imagery…" });
        capture = captureMapRegion(map, containerPoint, SAM_INPUT_SIZE);
        onAiTraceStatusRef.current({ kind: "busy", message: "Analyzing image…" });
        embedding = await encodeRegion(session, capture.canvas);
        samCacheRef.current = { capture, embedding };
        localPt = capture.latLonToPixel(latlng.lat, latlng.lng);
      }

      onAiTraceStatusRef.current({ kind: "busy", message: "Segmenting…" });
      const maskResult = await decodeClick(session, embedding, localPt!.x, localPt!.y);
      if (!stillActive()) return;
      const comp = connectedComponentAt(maskResult.mask, maskResult.width, maskResult.height, Math.round(localPt!.x), Math.round(localPt!.y));
      if (!comp) {
        onAiTraceStatusRef.current({ kind: "error", message: "No object found at that point — click more centrally on a building." });
        return;
      }
      const boundary = traceComponentBoundary(comp, maskResult.width, maskResult.height);
      if (!boundary || boundary.length < 5) {
        onAiTraceStatusRef.current({ kind: "error", message: "Couldn't trace a usable outline there — try a different point." });
        return;
      }
      const simplified: Pt[] = douglasPeucker(boundary, 2.5);
      const ring = simplified.length > 1 ? simplified.slice(0, -1) : simplified; // drop the closing duplicate point
      if (ring.length < 3) {
        onAiTraceStatusRef.current({ kind: "error", message: "Traced outline was too small — try a different point." });
        return;
      }
      aiBuildingDraftRef.current = { points: ring.map((p) => capture.pixelToLatLon(p.x, p.y)) };
      redrawAiDraft(L);
      onAiTraceStatusRef.current({ kind: "ready", message: `Traced outline (${ring.length} points, score ${maskResult.score.toFixed(2)}) — Accept or Discard.` });
    } catch (e) {
      const message =
        e instanceof Error && e.name === "SecurityError"
          ? "Could not read map imagery here — try the satellite or lidar layer."
          : e instanceof Error
            ? e.message
            : "Tracing failed";
      onAiTraceStatusRef.current({ kind: "error", message });
    }
  }

  // Linear-feature tracer shared by both road and stream modes: each click
  // adds a waypoint; from the second waypoint on, traces the centerline
  // between it and the previous waypoint and appends the result to the
  // running draft. Only the imagery source (and therefore which function
  // from roadTrace.ts gets called) differs between the two — see
  // traceRoadSegment/traceStreamSegment.
  async function runLineWaypoint(
    L: Leaflet,
    map: Leaflet,
    latlng: { lat: number; lng: number },
    lineMode: "ai-trace-road" | "ai-trace-stream"
  ) {
    const prevDraft = aiRoadDraftRef.current ?? { waypoints: [], segments: [] };
    const point: LatLon = { lat: latlng.lat, lon: latlng.lng };
    const waypoints = [...prevDraft.waypoints, point];
    const traceSegment = lineMode === "ai-trace-stream" ? traceStreamSegment : traceRoadSegment;
    const noun = lineMode === "ai-trace-stream" ? "stream" : "road";

    if (waypoints.length === 1) {
      aiRoadDraftRef.current = { waypoints, segments: [] };
      redrawAiDraft(L);
      onAiTraceStatusRef.current({ kind: "idle" });
      return;
    }

    onAiTraceStatusRef.current({ kind: "busy", message: `Tracing ${noun} segment…` });
    const prevPoint = waypoints[waypoints.length - 2];
    try {
      const result = await traceSegment(prevPoint, point, map.getZoom());
      if (modeRef.current !== lineMode) return;
      const segments = [...prevDraft.segments, result.points];
      aiRoadDraftRef.current = { waypoints, segments };
      redrawAiDraft(L);
      const note = result.fellBackToStraightLine ? " (no clear imagery signal there — used a straight line)" : "";
      onAiTraceStatusRef.current({ kind: "ready", message: `Traced ${segments.length} segment(s)${note}. Add more points or Finish.` });
    } catch (e) {
      if (modeRef.current !== lineMode) return;
      // Keep the waypoint even if tracing that segment failed outright —
      // fall back to a straight line so the draft stays usable rather than
      // silently dropping the click.
      const segments = [...prevDraft.segments, [prevPoint, point]];
      aiRoadDraftRef.current = { waypoints, segments };
      redrawAiDraft(L);
      onAiTraceStatusRef.current({
        kind: "error",
        message: `${e instanceof Error ? e.message : "Segment tracing failed"} — used a straight line instead.`,
      });
    }
  }

  function handleMapClick(L: Leaflet, lat: number, lon: number, containerPoint: { x: number; y: number }) {
    const m = modeRef.current;
    if (m === "draw-boundary") {
      draftPoints.current = [...draftPoints.current, { lat, lon }];
      redrawDraft(L);
    } else if (m === "new-way") {
      draftPoints.current = [...draftPoints.current, { lat, lon }];
      redrawDraft(L);
    } else if (m === "new-node") {
      onCreateNodeRef.current(lat, lon);
    } else if (m === "ai-trace-building") {
      runBuildingTrace(L, mapInstance.current, { lat, lng: lon }, containerPoint);
    } else if (m === "ai-trace-road" || m === "ai-trace-stream") {
      runLineWaypoint(L, mapInstance.current, { lat, lng: lon }, m);
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
    } else if (modeRef.current === "ai-trace-building") {
      const draft = aiBuildingDraftRef.current;
      if (draft && draft.points.length >= 3) {
        onWayFinishRef.current(
          draft.points.map((p) => ({ lat: p.lat, lon: p.lon })),
          true
        );
      }
    } else if (modeRef.current === "ai-trace-road" || modeRef.current === "ai-trace-stream") {
      const draft = aiRoadDraftRef.current;
      if (draft) {
        const flat = flattenRoadDraft(draft);
        if (flat.length >= 2) {
          onWayFinishRef.current(
            flat.map((p) => ({ lat: p.lat, lon: p.lon })),
            false
          );
        }
      }
    }
    loadLeaflet().then((L) => {
      clearDraft(L);
      clearAiDraft(L);
    });
  }

  function cancelDraw() {
    loadLeaflet().then((L) => {
      clearDraft(L);
      clearAiDraft(L);
    });
  }

  // Map init.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapInstance.current) return;
      const center = initialRegion ? [initialRegion.latitude, initialRegion.longitude] : DEFAULT_CENTER;
      const map = L.map(containerRef.current, { maxZoom: MAP_MAX_ZOOM }).setView(center, initialRegion ? 15 : 4);
      const base = createBaseLayer(L, baseLayer).addTo(map);
      baseTileLayerRef.current = base;
      map.on("click", (e: { latlng: { lat: number; lng: number }; containerPoint: { x: number; y: number } }) => {
        handleMapClick(L, e.latlng.lat, e.latlng.lng, e.containerPoint);
      });
      // A captured-region cache (building tracer) keyed only by "did the
      // view change" — any pan/zoom invalidates it outright rather than
      // trying to track exactly what's still valid, since a stale capture
      // would otherwise silently show outdated imagery to the model.
      map.on("movestart zoomstart", () => {
        samCacheRef.current = null;
      });
      mapInstance.current = map;
      elementsLayerRef.current = L.layerGroup().addTo(map);
      draftLayerRef.current = L.layerGroup().addTo(map);
      aiDraftLayerRef.current = L.layerGroup().addTo(map);
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
      if (mode === "draw-boundary" || mode === "new-way" || mode === "ai-trace-road" || mode === "ai-trace-stream") {
        map.doubleClickZoom.disable();
      } else {
        map.doubleClickZoom.enable();
      }
      if (mode !== "draw-boundary" && mode !== "new-way") {
        clearDraft(L);
      }
      if (mode !== "ai-trace-building" && mode !== "ai-trace-road" && mode !== "ai-trace-stream") {
        clearAiDraft(L);
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
            opacity: lidarOpacity,
            attribution: USGS_LIDAR_ATTRIBUTION,
            crossOrigin: true,
            // Rendered per-request server-side (see server/src/lidarTiles.ts)
            // rather than a fixed tile pyramid, so there's no real native
            // ceiling to set here — just needs its own maxZoom raised to
            // MAP_MAX_ZOOM like every other layer (see createBaseLayer's
            // comment) so it isn't the layer that silently caps the map.
            maxZoom: MAP_MAX_ZOOM,
          }).addTo(map);
        }
      } else if (lidarLayerRef.current) {
        map.removeLayer(lidarLayerRef.current);
        lidarLayerRef.current = null;
      }
    });
  }, [showLidar]);

  // Separate from the effect above (same reasoning as MapCanvas.web.tsx's
  // main-map lidar layer) so dragging the slider adjusts the existing
  // layer's opacity instead of removing and re-adding it.
  useEffect(() => {
    lidarLayerRef.current?.setOpacity(lidarOpacity);
  }, [lidarOpacity]);

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
                color, // outline stays action-colored — what you've done to it
                weight: selected ? 5 : 3,
                fillColor: areaFillColor(el.tags), // fill is tag-colored — what it is
                // JOSM keeps its area fills close to full strength rather
                // than washing them out — 0.35 read as barely-there next to
                // the outline, especially over satellite/lidar imagery.
                fillOpacity: 0.55,
                dashArray: el.action === "delete" ? "6 4" : undefined,
              })
            : L.polyline(latlngs, {
                color,
                weight: selected ? 5 : 3,
                dashArray: el.action === "delete" ? "6 4" : undefined,
              });
          shape.addTo(layer).on("click", (e: { originalEvent: Event }) => {
            // e.originalEvent.stopPropagation() alone only stops native DOM
            // bubbling — Leaflet fires its own map "click" separately by
            // walking each layer's _eventParents (see Layer#_propagateEvent),
            // independent of native propagation, so without this the map's
            // own click handler below still ran right after and deselected
            // whatever was just selected in the same tick.
            L.DomEvent.stopPropagation(e);
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
          // Same Leaflet gotcha as the way/polygon click handler above —
          // native stopPropagation() doesn't stop Leaflet's own internal
          // event propagation to the map's click handler.
          L.DomEvent.stopPropagation(e);
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
