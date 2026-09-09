import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { describeToolsUsed } from "../utils/toolLabels";
import { fonts } from "../theme";

interface ApiUsedBadgeProps {
  toolsUsed: string[];
}

// A collapsed marker under a reply instead of having the model narrate its
// own sourcing in the text ("I checked Wikipedia and found...") — tap it to
// see which free APIs/data sources actually answered this message.
export default function ApiUsedBadge({ toolsUsed }: ApiUsedBadgeProps) {
  const [expanded, setExpanded] = useState(false);
  if (toolsUsed.length === 0) return null;
  const items = describeToolsUsed(toolsUsed);

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => setExpanded((e) => !e)}>
        <Text style={styles.toggle}>{expanded ? "Hide API used" : "API used"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.row}>
          {items.map((item, i) => (
            <View key={i} style={styles.badge}>
              <Text style={styles.badgeText}>
                {item.icon} {item.label}
              </Text>
            </View>
          ))}
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
  badgeText: { fontFamily: fonts.regular, fontSize: 11, color: "#555" },
});
