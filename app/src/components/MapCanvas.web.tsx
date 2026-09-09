import React, { useEffect, useRef } from "react";
import type { MapPoint, RegionMapData } from "../api";

const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Leaflet = any;

let leafletLoadPromise: Promise<Leaflet> | null = null;

// react-native-maps has no web target, so the web build (a real browser
// page, not a native WebView) loads plain Leaflet + OpenStreetMap tiles
// straight from a CDN instead — no npm package, no API key.
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

interface MapCanvasProps {
  points: MapPoint[];
  showLine?: boolean;
  regions?: RegionMapData[];
  initialRegion?: { latitude: number; longitude: number };
  onMapPress?: (lat: number, lon: number) => void;
  onPointPress?: (point: MapPoint) => void;
  pendingMarker?: { lat: number; lon: number } | null;
}

const DEFAULT_CENTER: [number, number] = [39.8283, -98.5795];

function emojiIcon(L: Leaflet, icon: string) {
  return L.divIcon({
    html: `<div style="font-size:22px;line-height:1;transform:translate(-50%,-50%)">${icon}</div>`,
    className: "",
    iconSize: [0, 0],
  });
}

export default function MapCanvas({
  points,
  showLine,
  regions,
  initialRegion,
  onMapPress,
  onPointPress,
  pendingMarker,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Leaflet>(null);
  const layerGroup = useRef<Leaflet>(null);
  const onMapPressRef = useRef(onMapPress);
  onMapPressRef.current = onMapPress;

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapInstance.current) return;
      const center = initialRegion ? [initialRegion.latitude, initialRegion.longitude] : DEFAULT_CENTER;
      const map = L.map(containerRef.current).setView(center, initialRegion ? 12 : 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        onMapPressRef.current?.(e.latlng.lat, e.latlng.lng);
      });
      mapInstance.current = map;
      layerGroup.current = L.layerGroup().addTo(map);
      setTimeout(() => map.invalidateSize(), 0);
    });
    return () => {
      cancelled = true;
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      const layer = layerGroup.current;
      if (!map || !layer) return;
      layer.clearLayers();

      if (regions && regions.length > 0) {
        L.geoJSON(
          {
            type: "FeatureCollection",
            features: regions.map((r) => ({ type: "Feature", properties: { name: r.name }, geometry: r.geometry })),
          },
          { style: { color: "#2980b9", weight: 2, fillColor: "#2980b9", fillOpacity: 0.25 } }
        ).addTo(layer);
      }

      points.forEach((p: MapPoint) => {
        L.marker([p.lat, p.lon], { icon: emojiIcon(L, p.icon ?? "📍") })
          .addTo(layer)
          .bindPopup(p.address ? `${p.label}<br>${p.address}` : p.label)
          .on("click", () => onPointPress?.(p));
      });

      if (pendingMarker) {
        L.marker([pendingMarker.lat, pendingMarker.lon], { icon: emojiIcon(L, "📌") }).addTo(layer);
      }

      if (showLine && points.length === 2) {
        L.polyline(
          points.map((p) => [p.lat, p.lon]),
          { color: "#2980b9", weight: 3 }
        ).addTo(layer);
      }

      const allPins = pendingMarker ? [...points, { lat: pendingMarker.lat, lon: pendingMarker.lon }] : points;
      if (allPins.length === 1) {
        map.setView([allPins[0].lat, allPins[0].lon], 13);
      } else if (allPins.length > 1) {
        const bounds = L.latLngBounds(allPins.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds, { padding: [60, 60] });
      } else if (regions && regions.length > 0) {
        const layerBounds = layer.getBounds?.();
        if (layerBounds?.isValid?.()) map.fitBounds(layerBounds, { padding: [40, 40] });
      }
    });
  }, [points, showLine, regions, pendingMarker, onPointPress]);

  return <div ref={containerRef} style={{ flex: 1, width: "100%", height: "100%" }} />;
}
