import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { api, isSavedPoint, type MapPoint, type Point, type PointTag, type TagDefinition } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";
import { suggestIcon } from "../utils/suggestIcon";
import TagsEditor from "./TagsEditor";

type DetailSource = Point | MapPoint;

interface SavePatch {
  name: string;
  category: string;
  subcategory: string;
  icon: string;
  blurb: string;
  urls: string[];
  tags: PointTag[];
}

interface PointDetailModalProps {
  point: DetailSource | null;
  onClose: () => void;
  onDelete?: () => void;
  // Only offered for a saved Point (has somewhere to persist to) — an
  // ephemeral MapPoint from a fresh search just gets viewed, not edited.
  onSave?: (patch: SavePatch) => Promise<void> | void;
}

function pointKey(point: DetailSource): string {
  return isSavedPoint(point) ? point.id : `${point.label}:${point.lat}:${point.lon}`;
}

// Shared between the full Map screen and the inline map card in chat — a
// saved Point and an in-flight MapPoint from a fresh search look almost the
// same, this just normalizes the field names between them.
export default function PointDetailModal({ point, onClose, onDelete, onSave }: PointDetailModalProps) {
  const { baseUrl, token } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{
    name: string;
    category: string;
    subcategory: string;
    icon: string;
    blurb: string;
    urls: string;
    tags: PointTag[];
  }>({ name: "", category: "", subcategory: "", icon: "📍", blurb: "", urls: "", tags: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [tagDefinitions, setTagDefinitions] = useState<TagDefinition[]>([]);
  // Tags start collapsed each time a pin is opened — a point can carry a
  // lot of them now (a full address alone is five) and most of the time
  // you just want the name/blurb at a glance. Same collapsed-by-default,
  // tap-to-expand pattern as the chat's "API used" marker.
  const [tagsExpanded, setTagsExpanded] = useState(false);
  // Locked as soon as someone edits the icon field by hand, so category
  // suggestions stop overwriting a deliberate choice — reset on each edit.
  const iconLocked = useRef(false);

  function updateDraft(patch: Partial<typeof draft>) {
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (!iconLocked.current) {
        const suggestion = suggestIcon(next.category, next.subcategory);
        if (suggestion) next.icon = suggestion;
      }
      return next;
    });
  }

  useEffect(() => {
    setEditing(false);
    setError(null);
    setTagsExpanded(false);
  }, [point ? pointKey(point) : null]);

  if (!point) return null;

  const saved = isSavedPoint(point);
  const name = saved ? point.name : point.label;
  const icon = point.icon || "📍";
  const category = point.category;
  const subcategory = point.subcategory;
  const urls = point.urls ?? [];
  const blurb = point.blurb || (!saved ? point.address : "") || "";
  const tags = point.tags ?? [];

  function startEditing() {
    setDraft({
      name,
      category: category ?? "",
      subcategory: subcategory ?? "",
      icon,
      blurb,
      urls: urls.join("\n"),
      tags,
    });
    iconLocked.current = false;
    setError(null);
    setEditing(true);
    if (token) {
      api
        .getTagKeys(baseUrl, token)
        .then(({ keys }) => setTagKeys(keys))
        .catch(() => {
          // No suggestions if this fails — the tag editor still works, just
          // without existing headers to pick from.
        });
      api
        .getTagDefinitions(baseUrl, token)
        .then(({ definitions }) => setTagDefinitions(definitions))
        .catch(() => {
          // No autofill if this fails — the tag editor still works.
        });
    }
  }

  async function save() {
    if (!onSave) return;
    if (!draft.name.trim()) {
      setError("Give it a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: draft.name.trim(),
        category: draft.category.trim(),
        subcategory: draft.subcategory.trim(),
        icon: draft.icon.trim() || "📍",
        blurb: draft.blurb.trim(),
        urls: draft.urls
          .split("\n")
          .map((u) => u.trim())
          .filter(Boolean),
        tags: draft.tags
          .map((t) => ({ key: t.key.trim(), value: t.value.trim() }))
          .filter((t) => t.key && t.value),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {editing ? (
            <ScrollView contentContainerStyle={{ paddingBottom: 4 }}>
              <View style={styles.header}>
                <Text style={styles.editTitle}>Edit point</Text>
                <TouchableOpacity onPress={onClose} hitSlop={8}>
                  <Text style={styles.close}>✕</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                placeholder="Name"
                value={draft.name}
                onChangeText={(v) => setDraft((d) => ({ ...d, name: v }))}
              />
              <TextInput
                style={styles.input}
                placeholder="Category (e.g. restaurant)"
                value={draft.category}
                onChangeText={(v) => updateDraft({ category: v })}
              />
              <TextInput
                style={styles.input}
                placeholder="Subcategory (e.g. Chinese fusion restaurant)"
                value={draft.subcategory}
                onChangeText={(v) => updateDraft({ subcategory: v })}
              />
              <TextInput
                style={styles.input}
                placeholder="Icon emoji — auto-suggested from category"
                value={draft.icon}
                onChangeText={(v) => {
                  iconLocked.current = true;
                  setDraft((d) => ({ ...d, icon: v }));
                }}
              />
              <TextInput
                style={[styles.input, styles.blurbInput]}
                placeholder="Notes"
                multiline
                value={draft.blurb}
                onChangeText={(v) => setDraft((d) => ({ ...d, blurb: v }))}
              />
              <TextInput
                style={[styles.input, styles.urlsInput]}
                placeholder="Links, one per line"
                multiline
                autoCapitalize="none"
                value={draft.urls}
                onChangeText={(v) => setDraft((d) => ({ ...d, urls: v }))}
              />
              <TagsEditor
                tags={draft.tags}
                onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
                suggestedKeys={tagKeys}
                tagDefinitions={tagDefinitions}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <View style={styles.formButtons}>
                <TouchableOpacity onPress={() => setEditing(false)} disabled={saving}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                {saving ? (
                  <ActivityIndicator />
                ) : (
                  <TouchableOpacity style={styles.saveButton} onPress={save}>
                    <Text style={styles.saveButtonText}>Save</Text>
                  </TouchableOpacity>
                )}
              </View>
            </ScrollView>
          ) : (
            <>
              <View style={styles.header}>
                <Text style={styles.icon}>{icon}</Text>
                <View style={styles.headerText}>
                  <Text style={styles.name}>{name}</Text>
                  {category ? (
                    <Text style={styles.category}>
                      {category}
                      {subcategory ? ` · ${subcategory}` : ""}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity onPress={onClose} hitSlop={8}>
                  <Text style={styles.close}>✕</Text>
                </TouchableOpacity>
              </View>

              {blurb ? (
                <ScrollView style={styles.blurbBox}>
                  <Text style={styles.blurb}>{blurb}</Text>
                </ScrollView>
              ) : null}

              {urls.length > 0 ? (
                <View style={styles.urlsBox}>
                  {urls.map((u, i) => (
                    <TouchableOpacity key={i} onPress={() => Linking.openURL(u)}>
                      <Text style={styles.url} numberOfLines={1}>
                        {u}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              {tags.length > 0 ? (
                <View>
                  <TouchableOpacity onPress={() => setTagsExpanded((e) => !e)}>
                    <Text style={styles.tagsToggle}>
                      {tagsExpanded ? "Hide tags" : `Show tags (${tags.length})`}
                    </Text>
                  </TouchableOpacity>
                  {tagsExpanded ? (
                    <View style={styles.tagsBox}>
                      {tags.map((t, i) => (
                        <View key={i} style={styles.tagChip}>
                          <Text style={styles.tagChipText}>
                            {t.key}: {t.value}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}

              {onSave || onDelete ? (
                <View style={styles.actionsRow}>
                  {onSave ? (
                    <TouchableOpacity onPress={startEditing}>
                      <Text style={styles.editText}>Edit</Text>
                    </TouchableOpacity>
                  ) : null}
                  {onDelete ? (
                    <TouchableOpacity onPress={onDelete}>
                      <Text style={styles.deleteText}>Remove point</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 18, width: 320, maxWidth: "90%", maxHeight: "80%" },
  header: { flexDirection: "row", alignItems: "flex-start", marginBottom: 4 },
  icon: { fontSize: 26, marginRight: 10 },
  headerText: { flex: 1 },
  name: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222" },
  editTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222", flex: 1 },
  category: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginTop: 2 },
  close: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  blurbBox: { maxHeight: 120, marginTop: 12 },
  blurb: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: "#444" },
  urlsBox: { marginTop: 12, gap: 4 },
  url: { fontFamily: fonts.regular, fontSize: 12, color: "#2980b9" },
  tagsToggle: { fontFamily: fonts.medium, fontSize: 11, color: "#999", marginTop: 12 },
  tagsBox: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  tagChip: { backgroundColor: "#f0f0f0", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  tagChipText: { fontFamily: fonts.medium, fontSize: 11, color: "#444" },
  actionsRow: { flexDirection: "row", gap: 20, marginTop: 16 },
  editText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  deleteText: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  input: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
  },
  blurbInput: { minHeight: 70, textAlignVertical: "top" },
  urlsInput: { minHeight: 50, textAlignVertical: "top" },
  error: { fontFamily: fonts.regular, fontSize: 12, color: "#c0392b", marginBottom: 8 },
  formButtons: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  cancelText: { fontFamily: fonts.medium, fontSize: 13, color: "#888" },
  saveButton: { backgroundColor: "#2980b9", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  saveButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
});
