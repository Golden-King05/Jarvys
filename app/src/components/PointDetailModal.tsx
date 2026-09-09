import React from "react";
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MapPoint, Point } from "../api";
import { fonts } from "../theme";

type DetailSource = Point | MapPoint;

interface PointDetailModalProps {
  point: DetailSource | null;
  onClose: () => void;
  onDelete?: () => void;
}

function isSavedPoint(p: DetailSource): p is Point {
  return "id" in p;
}

// Shared between the full Map screen and the inline map card in chat — a
// saved Point and an in-flight MapPoint from a fresh search look almost the
// same, this just normalizes the field names between them.
export default function PointDetailModal({ point, onClose, onDelete }: PointDetailModalProps) {
  if (!point) return null;

  const saved = isSavedPoint(point);
  const name = saved ? point.name : point.label;
  const icon = (saved ? point.icon : point.icon) || "📍";
  const category = saved ? point.category : point.category;
  const subcategory = saved ? point.subcategory : point.subcategory;
  const urls = (saved ? point.urls : point.urls) ?? [];
  const blurb = (saved ? point.blurb : point.blurb) || (!saved ? point.address : "") || "";

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
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

          {onDelete ? (
            <TouchableOpacity onPress={onDelete} style={styles.deleteButton}>
              <Text style={styles.deleteText}>Remove point</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 18, width: 320, maxWidth: "90%" },
  header: { flexDirection: "row", alignItems: "flex-start" },
  icon: { fontSize: 26, marginRight: 10 },
  headerText: { flex: 1 },
  name: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222" },
  category: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginTop: 2 },
  close: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  blurbBox: { maxHeight: 120, marginTop: 12 },
  blurb: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: "#444" },
  urlsBox: { marginTop: 12, gap: 4 },
  url: { fontFamily: fonts.regular, fontSize: 12, color: "#2980b9" },
  deleteButton: { marginTop: 16, alignSelf: "flex-start" },
  deleteText: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
});
