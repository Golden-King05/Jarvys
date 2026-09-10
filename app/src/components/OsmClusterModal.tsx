import React, { useState } from "react";
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { OsmElement } from "../api";
import { fonts } from "../theme";
import { osmElementName, type OsmCluster } from "../utils/osm";

interface OsmClusterModalProps {
  cluster: OsmCluster | null;
  onClose: () => void;
  onAddToMap: (element: OsmElement) => void;
}

// Browses the raw OSM elements at one map pin — often just one, but a
// building way and a POI node inside it (or several businesses sharing an
// address) land on nearly the same spot and page through here instead of
// stacking overlapping pins.
export default function OsmClusterModal({ cluster, onClose, onAddToMap }: OsmClusterModalProps) {
  const [index, setIndex] = useState(0);

  if (!cluster) return null;
  // Clamp instead of resetting to 0 whenever the cluster prop changes — a
  // fresh query can hand back a same-spot cluster with a different element
  // count while browsing, and this keeps the view from jumping around.
  const safeIndex = Math.min(index, cluster.elements.length - 1);
  const element = cluster.elements[safeIndex];
  const tagEntries = Object.entries(element.tags).filter(([key]) => key !== "name");

  function close() {
    setIndex(0);
    onClose();
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={2}>
                {osmElementName(element)}
              </Text>
              <Text style={styles.subtitle}>
                {element.osmType} {element.osmId}
              </Text>
            </View>
            <TouchableOpacity onPress={close} hitSlop={8}>
              <Text style={styles.closeIcon}>✕</Text>
            </TouchableOpacity>
          </View>

          {cluster.elements.length > 1 ? (
            <View style={styles.pager}>
              <TouchableOpacity
                onPress={() => setIndex((i) => (i - 1 + cluster.elements.length) % cluster.elements.length)}
                hitSlop={8}
              >
                <Text style={styles.pagerArrow}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.pagerLabel}>
                {safeIndex + 1} of {cluster.elements.length}
              </Text>
              <TouchableOpacity onPress={() => setIndex((i) => (i + 1) % cluster.elements.length)} hitSlop={8}>
                <Text style={styles.pagerArrow}>›</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <ScrollView style={styles.tagsBox}>
            {tagEntries.length > 0 ? (
              tagEntries.map(([key, value]) => (
                <Text key={key} style={styles.tagLine}>
                  <Text style={styles.tagKey}>{key}</Text>: {value}
                </Text>
              ))
            ) : (
              <Text style={styles.tagLine}>No other tags.</Text>
            )}
          </ScrollView>

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => Linking.openURL(`https://www.openstreetmap.org/${element.osmType}/${element.osmId}`)}
            >
              <Text style={styles.secondaryButtonText}>Open in OSM</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                onAddToMap(element);
                close();
              }}
            >
              <Text style={styles.primaryButtonText}>Add to my map</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, width: 340, maxWidth: "90%", maxHeight: "75%" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  title: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222", marginRight: 12 },
  subtitle: { fontFamily: fonts.regular, fontSize: 11, color: "#888", marginTop: 2 },
  closeIcon: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    marginBottom: 10,
  },
  pagerArrow: { fontFamily: fonts.semiBold, fontSize: 22, color: "#2980b9", paddingHorizontal: 8 },
  pagerLabel: { fontFamily: fonts.medium, fontSize: 12, color: "#888" },
  tagsBox: { maxHeight: 240, marginBottom: 14 },
  tagLine: { fontFamily: fonts.regular, fontSize: 13, color: "#333", lineHeight: 20 },
  tagKey: { fontFamily: fonts.medium, color: "#555" },
  buttonRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#2980b9",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  primaryButton: {
    flex: 1,
    backgroundColor: "#2980b9",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  primaryButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
});
