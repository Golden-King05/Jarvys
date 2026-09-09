import React, { useEffect, useRef } from "react";
import type { MapPoint, RegionMapData } from "../api";
import { getRadarTileTemplate } from "../utils/radar";
import { statusColor } from "../utils/regionStatus";
import { formatOffset, getTimezoneBands } from "../utils/timezoneBands";

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
  onRegionPress?: (region: RegionMapData) => void;
  pendingMarker?: { lat: number; lon: number } | null;
  showRadar?: boolean;
  showTimezoneBands?: boolean;
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
  onRegionPress,
  pendingMarker,
  showRadar,
  showTimezoneBands,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Leaflet>(null);
  const layerGroup = useRef<Leaflet>(null);
  const radarLayerRef = useRef<Leaflet>(null);
  const tzLayerRef = useRef<Leaflet>(null);
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
            features: regions.map((r) => ({
              type: "Feature",
              properties: { name: r.name, status: r.status },
              geometry: r.geometry,
            })),
          },
          {
            style: (feature: { properties: { status?: RegionMapData["status"] } }) => {
              const color = statusColor(feature.properties.status);
              return { color, weight: 1.5, fillColor: color, fillOpacity: 0.35 };
            },
            onEachFeature: (feature: { properties: { name: string } }, layer: Leaflet) => {
              layer.on("click", () => {
                const region = regions.find((r) => r.name === feature.properties.name);
                if (region) onRegionPress?.(region);
              });
            },
          }
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
  }, [points, showLine, regions, pendingMarker, onPointPress, onRegionPress]);

  // Radar and timezone bands live on their own persistent layers (not the
  // layerGroup above, which gets torn down and rebuilt on every points/
  // regions change) so toggling them doesn't refetch tiles or redraw bands
  // every time something else on the map updates.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(async (L) => {
      const map = mapInstance.current;
      if (!map) return;
      if (showRadar) {
        if (!radarLayerRef.current) {
          const template = await getRadarTileTemplate();
          if (cancelled || !template || !map) return;
          // RainViewer's radar tiles only actually exist up to zoom 7 —
          // past that it serves a "Zoom Level Not Supported" placeholder
          // image instead of a 404, which without maxNativeZoom shows up as
          // literal text on the map and a ragged patchwork where some tiles
          // load and others don't. This tells Leaflet to stop requesting
          // past zoom 7 and upscale that tile instead.
          radarLayerRef.current = L.tileLayer(template, { opacity: 0.6, maxNativeZoom: 7 }).addTo(map);
        }
      } else if (radarLayerRef.current) {
        map.removeLayer(radarLayerRef.current);
        radarLayerRef.current = null;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [showRadar]);

  useEffect(() => {
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      if (!map) return;
      if (showTimezoneBands) {
        if (!tzLayerRef.current) {
          const group = L.layerGroup();
          for (const band of getTimezoneBands()) {
            L.polyline(
              [
                [-85, band.westLon],
                [85, band.westLon],
              ],
              { color: "#888", weight: 1, dashArray: "4 4" }
            ).addTo(group);
            L.marker([0, band.centerLon], {
              icon: L.divIcon({
                html: `<div style="font-size:11px;color:#555;background:rgba(255,255,255,0.85);padding:0 4px;border-radius:4px;white-space:nowrap;transform:translate(-50%,-50%)">${formatOffset(band.offset)}</div>`,
                className: "",
                iconSize: [0, 0],
              }),
            }).addTo(group);
          }
          tzLayerRef.current = group.addTo(map);
        }
      } else if (tzLayerRef.current) {
        map.removeLayer(tzLayerRef.current);
        tzLayerRef.current = null;
      }
    });
  }, [showTimezoneBands]);

  return <div ref={containerRef} style={{ flex: 1, width: "100%", height: "100%" }} />;
}
