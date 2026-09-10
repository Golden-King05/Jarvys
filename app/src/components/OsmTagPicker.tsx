import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { fonts } from "../theme";

interface OsmTagPickerProps {
  // The element's raw OSM tags (name already excluded by the caller — it's
  // its own field on the import form, not a pickable tag).
  tags: Record<string, string>;
  // Which tag keys are currently checked to carry over as this point's tags.
  selectedKeys: string[];
  onChange: (selectedKeys: string[]) => void;
}

// Lets the user pick which of an OSM element's own key/value tags to keep
// as this point's tags — a checklist over the real data rather than typing
// them by hand, since OSM tags (e.g. architecture=Victorian, start_date=1886)
// already match the app's own header/value tag shape.
export default function OsmTagPicker({ tags, selectedKeys, onChange }: OsmTagPickerProps) {
  const entries = Object.entries(tags);

  function toggle(key: string) {
    onChange(selectedKeys.includes(key) ? selectedKeys.filter((k) => k !== key) : [...selectedKeys, key]);
  }

  if (entries.length === 0) return null;

  return (
    <View>
      <Text style={styles.label}>OSM tags — pick which to keep</Text>
      {entries.map(([key, value]) => {
        const checked = selectedKeys.includes(key);
        return (
          <TouchableOpacity key={key} style={styles.row} onPress={() => toggle(key)}>
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
              {checked ? <Text style={styles.checkmark}>✓</Text> : null}
            </View>
            <Text style={styles.rowText} numberOfLines={2}>
              <Text style={styles.rowKey}>{key}</Text>: {value}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 4, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 10 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#bbb",
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxChecked: { backgroundColor: "#2980b9", borderColor: "#2980b9" },
  checkmark: { color: "#fff", fontSize: 12, fontFamily: fonts.semiBold, lineHeight: 13 },
  rowText: { flex: 1, fontFamily: fonts.regular, fontSize: 13, color: "#333" },
  rowKey: { fontFamily: fonts.medium, color: "#555" },
});
