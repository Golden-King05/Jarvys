import React from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { RegionMapData } from "../api";
import { statusColor, statusLabel } from "../utils/regionStatus";
import { fonts } from "../theme";

interface RegionDetailModalProps {
  region: RegionMapData | null;
  onClose: () => void;
}

export default function RegionDetailModal({ region, onClose }: RegionDetailModalProps) {
  if (!region) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={[styles.dot, { backgroundColor: statusColor(region.status) }]} />
            <Text style={styles.name}>{region.name}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.status, { color: statusColor(region.status) }]}>{statusLabel(region.status)}</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 18, width: 280, maxWidth: "90%" },
  header: { flexDirection: "row", alignItems: "center" },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  name: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222", flex: 1 },
  close: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  status: { fontFamily: fonts.medium, fontSize: 14, marginTop: 10, marginLeft: 22 },
});
