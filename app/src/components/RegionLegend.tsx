import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { statusColor, statusLabel } from "../utils/regionStatus";
import { fonts } from "../theme";

// Shown next to a "regions" map that carries legality status, so
// green/yellow/red has an explanation right there instead of needing to
// tap every region to find out.
export default function RegionLegend() {
  return (
    <View style={styles.row}>
      {(["green", "yellow", "red"] as const).map((s) => (
        <View key={s} style={styles.item}>
          <View style={[styles.dot, { backgroundColor: statusColor(s) }]} />
          <Text style={styles.label}>{statusLabel(s)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
  item: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontFamily: fonts.regular, fontSize: 11, color: "#666" },
});
