import React, { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import type { MapPoint } from "../api";

interface MapCanvasProps {
  points: MapPoint[];
  showLine?: boolean;
  initialRegion?: { latitude: number; longitude: number };
}

const DEFAULT_REGION = {
  latitude: 39.8283,
  longitude: -98.5795,
  latitudeDelta: 30,
  longitudeDelta: 30,
};

// Native map (iOS/Android) — react-native-maps defaults to Apple Maps on
// iOS via PROVIDER_DEFAULT, so no API key is needed there.
export default function MapCanvas({ points, showLine, initialRegion }: MapCanvasProps) {
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
    }
  }, [points]);

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
    >
      {points.map((p, i) => (
        <Marker key={i} coordinate={{ latitude: p.lat, longitude: p.lon }} title={p.label} description={p.address} />
      ))}
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
