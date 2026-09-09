import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapCanvas from "./MapCanvas";
import PointDetailModal from "./PointDetailModal";
import type { MapData, MapPoint } from "../api";
import { fonts } from "../theme";

interface InlineMapCardProps {
  mapData: MapData;
}

// The map "insert" that shows up under an assistant reply when a tool
// plotted something — collapsible so a long chat doesn't turn into a wall
// of little maps.
export default function InlineMapCard({ mapData }: InlineMapCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState<MapPoint | null>(null);

  let summary: string;
  if (mapData.kind === "distance" && mapData.distanceMiles != null) {
    summary = `${mapData.points[0]?.label} → ${mapData.points[1]?.label}: ${mapData.distanceMiles} mi`;
  } else if (mapData.kind === "regions" && mapData.regions) {
    summary = `${mapData.regions.length} region${mapData.regions.length === 1 ? "" : "s"} highlighted`;
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
        <View style={styles.mapBox}>
          <MapCanvas
            points={mapData.points}
            showLine={mapData.kind === "distance"}
            regions={mapData.kind === "regions" ? mapData.regions : undefined}
            onPointPress={setSelected}
          />
        </View>
      ) : null}
      <PointDetailModal point={selected} onClose={() => setSelected(null)} />
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
});
