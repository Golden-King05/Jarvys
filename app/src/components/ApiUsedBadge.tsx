import React, { useState } from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { describeToolsUsed } from "../utils/toolLabels";
import { fonts } from "../theme";

interface ApiUsedBadgeProps {
  toolsUsed: string[];
  // Tools that were called this turn but came back empty-handed — an
  // upstream API erroring, or a map lookup that found nothing. Rendered in
  // the same row with a distinct, muted-red style so a source that was
  // tried and failed reads differently from one that actually answered.
  toolsFailed: string[];
}

// A collapsed marker under a reply instead of having the model narrate its
// own sourcing in the text ("I checked Wikipedia and found...") — tap it to
// see which free APIs/data sources actually answered this message. Each
// badge is itself a link to that source's own "about" page, not just its
// homepage, so tapping "OpenStreetMap" explains what OpenStreetMap is
// rather than dropping you on the map-editing site.
export default function ApiUsedBadge({ toolsUsed, toolsFailed }: ApiUsedBadgeProps) {
  const [expanded, setExpanded] = useState(false);
  if (toolsUsed.length === 0 && toolsFailed.length === 0) return null;
  const usedItems = describeToolsUsed(toolsUsed);
  const failedItems = describeToolsUsed(toolsFailed);

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => setExpanded((e) => !e)}>
        <Text style={styles.toggle}>{expanded ? "Hide API used" : "API used"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.row}>
          {usedItems.map((item, i) =>
            item.url ? (
              <TouchableOpacity key={`used-${i}`} style={styles.badge} onPress={() => Linking.openURL(item.url)}>
                <Text style={styles.badgeText}>
                  {item.icon} {item.label}
                </Text>
              </TouchableOpacity>
            ) : (
              <View key={`used-${i}`} style={styles.badge}>
                <Text style={styles.badgeText}>
                  {item.icon} {item.label}
                </Text>
              </View>
            )
          )}
          {failedItems.map((item, i) =>
            item.url ? (
              <TouchableOpacity
                key={`failed-${i}`}
                style={[styles.badge, styles.badgeFailed]}
                onPress={() => Linking.openURL(item.url)}
              >
                <Text style={[styles.badgeText, styles.badgeTextFailed]}>
                  {item.icon} {item.label} (failed)
                </Text>
              </TouchableOpacity>
            ) : (
              <View key={`failed-${i}`} style={[styles.badge, styles.badgeFailed]}>
                <Text style={[styles.badgeText, styles.badgeTextFailed]}>
                  {item.icon} {item.label} (failed)
                </Text>
              </View>
            )
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 2, marginBottom: 6 },
  toggle: { fontFamily: fonts.medium, fontSize: 10, color: "#999" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  badge: { backgroundColor: "#f0f0f0", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontFamily: fonts.regular, fontSize: 11, color: "#2980b9" },
  badgeFailed: { backgroundColor: "#fdecea" },
  badgeTextFailed: { color: "#c0392b" },
});
