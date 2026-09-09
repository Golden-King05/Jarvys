import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapCanvas from "./MapCanvas";
import PointDetailModal from "./PointDetailModal";
import RegionDetailModal from "./RegionDetailModal";
import RegionLegend from "./RegionLegend";
import { api, type MapData, type MapPoint, type RegionMapData } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";

interface InlineMapCardProps {
  mapData: MapData;
  onVerifyMap?: () => void;
}

// The map "insert" that shows up under an assistant reply when a tool
// plotted something — collapsible so a long chat doesn't turn into a wall
// of little maps.
export default function InlineMapCard({ mapData, onVerifyMap }: InlineMapCardProps) {
  const { baseUrl, token } = useAuth();
  const [expanded, setExpanded] = useState(true);
  const [selectedPoint, setSelectedPoint] = useState<MapPoint | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionMapData | null>(null);
  const [addState, setAddState] = useState<"idle" | "adding" | "added" | "dismissed">("idle");
  const [addError, setAddError] = useState<string | null>(null);

  const hasStatusLegend = mapData.kind === "regions" && (mapData.regions?.some((r) => r.status) ?? false);
  const suggestion = mapData.kind === "point_suggestion" ? mapData.points[0] : undefined;

  async function addSuggestion() {
    if (!suggestion || !token) return;
    setAddState("adding");
    setAddError(null);
    try {
      await api.createPoint(baseUrl, token, {
        name: suggestion.label,
        category: suggestion.category,
        subcategory: suggestion.subcategory,
        icon: suggestion.icon,
        lat: suggestion.lat,
        lon: suggestion.lon,
        blurb: suggestion.blurb,
        urls: suggestion.urls,
      });
      setAddState("added");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add point");
      setAddState("idle");
    }
  }

  let summary: string;
  if (mapData.kind === "distance" && mapData.distanceMiles != null) {
    summary = `${mapData.points[0]?.label} → ${mapData.points[1]?.label}: ${mapData.distanceMiles} mi`;
  } else if (mapData.kind === "regions" && mapData.regions) {
    const highlighted = hasStatusLegend
      ? mapData.regions.filter((r) => r.status && r.status !== "red").length
      : mapData.regions.length;
    summary = hasStatusLegend
      ? `${highlighted} region${highlighted === 1 ? "" : "s"} allowed or restricted`
      : `${mapData.regions.length} region${mapData.regions.length === 1 ? "" : "s"} highlighted`;
  } else if (mapData.kind === "point_suggestion") {
    summary = `New point: ${suggestion?.label ?? "Untitled"}`;
  } else if (mapData.kind === "landmark") {
    summary = mapData.points[0]?.label ?? "Location found";
  } else {
    summary = `${mapData.points.length} place${mapData.points.length === 1 ? "" : "s"} found`;
  }

  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.header} onPress={() => setExpanded((e) => !e)}>
        <Text style={styles.summary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={styles.toggle}>{expanded ? "Minimize" : "Expand"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <>
          {hasStatusLegend ? <RegionLegend /> : null}
          <View style={styles.mapBox}>
            <MapCanvas
              points={mapData.points}
              showLine={mapData.kind === "distance"}
              regions={mapData.kind === "regions" ? mapData.regions : undefined}
              onPointPress={setSelectedPoint}
              onRegionPress={setSelectedRegion}
            />
          </View>
          {mapData.kind === "regions" && onVerifyMap ? (
            mapData.verified ? (
              <Text style={styles.verifiedLabel}>✓ Verified state-by-state</Text>
            ) : (
              <TouchableOpacity style={styles.verifyButton} onPress={onVerifyMap}>
                <Text style={styles.verifyButtonText}>Verify Map</Text>
              </TouchableOpacity>
            )
          ) : null}
          {suggestion && addState === "idle" ? (
            <View style={styles.suggestionRow}>
              <Text style={styles.suggestionText}>Add this to your map?</Text>
              <View style={styles.suggestionButtons}>
                <TouchableOpacity onPress={() => setAddState("dismissed")}>
                  <Text style={styles.suggestionDismiss}>No thanks</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.suggestionAddButton} onPress={addSuggestion}>
                  <Text style={styles.suggestionAddButtonText}>Add to map</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
          {addState === "adding" ? <ActivityIndicator style={styles.spacing} /> : null}
          {addState === "added" ? <Text style={styles.verifiedLabel}>✓ Added to your map</Text> : null}
          {addError ? <Text style={styles.suggestionError}>{addError}</Text> : null}
        </>
      ) : null}
      <PointDetailModal point={selectedPoint} onClose={() => setSelectedPoint(null)} />
      <RegionDetailModal region={selectedRegion} onClose={() => setSelectedRegion(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginVertical: 6, borderWidth: 1, borderColor: "#eee", borderRadius: 10, overflow: "hidden" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 8,
    backgroundColor: "#f7f7f7",
  },
  summary: { fontFamily: fonts.medium, fontSize: 12, color: "#333", flex: 1, marginRight: 8 },
  toggle: { fontFamily: fonts.medium, fontSize: 11, color: "#2980b9" },
  mapBox: { height: 160 },
  verifyButton: { alignSelf: "center", paddingVertical: 8 },
  verifyButtonText: { fontFamily: fonts.medium, fontSize: 12, color: "#2980b9" },
  verifiedLabel: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: "#27ae60",
    textAlign: "center",
    paddingVertical: 8,
  },
  suggestionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  suggestionText: { fontFamily: fonts.medium, fontSize: 12, color: "#444", flex: 1, marginRight: 8 },
  suggestionButtons: { flexDirection: "row", alignItems: "center", gap: 14 },
  suggestionDismiss: { fontFamily: fonts.medium, fontSize: 12, color: "#888" },
  suggestionAddButton: { backgroundColor: "#2980b9", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  suggestionAddButtonText: { fontFamily: fonts.medium, fontSize: 12, color: "#fff" },
  suggestionError: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: "#c0392b",
    textAlign: "center",
    paddingBottom: 8,
  },
  spacing: { paddingVertical: 8 },
});
