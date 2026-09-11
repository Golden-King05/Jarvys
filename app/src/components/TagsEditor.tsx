import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { PointTag, TagDefinition } from "../api";
import { fonts } from "../theme";

interface TagsEditorProps {
  tags: PointTag[];
  onChange: (tags: PointTag[]) => void;
  // Headers already used elsewhere on the account — tapping one starts a new
  // row with that header, so a header like "architecture" naturally gets
  // reused instead of drifting into a near-duplicate like
  // "building_architecture". Nothing stops typing a brand new header too.
  suggestedKeys: string[];
  // The app's own documented tag vocabulary — when a row's header matches
  // one of these, the value side autofills instead of staying a blank
  // free-text box: a closed set becomes a pick-list, and a format/free-text
  // tag gets its real hint as the placeholder instead of a generic one.
  tagDefinitions: TagDefinition[];
}

const ADDR_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "addr:street", label: "Street address", placeholder: "123 Main St" },
  { key: "addr:city", label: "City / town", placeholder: "Springfield" },
  { key: "addr:state", label: "State / region", placeholder: "IL" },
  { key: "addr:postcode", label: "ZIP / postal code", placeholder: "62704" },
  { key: "addr:country", label: "Country", placeholder: "USA" },
];

// A tag is a header + value pair rather than one free-text field, so the
// header set stays small and query-able (e.g. "show me every point tagged
// architecture") while the value stays open-ended.
export default function TagsEditor({ tags, onChange, suggestedKeys, tagDefinitions }: TagsEditorProps) {
  // Row index currently showing the combined address sub-form, and its own
  // draft — typing "addr" as a header (rather than one specific addr:street
  // etc.) opens this instead of a plain value box.
  const [addrFormRow, setAddrFormRow] = useState<number | null>(null);
  const [addrDraft, setAddrDraft] = useState({ street: "", city: "", state: "", postcode: "", country: "" });

  function updateTag(i: number, patch: Partial<PointTag>) {
    onChange(tags.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
    if (addrFormRow === i) setAddrFormRow(null);
  }

  function removeTag(i: number) {
    onChange(tags.filter((_, idx) => idx !== i));
    if (addrFormRow === i) setAddrFormRow(null);
  }

  function addTag(key = "") {
    onChange([...tags, { key, value: "" }]);
  }

  function definitionFor(key: string): TagDefinition | undefined {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return undefined;
    const exact = tagDefinitions.find((d) => d.key.toLowerCase() === normalized);
    if (exact) return exact;
    // wikipedia:<language code> carries its language in the header itself
    // (wikipedia:en, wikipedia:fr, ...), so there's no single literal key to
    // match exactly — fall back to the generic "wikipedia" definition (its
    // hint about the article-title value) for any language code.
    if (/^wikipedia:[a-z]{2,3}$/.test(normalized)) {
      return tagDefinitions.find((d) => d.key.toLowerCase() === "wikipedia");
    }
    return undefined;
  }

  // Tapping a suggested value completes whatever's currently being typed
  // (the text after the last ";") into that full value, the same way
  // tapping a header suggestion fills the header — a shortcut on top of
  // free typing, not the only way to fill the field. Multiple values still
  // combine with ";": finish one, keep typing after it, pick the next.
  function completeEnumValue(i: number, option: string) {
    const parts = tags[i].value.split(";").map((v) => v.trim());
    parts[parts.length - 1] = option;
    const deduped = [...new Set(parts.filter(Boolean))];
    updateTag(i, { value: deduped.join(";") });
  }

  function openAddrForm(i: number) {
    const get = (key: string) => tags.find((t) => t.key === key)?.value ?? "";
    setAddrDraft({
      street: get("addr:street"),
      city: get("addr:city"),
      state: get("addr:state"),
      postcode: get("addr:postcode"),
      country: get("addr:country"),
    });
    setAddrFormRow(i);
  }

  function submitAddrForm() {
    if (addrFormRow === null) return;
    const values: Record<string, string> = {
      "addr:street": addrDraft.street,
      "addr:city": addrDraft.city,
      "addr:state": addrDraft.state,
      "addr:postcode": addrDraft.postcode,
      "addr:country": addrDraft.country,
    };
    const merged = tags.filter((_, idx) => idx !== addrFormRow);
    for (const [key, value] of Object.entries(values)) {
      if (!value.trim()) continue;
      const existingIdx = merged.findIndex((t) => t.key === key);
      if (existingIdx >= 0) merged[existingIdx] = { key, value: value.trim() };
      else merged.push({ key, value: value.trim() });
    }
    onChange(merged);
    setAddrFormRow(null);
  }

  // "addr" itself isn't a real tag (the real ones are addr:street etc.) —
  // surfaced as a suggestion anyway since it's the shortcut into the
  // combined form, not something anyone would otherwise think to type.
  // "wikipedia" (bare, no language code) is excluded the same way "wikipedia"
  // is documented as a definition to fall back to, not a literal usable key —
  // "wikipedia:en" (the common case) is offered directly instead, ready to
  // use or to hand-edit the language code on.
  const allSuggestions = [
    ...new Set([
      ...suggestedKeys,
      ...tagDefinitions.filter((d) => d.key.toLowerCase() !== "wikipedia").map((d) => d.key),
      "addr",
      "wikipedia:en",
    ]),
  ];
  const unusedSuggestions = allSuggestions.filter((k) => !tags.some((t) => t.key === k));

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
      {tags.map((tag, i) => {
        const isAddrTrigger = tag.key.trim().toLowerCase() === "addr";
        const definition = isAddrTrigger ? undefined : definitionFor(tag.key);
        return (
          <View key={i} style={styles.tagBlock}>
            <View style={styles.tagHeaderRow}>
              <TextInput
                style={[styles.tagInput, styles.tagKeyInput]}
                placeholder="Header (e.g. architecture)"
                value={tag.key}
                onChangeText={(v) => updateTag(i, { key: v })}
              />
              <TouchableOpacity onPress={() => removeTag(i)} hitSlop={8}>
                <Text style={styles.tagRemove}>✕</Text>
              </TouchableOpacity>
            </View>

            {isAddrTrigger ? (
              <TouchableOpacity style={styles.addrButton} onPress={() => openAddrForm(i)}>
                <Text style={styles.addrButtonText}>📍 Fill in address…</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TextInput
                  style={styles.tagInput}
                  placeholder={definition?.hint ?? "Value (e.g. Victorian)"}
                  value={tag.value}
                  onChangeText={(v) => updateTag(i, { value: v })}
                />
                {definition?.kind === "enum" ? (
                  <View style={styles.enumChipsRow}>
                    {definition.values!.filter((option) => {
                      const typed = tag.value.split(";").pop()!.trim().toLowerCase();
                      return !typed || (option.toLowerCase().includes(typed) && option.toLowerCase() !== typed);
                    }).map((option) => (
                      <TouchableOpacity key={option} style={styles.enumChip} onPress={() => completeEnumValue(i, option)}>
                        <Text style={styles.enumChipText}>{option}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </>
            )}

            {addrFormRow === i ? (
              <View style={styles.addrForm}>
                {ADDR_FIELDS.map((field) => (
                  <TextInput
                    key={field.key}
                    style={styles.tagInput}
                    placeholder={field.placeholder}
                    value={addrDraft[field.key.replace("addr:", "") as keyof typeof addrDraft]}
                    onChangeText={(v) =>
                      setAddrDraft((d) => ({ ...d, [field.key.replace("addr:", "")]: v }))
                    }
                  />
                ))}
                <View style={styles.addrFormButtons}>
                  <TouchableOpacity onPress={() => setAddrFormRow(null)}>
                    <Text style={styles.addrFormCancel}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.addrFormSave} onPress={submitAddrForm}>
                    <Text style={styles.addrFormSaveText}>Save address</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
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
  tagBlock: { marginBottom: 10 },
  tagHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  tagInput: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    marginBottom: 6,
  },
  tagKeyInput: { flex: 1, marginBottom: 0 },
  tagRemove: { fontFamily: fonts.medium, fontSize: 14, color: "#888", paddingHorizontal: 2 },
  enumChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  enumChip: {
    backgroundColor: "#f0f0f0",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "transparent",
  },
  enumChipSelected: { backgroundColor: "#e8f1fa", borderColor: "#2980b9" },
  enumChipText: { fontFamily: fonts.medium, fontSize: 12, color: "#444" },
  enumChipTextSelected: { color: "#2980b9" },
  addrButton: {
    borderWidth: 1,
    borderColor: "#2980b9",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
    marginBottom: 6,
  },
  addrButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  addrForm: { backgroundColor: "#f7f9fb", borderRadius: 10, padding: 10, marginBottom: 6 },
  addrFormButtons: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 },
  addrFormCancel: { fontFamily: fonts.medium, fontSize: 12, color: "#888" },
  addrFormSave: { backgroundColor: "#2980b9", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  addrFormSaveText: { fontFamily: fonts.medium, fontSize: 12, color: "#fff" },
  addTagText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9", marginBottom: 4 },
});
