import React, { useEffect, useRef, useState } from "react";
import { api, type MapPoint, type RegionMapData, type WikipediaCluster } from "../api";
import { useAuth } from "../AuthContext";
import { getRadarTileTemplate } from "../utils/radar";
import { statusColor } from "../utils/regionStatus";
import { formatOffset, getTimezoneBands } from "../utils/timezoneBands";
import { boxContains, padBox, type LatLonBox } from "../utils/geoBox";

// Anonymous OpenSky access is rate-limited — this keeps polling infrequent
// enough to stay well within it while still feeling roughly "live".
const FLIGHTS_POLL_MS = 20000;
// Wikipedia articles don't move like aircraft do — this just re-checks
// whether the viewport has wandered outside the last-fetched area, so it
// can be much less frequent than the flights poll above.
const WIKI_POLL_MS = 8000;
// findArticlesInArea tiles the requested area into at most 12 geosearch
// calls, each covering only a 10km radius around its own tile center — fine
// for a city-sized viewport, but at a zoomed-out (state/country-sized) view
// those 12 tiles land tens or hundreds of km apart, so nearly all of them
// miss every article and the few results that do turn up (from whichever
// lone tile happened to land near a town) look like they're all bunched in
// one spot instead of spread across the map. Below this zoom the layer
// shows nothing rather than that misleading result, the same way saved pins
// stay hidden until zoomed in.
const MIN_WIKI_ZOOM = 12;

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
  onPointDragEnd?: (point: MapPoint, lat: number, lon: number) => void;
  pendingMarker?: { lat: number; lon: number } | null;
  showRadar?: boolean;
  showTimezoneBands?: boolean;
  // Hides the saved-point markers entirely (the Layers panel's "Saved pins"
  // switch) — defaults to shown.
  showPins?: boolean;
  // Shows a live-updating layer of nearby aircraft (via the server's
  // /flights proxy to OpenSky), polled on an interval while on.
  showFlights?: boolean;
  // Shows nearby geotagged Wikipedia articles as browsable pins, clustered
  // by proximity — refetched as the viewport moves outside its last-loaded
  // area.
  showWikipedia?: boolean;
  onWikipediaClusterPress?: (cluster: WikipediaCluster) => void;
  // Below this zoom level, point markers are hidden regardless of showPins —
  // a large saved collection is unreadable as a wall of overlapping emoji
  // once zoomed out to a whole state or country, so pins only appear once
  // zoomed in close enough to tell them apart. Undefined (the default, used
  // by the small inline map card in chat) means no such limit — a freshly
  // found result should always be visible right away.
  minPinZoom?: number;
  // Bump this (e.g. a counter) when the camera should re-fit to the current
  // points/regions — a brand new AI result arriving, say. Without an
  // explicit signal like this, the map would have to guess "did the point
  // set meaningfully change" from the array reference alone, and refreshing
  // the same points after an edit or a drag looks identical to that check,
  // which is what caused re-zooming out on every interaction.
  focusKey?: number;
}

const DEFAULT_CENTER: [number, number] = [39.8283, -98.5795];

function emojiIcon(L: Leaflet, icon: string) {
  return L.divIcon({
    html: `<div style="font-size:22px;line-height:1;transform:translate(-50%,-50%)">${icon}</div>`,
    className: "",
    iconSize: [0, 0],
  });
}

