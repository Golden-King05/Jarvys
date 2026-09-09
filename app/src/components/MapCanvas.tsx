import React, { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polygon, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import type { MapPoint, RegionMapData } from "../api";
import { outerRings } from "../utils/geojson";

interface MapCanvasProps {
  points: MapPoint[];
  showLine?: boolean;
  regions?: RegionMapData[];
  initialRegion?: { latitude: number; longitude: number };
  onMapPress?: (lat: number, lon: number) => void;
  onPointPress?: (point: MapPoint) => void;
  pendingMarker?: { lat: number; lon: number } | null;
}

const DEFAULT_REGION = {
  latitude: 39.8283,
  longitude: -98.5795,
  latitudeDelta: 30,
  longitudeDelta: 30,
};

// Native map (iOS/Android) — react-native-maps defaults to Apple Maps on
// iOS via PROVIDER_DEFAULT, so no API key is needed there.
export default function MapCanvas({
  points,
  showLine,
  regions,
  initialRegion,
  onMapPress,
  onPointPress,
  pendingMarker,
}: MapCanvasProps) {
  const mapRef = useRef<MapView>(null);

  useEffect(() => {
    if (points.length > 1 && mapRef.current) {
      mapRef.current.fitToCoordinates(
        points.map((p) => ({ latitude: p.lat, longitude: p.lon })),
        { edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true }
      );
    } else if (points.length === 1 && mapRef.current) {
      mapRef.current.animateToRegion(
        { latitude: points[0].lat, longitude: points[0].lon, latitudeDelta: 0.05, longitudeDelta: 0.05 },
        500
      );
    } else if (points.length === 0 && regions && regions.length > 0 && mapRef.current) {
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
  }, [points, regions]);

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
      {regions?.flatMap((region, ri) =>
        outerRings(region.geometry).map((ring, i) => (
          <Polygon
            key={`region-${ri}-${i}`}
            coordinates={ring.map(([lon, lat]) => ({ latitude: lat, longitude: lon }))}
            fillColor="rgba(41,128,185,0.25)"
            strokeColor="#2980b9"
            strokeWidth={2}
          />
        ))
      )}

      {points.map((p, i) => (
        <Marker
          key={i}
          coordinate={{ latitude: p.lat, longitude: p.lon }}
          onPress={() => onPointPress?.(p)}
          tracksViewChanges={false}
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
});
