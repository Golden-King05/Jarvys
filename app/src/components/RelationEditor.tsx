import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { OsmEditorElement, OsmEditorRelationMember, OsmElementType, TagDefinition } from "../api";
import { fonts } from "../theme";
import { elementDisplayName, osmEditorElementKey, relationGeometry, tagsListToRecord, tagsRecordToList } from "../utils/osmEditorGeometry";
import { useDebouncedTagsDraft } from "../utils/useDebouncedTagsDraft";
import TagsEditor from "./TagsEditor";

interface RelationEditorProps {
  relation: OsmEditorElement;
  // Every element currently in the working set — the pool "pick an existing
  // element" adds from. Explicit type/id entry still works for anything not
  // downloaded yet.
  allElements: OsmEditorElement[];
  tagDefinitions: TagDefinition[];
  suggestedKeys: string[];
  onPatch: (patch: { tags?: Record<string, string>; geometry?: { members: OsmEditorRelationMember[] } }) => void;
  onDelete: () => void;
  onClose: () => void;
}

const MEMBER_TYPES: OsmElementType[] = ["node", "way", "relation"];

export default function RelationEditor({
  relation,
  allElements,
  tagDefinitions,
  suggestedKeys,
  onPatch,
  onDelete,
  onClose,
}: RelationEditorProps) {
  const members = relationGeometry(relation).members;
  const relationKey = osmEditorElementKey(relation.type, relation.id);
  // See useDebouncedTagsDraft — typing a new tag's header straight through a
  // per-keystroke PATCH would otherwise clobber itself (an empty key never
  // round-trips back as a real tag).
  const [draftTags, setDraftTags] = useDebouncedTagsDraft(relationKey, tagsRecordToList(relation.tags), (tags) =>
    onPatch({ tags: tagsListToRecord(tags) })
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualType, setManualType] = useState<OsmElementType>("way");
  const [manualId, setManualId] = useState("");
  const [manualRole, setManualRole] = useState("");

  const elementsByKey = new Map(allElements.map((el) => [osmEditorElementKey(el.type, el.id), el]));

  function setMembers(next: OsmEditorRelationMember[]) {
    onPatch({ geometry: { members: next } });
  }

  function addMember(type: OsmElementType, ref: number, role: string) {
    setMembers([...members, { type, ref, role: role.trim() }]);
  }

  function removeMember(i: number) {
    setMembers(members.filter((_, idx) => idx !== i));
  }

  function moveMember(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= members.length) return;
    const next = [...members];
    [next[i], next[j]] = [next[j], next[i]];
    setMembers(next);
  }

  function updateRole(i: number, role: string) {
    setMembers(members.map((m, idx) => (idx === i ? { ...m, role } : m)));
  }

  // Candidates for the picker: loaded elements not already a member and not
  // the relation itself.
  const candidates = allElements.filter(
    (el) =>
      !(el.type === relation.type && el.id === relation.id) &&
      !members.some((m) => m.type === el.type && m.ref === el.id)
  );

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Relation {relation.id}</Text>
      <Text style={styles.subtitle}>{relation.action === "none" ? "Unchanged" : relation.action}</Text>

      <TagsEditor tags={draftTags} onChange={setDraftTags} suggestedKeys={suggestedKeys} tagDefinitions={tagDefinitions} />

      <Text style={styles.label}>Members ({members.length})</Text>
      {members.map((m, i) => {
        const el = elementsByKey.get(osmEditorElementKey(m.type, m.ref));
        return (
          <View key={`${m.type}-${m.ref}-${i}`} style={styles.memberRow}>
            <View style={styles.memberInfo}>
              <Text style={styles.memberType}>{m.type}</Text>
              <Text style={styles.memberId}>#{m.ref}</Text>
              {el ? <Text style={styles.memberName}>{elementDisplayName(el)}</Text> : null}
            </View>
            <TextInput
              style={styles.roleInput}
              placeholder="role"
              value={m.role}
              onChangeText={(v) => updateRole(i, v)}
            />
            <TouchableOpacity onPress={() => moveMember(i, -1)} hitSlop={6} disabled={i === 0}>
              <Text style={[styles.moveBtn, i === 0 && styles.moveBtnDisabled]}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => moveMember(i, 1)} hitSlop={6} disabled={i === members.length - 1}>
              <Text style={[styles.moveBtn, i === members.length - 1 && styles.moveBtnDisabled]}>↓</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => removeMember(i)} hitSlop={6}>
              <Text style={styles.removeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {pickerOpen ? (
        <View style={styles.picker}>
          <Text style={styles.pickerLabel}>Add from loaded elements</Text>
          <ScrollView style={styles.pickerList} nestedScrollEnabled>
            {candidates.slice(0, 100).map((el) => (
              <TouchableOpacity
                key={osmEditorElementKey(el.type, el.id)}
                style={styles.pickerRow}
                onPress={() => {
                  addMember(el.type, el.id, "");
                  setPickerOpen(false);
                }}
              >
                <Text style={styles.pickerRowText}>
                  {el.type} #{el.id} — {elementDisplayName(el)}
                </Text>
              </TouchableOpacity>
            ))}
            {candidates.length === 0 ? <Text style={styles.pickerEmpty}>Nothing else loaded yet.</Text> : null}
          </ScrollView>

          <Text style={styles.pickerLabel}>Or add by type + id</Text>
          <View style={styles.manualRow}>
            {MEMBER_TYPES.map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.typeChip, manualType === t && styles.typeChipSelected]}
                onPress={() => setManualType(t)}
              >
                <Text style={[styles.typeChipText, manualType === t && styles.typeChipTextSelected]}>{t}</Text>
              </TouchableOpacity>
            ))}
            <TextInput
              style={styles.manualIdInput}
              placeholder="id"
              keyboardType="numbers-and-punctuation"
              value={manualId}
              onChangeText={setManualId}
            />
            <TextInput style={styles.manualRoleInput} placeholder="role" value={manualRole} onChangeText={setManualRole} />
            <TouchableOpacity
              style={styles.manualAddBtn}
              onPress={() => {
                const id = Number(manualId);
                if (!Number.isFinite(id) || id === 0) return;
                addMember(manualType, id, manualRole);
                setManualId("");
                setManualRole("");
              }}
            >
              <Text style={styles.manualAddBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => setPickerOpen(false)}>
            <Text style={styles.pickerCancel}>Close</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.addMemberBtn} onPress={() => setPickerOpen(true)}>
          <Text style={styles.addMemberBtnText}>+ Add member</Text>
        </TouchableOpacity>
      )}

      <View style={styles.footerRow}>
        <TouchableOpacity style={styles.deleteBtn} onPress={onDelete}>
          <Text style={styles.deleteBtnText}>Delete relation</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12 },
  title: { fontFamily: fonts.semiBold, fontSize: 15, color: "#222" },
  subtitle: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginBottom: 10 },
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 12, marginBottom: 6 },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  memberInfo: { flex: 1, minWidth: 0 },
  memberType: { fontFamily: fonts.medium, fontSize: 11, color: "#2980b9" },
  memberId: { fontFamily: fonts.regular, fontSize: 11, color: "#888" },
  memberName: { fontFamily: fonts.regular, fontSize: 12, color: "#333" },
  roleInput: {
    fontFamily: fonts.regular,
    fontSize: 12,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    width: 80,
  },
  moveBtn: { fontSize: 16, color: "#2980b9", paddingHorizontal: 2 },
  moveBtnDisabled: { color: "#ccc" },
  removeBtn: { fontSize: 14, color: "#888", paddingHorizontal: 4 },
  addMemberBtn: { marginTop: 8 },
  addMemberBtnText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  picker: { backgroundColor: "#f7f9fb", borderRadius: 10, padding: 10, marginTop: 8 },
  pickerLabel: { fontFamily: fonts.medium, fontSize: 12, color: "#444", marginBottom: 6 },
  pickerList: { maxHeight: 160, marginBottom: 8 },
  pickerRow: { paddingVertical: 6 },
  pickerRowText: { fontFamily: fonts.regular, fontSize: 12, color: "#333" },
  pickerEmpty: { fontFamily: fonts.regular, fontSize: 12, color: "#999" },
  manualRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  typeChip: { backgroundColor: "#eee", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  typeChipSelected: { backgroundColor: "#2980b9" },
  typeChipText: { fontFamily: fonts.medium, fontSize: 11, color: "#444" },
  typeChipTextSelected: { color: "#fff" },
  manualIdInput: {
    fontFamily: fonts.regular,
    fontSize: 12,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    width: 70,
  },
  manualRoleInput: {
    fontFamily: fonts.regular,
    fontSize: 12,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    width: 80,
  },
  manualAddBtn: { backgroundColor: "#2980b9", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  manualAddBtnText: { fontFamily: fonts.medium, fontSize: 12, color: "#fff" },
  pickerCancel: { fontFamily: fonts.medium, fontSize: 12, color: "#888", marginTop: 8 },
  footerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 16, marginBottom: 24 },
  deleteBtn: { borderWidth: 1, borderColor: "#c0392b", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  deleteBtnText: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  closeBtn: { backgroundColor: "#2980b9", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  closeBtnText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
});
