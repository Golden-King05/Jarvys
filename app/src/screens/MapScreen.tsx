import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import MapCanvas from "../components/MapCanvas";
import type { MapData } from "../api";
import { fonts } from "../theme";

interface MapScreenProps {
  mapData: MapData | null;
}

export default function MapScreen({ mapData }: MapScreenProps) {
  const [initialRegion, setInitialRegion] = useState<{ latitude: number; longitude: number } | undefined>();

  useEffect(() => {
    if (mapData) return; // The AI's plotted points drive the view instead once there are any.
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const position = await Location.getCurrentPositionAsync({});
        setInitialRegion({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      } catch {
        // No location available — the map just falls back to its default view.
      }
    })();
  }, [mapData]);

  const points = mapData?.points ?? [];

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <MapCanvas points={points} showLine={mapData?.kind === "distance"} initialRegion={initialRegion} />
      </View>

      {mapData ? (
        <ScrollView style={styles.infoBox} contentContainerStyle={styles.infoContent}>
          {mapData.kind === "distance" && mapData.distanceMiles != null ? (
            <Text style={styles.infoTitle}>
              {mapData.points[0]?.label} to {mapData.points[1]?.label}: {mapData.distanceMiles.toLocaleString()} mi (
              {mapData.distanceKm?.toLocaleString()} km)
            </Text>
          ) : (
            <Text style={styles.infoTitle}>
              {mapData.points.length} place{mapData.points.length === 1 ? "" : "s"} found
            </Text>
          )}
          {mapData.kind === "places"
            ? mapData.points.map((p, i) => (
                <Text key={i} style={styles.infoItem}>
                  • {p.label}
                  {p.address ? ` — ${p.address}` : ""}
                </Text>
              ))
            : null}
        </ScrollView>
      ) : (
        <View style={styles.placeholderBox}>
          <Text style={styles.placeholderText}>
            Ask your assistant to find places or calculate a distance, and it'll show up here.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapWrap: { flex: 1 },
  infoBox: { maxHeight: 160, borderTopWidth: 1, borderTopColor: "#eee" },
  infoContent: { padding: 12 },
  infoTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: "#222", marginBottom: 6 },
  infoItem: { fontFamily: fonts.regular, fontSize: 13, color: "#444", marginBottom: 4 },
  placeholderBox: { padding: 20, borderTopWidth: 1, borderTopColor: "#eee" },
  placeholderText: { fontFamily: fonts.regular, fontSize: 13, color: "#888", textAlign: "center" },
});
