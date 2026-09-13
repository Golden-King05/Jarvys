import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polygon, Polyline, PROVIDER_DEFAULT, UrlTile } from "react-native-maps";
import { api, type MapPoint, type RegionMapData, type WikipediaCluster } from "../api";
import { useAuth } from "../AuthContext";
import { outerRings } from "../utils/geojson";
import { inferOsmCategory, osmElementKey, suggestOsmIcon, type OsmCluster } from "../utils/osm";
import { getRadarTileTemplate } from "../utils/radar";
import { USGS_LIDAR_TILE_URL } from "../utils/lidar";
import type { BaseLayerKind } from "../utils/baseLayer";
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
  // Shows USGS's shaded-relief basemap (built from 3DEP lidar/DEM data) as
  // an overlay — a static tile URL, unlike radar's per-frame template, so
  // no state/fetch is needed to turn it on.
  showLidar?: boolean;
  // 0-1, how opaque that overlay is — defaults to 0.7.
  lidarOpacity?: number;
  // Accepted for prop-shape parity with the web canvas (MapScreen passes
  // the same props to whichever platform file the bundler resolves) but
  // unused here — react-native-maps' UrlTile has no filter/contrast hook.
  lidarContrast?: number;
  // "map" (the native map's own standard style, the default) or
  // "satellite" — react-native-maps' own mapType, backed by Apple/Google's
  // imagery directly rather than a custom tile overlay like the web
  // canvas's Esri layer.
  baseLayer?: BaseLayerKind;
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
  // Shows raw OpenStreetMap data fetched on demand (the Layers panel's
  // "Query" button, via a ref call) rather than saved points — the caller
  // owns the fetched elements (clustered) so an import can remove just that
  // one element afterward, unlike the self-polling flights/Wikipedia layers.
  showOsm?: boolean;
  osmClusters?: OsmCluster[];
  onOsmClusterPress?: (cluster: OsmCluster) => void;
  // Shows the user's live position (a native blue dot via react-native-maps,
  // backed by Apple/Google's own location layer) — the caller is
  // responsible for having already secured permission before turning this
  // on, same as every other permission-gated feature in this app.
  showLiveLocation?: boolean;
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
  // Center and zoom in on exactly this point, independent of whatever else
  // is on the map — a search-bar result, say. Deliberately separate from
  // focusKey/fitToContent, which fits every current point (including any
  // saved pins scattered elsewhere) rather than zooming to one specific
  // place; a new object reference (even for the same coordinates searched
  // twice) is what re-triggers the pan.
  flyTo?: { lat: number; lon: number } | null;
  // Whether to auto-fit the camera the first time points/regions show up at
  // all, with no explicit focusKey needed — on by default, which is exactly
  // right for the chat's inline map card (a fresh instance per message,
  // whose points never change afterward, so "the first time" and "an edit
  // happened" can never be confused). The Map screen's persistent instance
  // passes false: there, "points went from empty to non-empty" also
  // describes what a normal add/edit's own refetch looks like, so relying on
  // that shape to guess "is this the first load" caused a save to
  // occasionally get mistaken for it and snap the camera back to fit every
  // saved point — that screen instead fires an explicit focusKey bump itself,
  // exactly once, right after its own first successful load.
  autoFitOnFirstLoad?: boolean;
}

// Exposed via ref so the screen's "Query" button can ask for the current
// viewport on demand — the OSM layer is fetched on request, not polled, so
// there's no reason for MapCanvas to own that fetch itself the way it does
// for flights/Wikipedia.
export interface MapCanvasHandle {
  getViewportBounds: () => Promise<LatLonBox | null>;
}

const DEFAULT_REGION = {
  latitude: 39.8283,
  longitude: -98.5795,
  latitudeDelta: 30,
  longitudeDelta: 30,
};

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// react-native-maps reports the camera as a lat/lon delta, not a zoom level
// — this is the standard web-mercator conversion (delta 360 = the whole
// world = zoom 0), close enough to Leaflet's zoom scale to compare against
// the same minPinZoom value on both platforms.
function zoomFromLongitudeDelta(delta: number): number {
  return Math.log2(360 / delta);
}

