import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polygon, Polyline, PROVIDER_DEFAULT, UrlTile } from "react-native-maps";
import type { MapPoint, RegionMapData } from "../api";
import { outerRings } from "../utils/geojson";
import { getRadarTileTemplate } from "../utils/radar";
import { statusColor } from "../utils/regionStatus";
import { formatOffset, getTimezoneBands } from "../utils/timezoneBands";

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
  focusKey,
}: MapCanvasProps) {
  const mapRef = useRef<MapView>(null);
  const hasFitInitially = useRef(false);
  const [radarTemplate, setRadarTemplate] = useState<string | null>(null);

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

      {points.map((p, i) => (
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
      ))}

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
