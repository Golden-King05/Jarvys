import React from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { PointTag } from "../api";
import { fonts } from "../theme";

interface TagsEditorProps {
  tags: PointTag[];
  onChange: (tags: PointTag[]) => void;
  // Headers already used elsewhere on the account — tapping one starts a new
  // row with that header, so a header like "architecture" naturally gets
  // reused instead of drifting into a near-duplicate like
  // "building_architecture". Nothing stops typing a brand new header too.
  suggestedKeys: string[];
}

// A tag is a header + value pair rather than one free-text field, so the
// header set stays small and query-able (e.g. "show me every point tagged
// architecture") while the value stays open-ended.
export default function TagsEditor({ tags, onChange, suggestedKeys }: TagsEditorProps) {
  function updateTag(i: number, patch: Partial<PointTag>) {
    onChange(tags.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }

  function removeTag(i: number) {
    onChange(tags.filter((_, idx) => idx !== i));
  }

  function addTag(key = "") {
    onChange([...tags, { key, value: "" }]);
  }

  const unusedSuggestions = suggestedKeys.filter((k) => !tags.some((t) => t.key === k));

  return (
    <View>
      <Text style={styles.label}>Tags</Text>
      {unusedSuggestions.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.suggestionsRow}>
          {unusedSuggestions.map((key) => (
            <TouchableOpacity key={key} style={styles.suggestionChip} onPress={() => addTag(key)}>
              <Text style={styles.suggestionChipText}>{key}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
      {tags.map((tag, i) => (
        <View key={i} style={styles.tagRow}>
          <TextInput
            style={[styles.tagInput, styles.tagKeyInput]}
            placeholder="Header (e.g. architecture)"
            value={tag.key}
            onChangeText={(v) => updateTag(i, { key: v })}
          />
          <TextInput
            style={[styles.tagInput, styles.tagValueInput]}
            placeholder="Value (e.g. Victorian)"
            value={tag.value}
            onChangeText={(v) => updateTag(i, { value: v })}
          />
          <TouchableOpacity onPress={() => removeTag(i)} hitSlop={8}>
            <Text style={styles.tagRemove}>✕</Text>
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity onPress={() => addTag()}>
        <Text style={styles.addTagText}>+ Add tag</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 4, marginBottom: 6 },
  suggestionsRow: { marginBottom: 8 },
  suggestionChip: {
    backgroundColor: "#f0f0f0",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  suggestionChipText: { fontFamily: fonts.medium, fontSize: 12, color: "#444" },
  tagRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  tagInput: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  tagKeyInput: { flex: 1 },
  tagValueInput: { flex: 1 },
  tagRemove: { fontFamily: fonts.medium, fontSize: 14, color: "#888", paddingHorizontal: 2 },
  addTagText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9", marginBottom: 4 },
});