function emojiIconWithBadge(L: Leaflet, icon: string, count: number) {
  const badge =
    count > 1
      ? `<div style="position:absolute;top:-4px;right:-4px;background:#2980b9;color:#fff;border-radius:8px;min-width:16px;height:16px;padding:0 3px;font-size:10px;font-weight:600;line-height:16px;text-align:center">${count}</div>`
      : "";
  return L.divIcon({
    html: `<div style="position:relative;font-size:22px;line-height:1;transform:translate(-50%,-50%)">${icon}${badge}</div>`,
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
  onPointDragEnd,
  pendingMarker,
  showRadar,
  showTimezoneBands,
  showPins = true,
  showFlights,
  showWikipedia,
  onWikipediaClusterPress,
  minPinZoom,
  focusKey,
}: MapCanvasProps) {
  const { baseUrl, token } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Leaflet>(null);
  const layerGroup = useRef<Leaflet>(null);
  const radarLayerRef = useRef<Leaflet>(null);
  const tzLayerRef = useRef<Leaflet>(null);
  const flightsLayerRef = useRef<Leaflet>(null);
  const wikiLayerRef = useRef<Leaflet>(null);
  const lastWikiFetchBox = useRef<LatLonBox | null>(null);
  const hasFitInitially = useRef(false);
  const onMapPressRef = useRef(onMapPress);
  onMapPressRef.current = onMapPress;
  const onPointPressRef = useRef(onPointPress);
  onPointPressRef.current = onPointPress;
  const onWikipediaClusterPressRef = useRef(onWikipediaClusterPress);
  onWikipediaClusterPressRef.current = onWikipediaClusterPress;
  const [currentZoom, setCurrentZoom] = useState(initialRegion ? 12 : 4);
  const shouldShowPins = showPins && (minPinZoom === undefined || currentZoom >= minPinZoom);
  // A derived boolean rather than raw currentZoom in the poll effect below —
  // using the float directly as a dependency meant the effect tore down and
  // rebuilt (firing an immediate re-fetch) on every zoomend, not just when
  // crossing the zoom-12 line.
  const wikiZoomedIn = currentZoom >= MIN_WIKI_ZOOM;

  function fitToContent(L: Leaflet, map: Leaflet) {
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 13);
    } else if (points.length > 1) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
      map.fitBounds(bounds, { padding: [60, 60] });
    } else if (regions && regions.length > 0) {
      const bounds = L.geoJSON({
        type: "FeatureCollection",
        features: regions.map((r) => ({ type: "Feature", properties: {}, geometry: r.geometry })),
      }).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapInstance.current) return;
      const center = initialRegion ? [initialRegion.latitude, initialRegion.longitude] : DEFAULT_CENTER;
      const map = L.map(containerRef.current).setView(center, initialRegion ? 12 : 4);
      const baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      // A tile that fails to load (a transient network blip, a momentarily
      // overloaded OSM server) otherwise just stays blank forever on a small
      // preview card the user never pans — nothing else would ever re-request
      // it. A couple of delayed retries usually recovers it.
      const tileRetries = new WeakMap<object, number>();
      baseLayer.on("tileerror", (e: { tile: HTMLImageElement; coords: object }) => {
        const attempt = tileRetries.get(e.coords) ?? 0;
        if (attempt >= 3) return;
        tileRetries.set(e.coords, attempt + 1);
        const src = e.tile.src;
        setTimeout(() => {
          e.tile.src = "";
          e.tile.src = src;
        }, 1500 * (attempt + 1));
      });
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        onMapPressRef.current?.(e.latlng.lat, e.latlng.lng);
      });
      map.on("zoomend", () => setCurrentZoom(map.getZoom()));
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

      if (shouldShowPins) {
        points.forEach((p: MapPoint) => {
          // Only a point backed by a saved Point (has an id) has somewhere to
          // persist a drag to — an ephemeral result like a distance endpoint
          // just isn't draggable.
          const marker = L.marker([p.lat, p.lon], { icon: emojiIcon(L, p.icon ?? "📍"), draggable: Boolean(p.id) })
            .addTo(layer)
            .bindPopup(p.address ? `${p.label}<br>${p.address}` : p.label)
            .on("click", () => onPointPress?.(p));
          if (p.id) {
            marker.on("dragend", () => {
              const { lat, lng } = marker.getLatLng();
              onPointDragEnd?.(p, lat, lng);
            });
          }
        });
      }

      if (pendingMarker) {
        L.marker([pendingMarker.lat, pendingMarker.lon], { icon: emojiIcon(L, "📌") }).addTo(layer);
      }

      if (showLine && points.length === 2) {
        L.polyline(
          points.map((p) => [p.lat, p.lon]),
          { color: "#2980b9", weight: 3 }
        ).addTo(layer);
      }
    });
  }, [points, showLine, regions, pendingMarker, onPointPress, onRegionPress, onPointDragEnd, shouldShowPins]);

  // Fits once, the first time there's anything to show — not on every
  // subsequent points/regions change, since refreshing the same points
  // after a tap, an edit, or a drag looks identical to "new content
  // arrived" from the array alone. A deliberate re-fit (e.g. a brand new
  // search result) goes through the focusKey effect below instead.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      if (cancelled || !map) return;
      if (!hasFitInitially.current && (points.length > 0 || (regions && regions.length > 0))) {
        fitToContent(L, map);
        hasFitInitially.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, regions]);

  useEffect(() => {
    if (focusKey === undefined) return;
    let cancelled = false;
    loadLeaflet().then((L) => {
      const map = mapInstance.current;
      if (!cancelled && map) fitToContent(L, map);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

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

  // Own persistent layer, same reasoning as radar/timezones above — polling
  // redraws just this layer without touching points/regions.
  useEffect(() => {
    if (!showFlights || !token) {
      loadLeaflet().then((L) => {
        const map = mapInstance.current;
        if (map && flightsLayerRef.current) {
          map.removeLayer(flightsLayerRef.current);
          flightsLayerRef.current = null;
        }
      });
      return;
    }
    let cancelled = false;
    async function poll() {
      const L = await loadLeaflet();
      const map = mapInstance.current;
      if (cancelled || !map || !token) return;
      const bounds = map.getBounds();
      let flights: MapPoint[];
      try {
        const response = await api.getFlights(baseUrl, token, {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        });
        flights = response.points;
      } catch {
        return; // A failed poll just leaves the last-known flights on screen.
      }
      if (cancelled) return;
      if (!flightsLayerRef.current) flightsLayerRef.current = L.layerGroup().addTo(map);
      flightsLayerRef.current.clearLayers();
      flights.forEach((p) => {
        L.marker([p.lat, p.lon], { icon: emojiIcon(L, p.icon ?? "✈️") })
          .addTo(flightsLayerRef.current)
          .on("click", () => onPointPressRef.current?.(p));
      });
    }
    poll();
    const interval = setInterval(poll, FLIGHTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showFlights, baseUrl, token]);

  // Own persistent layer, same reasoning as radar/timezones above — polling
  // redraws just this layer without touching points/regions.
  useEffect(() => {
    if (!showWikipedia || !token || !wikiZoomedIn) {
      loadLeaflet().then((L) => {
        const map = mapInstance.current;
        if (map && wikiLayerRef.current) {
          map.removeLayer(wikiLayerRef.current);
          wikiLayerRef.current = null;
        }
      });
      lastWikiFetchBox.current = null;
      return;
    }
    let cancelled = false;
    async function poll() {
      const L = await loadLeaflet();
      const map = mapInstance.current;
      if (cancelled || !map || !token) return;
      const bounds = map.getBounds();
      const viewport: LatLonBox = {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      };
      // The article set doesn't change on its own — skip the round trip if
      // the last fetch already covers where we're looking now.
      if (lastWikiFetchBox.current && boxContains(lastWikiFetchBox.current, viewport)) return;
      const fetchBox = padBox(viewport, 0.5);
      let clusters: WikipediaCluster[];
      try {
        const response = await api.getNearbyWikipedia(baseUrl, token, fetchBox);
        clusters = response.clusters;
      } catch {
        return; // A failed poll just leaves the last-known clusters on screen.
      }
      if (cancelled) return;
      lastWikiFetchBox.current = fetchBox;
      if (!wikiLayerRef.current) wikiLayerRef.current = L.layerGroup().addTo(map);
      wikiLayerRef.current.clearLayers();
      clusters.forEach((c) => {
        L.marker([c.lat, c.lon], { icon: emojiIconWithBadge(L, "📖", c.articles.length) })
          .addTo(wikiLayerRef.current)
          .on("click", () => onWikipediaClusterPressRef.current?.(c));
      });
    }
    poll();
    const interval = setInterval(poll, WIKI_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showWikipedia, baseUrl, token, wikiZoomedIn]);

  return <div ref={containerRef} style={{ flex: 1, width: "100%", height: "100%" }} />;
}
