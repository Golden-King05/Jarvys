import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polygon, Polyline, PROVIDER_DEFAULT, UrlTile } from "react-native-maps";
import { api, type MapPoint, type RegionMapData } from "../api";
import { useAuth } from "../AuthContext";
import { outerRings } from "../utils/geojson";
import { getRadarTileTemplate } from "../utils/radar";
import { statusColor } from "../utils/regionStatus";
import { formatOffset, getTimezoneBands } from "../utils/timezoneBands";

// Anonymous OpenSky access is rate-limited — this keeps polling infrequent
// enough to stay well within it while still feeling roughly "live".
const FLIGHTS_POLL_MS = 20000;

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
  minPinZoom,
  focusKey,
}: MapCanvasProps) {
  const { baseUrl, token } = useAuth();
  const mapRef = useRef<MapView>(null);
  const hasFitInitially = useRef(false);
  const [radarTemplate, setRadarTemplate] = useState<string | null>(null);
  const [flightPoints, setFlightPoints] = useState<MapPoint[]>([]);
  const [currentZoom, setCurrentZoom] = useState(() =>
    zoomFromLongitudeDelta(initialRegion ? 0.1 : DEFAULT_REGION.longitudeDelta)
  );
  const shouldShowPins = showPins && (minPinZoom === undefined || currentZoom >= minPinZoom);

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
  // arrived" from the array alone. A deliberate re-fit (e.g. a brand new
  // search result) goes through the focusKey effect below instead.
  useEffect(() => {
    if (!hasFitInitially.current && (points.length > 0 || (regions && regions.length > 0))) {
      fitToContent();
      hasFitInitially.current = true;
    }
  }, [points, regions]);

  useEffect(() => {
    if (focusKey !== undefined) fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      initialRegion={
        initialRegion
          ? { ...initialRegion, latitudeDelta: 0.1, longitudeDelta: 0.1 }
          : DEFAULT_REGION
      }
      onPress={(e) => onMapPress?.(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
      onRegionChangeComplete={(region) => setCurrentZoom(zoomFromLongitudeDelta(region.longitudeDelta))}
    >
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
  tzLabel: {
    fontSize: 11,
    color: "#555",
    backgroundColor: "rgba(255,255,255,0.85)",
    paddingHorizontal: 4,
    borderRadius: 4,
  },
});