// Native map (iOS/Android) — react-native-maps defaults to Apple Maps on
// iOS via PROVIDER_DEFAULT, so no API key is needed there.
const MapCanvas = React.forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  {
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
    showLidar,
    lidarOpacity = 0.7,
    baseLayer = "map",
    showPins = true,
    showFlights,
    showWikipedia,
    onWikipediaClusterPress,
    showOsm,
    osmClusters = [],
    onOsmClusterPress,
    showLiveLocation,
    minPinZoom,
    focusKey,
    flyTo,
    autoFitOnFirstLoad = true,
  }: MapCanvasProps,
  ref
) {
  const { baseUrl, token } = useAuth();
  const mapRef = useRef<MapView>(null);
  const hasFitInitially = useRef(false);
  const [radarTemplate, setRadarTemplate] = useState<string | null>(null);
  const [flightPoints, setFlightPoints] = useState<MapPoint[]>([]);
  const [wikiClusters, setWikiClusters] = useState<WikipediaCluster[]>([]);
  const lastWikiFetchBox = useRef<LatLonBox | null>(null);
  const [currentZoom, setCurrentZoom] = useState(() =>
    zoomFromLongitudeDelta(initialRegion ? 0.1 : DEFAULT_REGION.longitudeDelta)
  );
  const shouldShowPins = showPins && (minPinZoom === undefined || currentZoom >= minPinZoom);
  // A derived boolean rather than raw currentZoom in the poll effect below —
  // currentZoom changes on every completed pinch/drag, and using the float
  // directly as a dependency meant the effect tore down and rebuilt (firing
  // an immediate re-fetch, plus a native getMapBoundaries() bridge call)
  // on every single one of those, not just when crossing the zoom-12 line.
  // A user pinch-zooming right around that boundary could fire a burst of
  // overlapping fetches and bridge calls in quick succession.
  const wikiZoomedIn = currentZoom >= MIN_WIKI_ZOOM;

  useEffect(() => {
    if (!showRadar) {
      setRadarTemplate(null);
      return;
    }
    let cancelled = false;
    getRadarTileTemplate().then((template) => {
      if (!cancelled) setRadarTemplate(template);
    });
    return () => {
      cancelled = true;
    };
  }, [showRadar]);

  useEffect(() => {
    if (!showFlights || !token) {
      setFlightPoints([]);
      return;
    }
    let cancelled = false;
    async function poll() {
      const bounds = await mapRef.current?.getMapBoundaries();
      if (!bounds || cancelled || !token) return;
      try {
        const { points: flights } = await api.getFlights(baseUrl, token, {
          south: bounds.southWest.latitude,
          west: bounds.southWest.longitude,
          north: bounds.northEast.latitude,
          east: bounds.northEast.longitude,
        });
        if (!cancelled) setFlightPoints(flights);
      } catch {
        // A failed poll just leaves the last-known flights on screen.
      }
    }
    poll();
    const interval = setInterval(poll, FLIGHTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showFlights, baseUrl, token]);

  useEffect(() => {
    if (!showWikipedia || !token || !wikiZoomedIn) {
      setWikiClusters([]);
      lastWikiFetchBox.current = null;
      return;
    }
    let cancelled = false;
    async function poll() {
      const bounds = await mapRef.current?.getMapBoundaries();
      if (!bounds || cancelled || !token) return;
      const viewport: LatLonBox = {
        south: bounds.southWest.latitude,
        west: bounds.southWest.longitude,
        north: bounds.northEast.latitude,
        east: bounds.northEast.longitude,
      };
      // The article set doesn't change on its own — skip the round trip
      // if the last fetch already covers where we're looking now.
      if (lastWikiFetchBox.current && boxContains(lastWikiFetchBox.current, viewport)) return;
      const fetchBox = padBox(viewport, 0.5);
      try {
        const { clusters } = await api.getNearbyWikipedia(baseUrl, token, fetchBox);
        if (!cancelled) {
          setWikiClusters(clusters);
          lastWikiFetchBox.current = fetchBox;
        }
      } catch {
        // A failed poll just leaves the last-known clusters on screen.
      }
    }
    poll();
    const interval = setInterval(poll, WIKI_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showWikipedia, baseUrl, token, wikiZoomedIn]);

  function fitToContent() {
    if (!mapRef.current) return;
    if (points.length > 1) {
      mapRef.current.fitToCoordinates(
        points.map((p) => ({ latitude: p.lat, longitude: p.lon })),
        { edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true }
      );
    } else if (points.length === 1) {
      mapRef.current.animateToRegion(
        { latitude: points[0].lat, longitude: points[0].lon, latitudeDelta: 0.05, longitudeDelta: 0.05 },
        500
      );
    } else if (regions && regions.length > 0) {
      const coordinates = regions
        .flatMap((r) => outerRings(r.geometry))
        .flat()
        .map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
      if (coordinates.length > 0) {
        mapRef.current.fitToCoordinates(coordinates, {
          edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
          animated: true,
        });
      }
    }
  }

  // Fits once, the first time there's anything to show — not on every
  // subsequent points/regions change, since refreshing the same points
  // after a tap, an edit, or a drag looks identical to "new content
  // arrived" from the array alone. Only for callers that want that guess
  // (see autoFitOnFirstLoad above); the Map screen instead fires an
  // explicit focusKey bump once it knows for certain this really is its
  // first load. A deliberate re-fit (e.g. a brand new search result) goes
  // through the focusKey effect below either way.
  useEffect(() => {
    if (!autoFitOnFirstLoad) return;
    if (!hasFitInitially.current && (points.length > 0 || (regions && regions.length > 0))) {
      fitToContent();
      hasFitInitially.current = true;
    }
  }, [autoFitOnFirstLoad, points, regions]);

  useEffect(() => {
    if (focusKey !== undefined) fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  useEffect(() => {
    if (!flyTo || !mapRef.current) return;
    mapRef.current.animateToRegion(
      { latitude: flyTo.lat, longitude: flyTo.lon, latitudeDelta: 0.05, longitudeDelta: 0.05 },
      500
    );
  }, [flyTo]);

  useImperativeHandle(ref, () => ({
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
  }));

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      mapType={baseLayer === "satellite" ? "satellite" : "standard"}
      initialRegion={
        initialRegion
          ? { ...initialRegion, latitudeDelta: 0.1, longitudeDelta: 0.1 }
          : DEFAULT_REGION
      }
      onPress={(e) => onMapPress?.(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
      onRegionChangeComplete={(region) => setCurrentZoom(zoomFromLongitudeDelta(region.longitudeDelta))}
      showsUserLocation={showLiveLocation}
      showsMyLocationButton={showLiveLocation}
    >
      {showLidar ? (
        // Unlike the old pre-cached tile source (which had nothing past
        // zoom 13 and needed that stretched/hidden past it), our own server
        // renders each tile from the DEM on request, so every zoom level
        // gets a genuine render — no native-zoom ceiling needed.
        <UrlTile urlTemplate={USGS_LIDAR_TILE_URL} zIndex={0} opacity={lidarOpacity} />
      ) : null}

      {radarTemplate ? (
        // RainViewer's radar tiles only actually exist up to zoom 7 — past
        // that it serves a "Zoom Level Not Supported" placeholder image
        // instead of a 404, which without this shows up as literal text on
        // the map and a ragged patchwork where some tiles load and others
        // don't. maximumNativeZ tells the map to stop asking past zoom 7
        // and upscale that tile instead (blurrier, but no placeholder text
        // or clipping).
        <UrlTile urlTemplate={radarTemplate} zIndex={1} maximumNativeZ={7} />
      ) : null}

      {showTimezoneBands
        ? getTimezoneBands().map((band) => (
            <React.Fragment key={band.offset}>
              <Polyline
                coordinates={[
                  { latitude: -85, longitude: band.westLon },
                  { latitude: 85, longitude: band.westLon },
                ]}
                strokeColor="rgba(120,120,120,0.5)"
                strokeWidth={1}
              />
              <Marker coordinate={{ latitude: 0, longitude: band.centerLon }} tracksViewChanges={false}>
                <Text style={styles.tzLabel}>{formatOffset(band.offset)}</Text>
              </Marker>
            </React.Fragment>
          ))
        : null}

      {regions?.flatMap((region, ri) => {
        const color = statusColor(region.status);
        return outerRings(region.geometry).map((ring, i) => (
          <Polygon
            key={`region-${ri}-${i}`}
            coordinates={ring.map(([lon, lat]) => ({ latitude: lat, longitude: lon }))}
            fillColor={withAlpha(color, 0.35)}
            strokeColor={color}
            strokeWidth={1.5}
            tappable
            onPress={() => onRegionPress?.(region)}
          />
        ));
      })}

      {shouldShowPins
        ? points.map((p, i) => (
            <Marker
              key={i}
              coordinate={{ latitude: p.lat, longitude: p.lon }}
              onPress={() => onPointPress?.(p)}
              tracksViewChanges={false}
              // Only a point backed by a saved Point (has an id) has somewhere
              // to persist a drag to — an ephemeral result like a distance
              // endpoint just isn't draggable.
              draggable={Boolean(p.id)}
              onDragEnd={(e) =>
                onPointDragEnd?.(p, e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)
              }
            >
              <View style={styles.markerBubble}>
                <Text style={styles.markerEmoji}>{p.icon ?? "📍"}</Text>
              </View>
            </Marker>
          ))
        : null}

      {showFlights
        ? flightPoints.map((p, i) => (
            <Marker
              key={`flight-${i}`}
              coordinate={{ latitude: p.lat, longitude: p.lon }}
              onPress={() => onPointPress?.(p)}
              tracksViewChanges={false}
            >
              <View style={styles.markerBubble}>
                <Text style={styles.markerEmoji}>{p.icon ?? "✈️"}</Text>
              </View>
            </Marker>
          ))
        : null}

      {showWikipedia
        ? wikiClusters.map((c, i) => (
            <Marker
              key={`wiki-${c.articles[0]?.pageid ?? i}`}
              coordinate={{ latitude: c.lat, longitude: c.lon }}
              onPress={() => onWikipediaClusterPress?.(c)}
              tracksViewChanges={false}
            >
              <View style={styles.markerBubble}>
                <Text style={styles.markerEmoji}>📖</Text>
                {c.articles.length > 1 ? (
                  <View style={styles.markerBadge}>
                    <Text style={styles.markerBadgeText}>{c.articles.length}</Text>
                  </View>
                ) : null}
              </View>
            </Marker>
          ))
        : null}

      {showOsm
        ? osmClusters.map((c) => (
            <Marker
              key={`osm-${osmElementKey(c.elements[0])}`}
              coordinate={{ latitude: c.lat, longitude: c.lon }}
              onPress={() => onOsmClusterPress?.(c)}
              tracksViewChanges={false}
            >
              <View style={styles.markerBubble}>
                <Text style={styles.markerEmoji}>{iconForOsmCluster(c)}</Text>
                {c.elements.length > 1 ? (
                  <View style={styles.markerBadge}>
                    <Text style={styles.markerBadgeText}>{c.elements.length}</Text>
                  </View>
                ) : null}
              </View>
            </Marker>
          ))
        : null}

      {pendingMarker ? (
        <Marker coordinate={{ latitude: pendingMarker.lat, longitude: pendingMarker.lon }} pinColor="#e67e22" />
      ) : null}

      {showLine && points.length === 2 ? (
        <Polyline
          coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lon }))}
          strokeColor="#2980b9"
          strokeWidth={3}
        />
      ) : null}
    </MapView>
  );
});

export default MapCanvas;

// A single-element cluster gets its inferred category's icon (matching what
// the import form would default to); an untagged/mixed cluster falls back
// to a generic pin rather than guessing from whichever element sorted first.
function iconForOsmCluster(cluster: OsmCluster): string {
  if (cluster.elements.length === 1) {
    const { category, subcategory } = inferOsmCategory(cluster.elements[0].tags);
    return suggestOsmIcon(category, subcategory) ?? "📍";
  }
  return "📍";
}

const styles = StyleSheet.create({
  markerBubble: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 4,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  markerEmoji: { fontSize: 18 },
  markerBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#2980b9",
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    justifyContent: "center",
    alignItems: "center",
  },
  markerBadgeText: { color: "#fff", fontSize: 10, fontWeight: "600" },
  tzLabel: {
    fontSize: 11,
    color: "#555",
    backgroundColor: "rgba(255,255,255,0.85)",
    paddingHorizontal: 4,
    borderRadius: 4,
  },
});
