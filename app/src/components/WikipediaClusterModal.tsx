import React, { useState } from "react";
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { WikipediaCluster } from "../api";
import { fonts } from "../theme";

interface WikipediaClusterModalProps {
  cluster: WikipediaCluster | null;
  onClose: () => void;
  onAddToMap: (url: string, title: string) => void;
}

// Browses the articles at one map pin — most spots have just one, but a
// building or landmark with several related articles cycles through them
// here instead of needing a separate overlapping pin per article.
export default function WikipediaClusterModal({ cluster, onClose, onAddToMap }: WikipediaClusterModalProps) {
  const [index, setIndex] = useState(0);

  if (!cluster) return null;
  // Clamp instead of resetting to 0 whenever the cluster prop changes — a
  // fresh poll can hand back a same-spot cluster with a different article
  // count while browsing, and this keeps the view from jumping around.
  const safeIndex = Math.min(index, cluster.articles.length - 1);
  const article = cluster.articles[safeIndex];

  function close() {
    setIndex(0);
    onClose();
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={2}>
              {article.title}
            </Text>
            <TouchableOpacity onPress={close} hitSlop={8}>
              <Text style={styles.closeIcon}>✕</Text>
            </TouchableOpacity>
          </View>

          {cluster.articles.length > 1 ? (
            <View style={styles.pager}>
              <TouchableOpacity
                onPress={() => setIndex((i) => (i - 1 + cluster.articles.length) % cluster.articles.length)}
                hitSlop={8}
              >
                <Text style={styles.pagerArrow}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.pagerLabel}>
                {safeIndex + 1} of {cluster.articles.length}
              </Text>
              <TouchableOpacity onPress={() => setIndex((i) => (i + 1) % cluster.articles.length)} hitSlop={8}>
                <Text style={styles.pagerArrow}>›</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <ScrollView style={styles.extractBox}>
            <Text style={styles.extract}>{article.extract || "No summary available."}</Text>
          </ScrollView>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => Linking.openURL(article.url)}>
              <Text style={styles.secondaryButtonText}>Open in Wikipedia</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                onAddToMap(article.url, article.title);
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
  title: { flex: 1, fontFamily: fonts.semiBold, fontSize: 16, color: "#222", marginRight: 12 },
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
  extractBox: { maxHeight: 240, marginBottom: 14 },
  extract: { fontFamily: fonts.regular, fontSize: 13, color: "#333", lineHeight: 19 },
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
