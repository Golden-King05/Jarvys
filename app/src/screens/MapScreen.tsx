import React, { useEffect, useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import MapCanvas from "../components/MapCanvas";
import PointDetailModal from "../components/PointDetailModal";
import RegionDetailModal from "../components/RegionDetailModal";
import RegionLegend from "../components/RegionLegend";
import { api, type MapData, type MapPoint, type Point, type RegionMapData } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";

interface MapScreenProps {
  mapData: MapData | null;
  onVerifyMap: () => void;
}

type AddStep = "closed" | "choose" | "manual-coords" | "url" | "details" | "awaiting-tap";

function toMapPoint(p: Point): MapPoint {
  return {
    label: p.name,
    lat: p.lat,
    lon: p.lon,
    icon: p.icon,
    category: p.category || undefined,
    subcategory: p.subcategory || undefined,
    urls: p.urls,
    blurb: p.blurb,
  };
}

export default function MapScreen({ mapData, onVerifyMap }: MapScreenProps) {
  const { baseUrl, token } = useAuth();
  const [initialRegion, setInitialRegion] = useState<{ latitude: number; longitude: number } | undefined>();
  const [points, setPoints] = useState<Point[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<Point | MapPoint | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionMapData | null>(null);

  const [addStep, setAddStep] = useState<AddStep>("closed");
  const [pendingLocation, setPendingLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [pendingUrlFinish, setPendingUrlFinish] = useState<{
    url: string;
    category?: string;
    subcategory?: string;
    icon?: string;
  } | null>(null);
  const [manualCoords, setManualCoords] = useState({ lat: "", lon: "" });
  const [urlDraft, setUrlDraft] = useState({ url: "", category: "", subcategory: "", icon: "" });
  const [detailsDraft, setDetailsDraft] = useState({ name: "", category: "", subcategory: "", icon: "📍", blurb: "" });
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (mapData) return; // The AI's plotted points drive the view instead once there are any.
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const position = await Location.getCurrentPositionAsync({});
        setInitialRegion({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      } catch {
        // No location available — the map just falls back to its default view.
      }
    })();
  }, [mapData]);

  async function loadPoints() {
    if (!token) return;
    try {
      const { points: rows } = await api.getPoints(baseUrl, token);
      setPoints(rows);
    } catch {
      // A failed refresh just leaves the last-known list on screen.
    }
  }

  useEffect(() => {
    loadPoints();
    // Re-pull whenever a new search backs up fresh points server-side.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData]);

  function closeAddFlow() {
    setAddStep("closed");
    setPendingLocation(null);
    setPendingUrlFinish(null);
    setManualCoords({ lat: "", lon: "" });
    setUrlDraft({ url: "", category: "", subcategory: "", icon: "" });
    setDetailsDraft({ name: "", category: "", subcategory: "", icon: "📍", blurb: "" });
    setAddError(null);
  }

  async function finishUrlImport(lat: number, lon: number) {
    if (!pendingUrlFinish || !token) return;
    setSubmitting(true);
    setAddError(null);
    try {
      const result = await api.createPointFromUrl(baseUrl, token, { ...pendingUrlFinish, lat, lon });
      if (result.needsLocation) {
        setAddError("Still couldn't place that link — try different coordinates.");
      } else {
        await loadPoints();
        closeAddFlow();
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to import URL");
    } finally {
      setSubmitting(false);
    }
  }

  function handleMapPress(lat: number, lon: number) {
    if (addStep !== "awaiting-tap") return;
    if (pendingUrlFinish) {
      finishUrlImport(lat, lon);
    } else {
      setPendingLocation({ lat, lon });
      setAddStep("details");
    }
  }

  function submitManualCoords() {
    const lat = Number(manualCoords.lat);
    const lon = Number(manualCoords.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setAddError("Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    setAddError(null);
    if (pendingUrlFinish) {
      finishUrlImport(lat, lon);
    } else {
      setPendingLocation({ lat, lon });
      setAddStep("details");
    }
  }

  async function submitDetails() {
    if (!pendingLocation || !token) return;
    if (!detailsDraft.name.trim()) {
      setAddError("Give it a name.");
      return;
    }
    setSubmitting(true);
    setAddError(null);
    try {
      await api.createPoint(baseUrl, token, {
        name: detailsDraft.name.trim(),
        category: detailsDraft.category.trim(),
        subcategory: detailsDraft.subcategory.trim(),
        icon: detailsDraft.icon.trim() || "📍",
        lat: pendingLocation.lat,
        lon: pendingLocation.lon,
        blurb: detailsDraft.blurb.trim(),
      });
      await loadPoints();
      closeAddFlow();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add point");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitUrl() {
    if (!urlDraft.url.trim() || !token) {
      setAddError("Enter a URL.");
      return;
    }
    setSubmitting(true);
    setAddError(null);
    try {
      const payload = {
        url: urlDraft.url.trim(),
        category: urlDraft.category.trim() || undefined,
        subcategory: urlDraft.subcategory.trim() || undefined,
        icon: urlDraft.icon.trim() || undefined,
      };
      const result = await api.createPointFromUrl(baseUrl, token, payload);
      if (result.needsLocation) {
        setPendingUrlFinish(payload);
        setAddStep("awaiting-tap");
        setAddError(null);
      } else {
        await loadPoints();
        closeAddFlow();
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to import URL");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteSelected() {
    if (!selectedPoint || !("id" in selectedPoint) || !token) return;
    try {
      await api.deletePoint(baseUrl, token, selectedPoint.id);
      await loadPoints();
    } catch {
      // Leave the point selected if the delete failed — nothing to reconcile.
    } finally {
      setSelectedPoint(null);
    }
  }

  const savedMarkers = points.map(toMapPoint);
  const markers = mapData?.kind === "distance" ? [...savedMarkers, ...mapData.points] : savedMarkers;
  const regions = mapData?.kind === "regions" ? mapData.regions : undefined;
  const hasStatusLegend = regions?.some((r) => r.status) ?? false;

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <MapCanvas
          points={markers}
          showLine={mapData?.kind === "distance"}
          regions={regions}
          initialRegion={initialRegion}
          onMapPress={handleMapPress}
          onPointPress={setSelectedPoint}
          onRegionPress={setSelectedRegion}
          pendingMarker={addStep === "details" ? pendingLocation : null}
        />

        {addStep === "awaiting-tap" ? (
          <View style={styles.tapBanner}>
            <Text style={styles.tapBannerText}>Tap the map to place your point</Text>
            <TouchableOpacity onPress={closeAddFlow}>
              <Text style={styles.tapBannerCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity style={styles.addButton} onPress={() => setAddStep("choose")}>
          <Text style={styles.addButtonText}>+</Text>
        </TouchableOpacity>
      </View>

      {hasStatusLegend ? <RegionLegend /> : null}

      {mapData?.kind === "regions" ? (
        mapData.verified ? (
          <Text style={styles.verifiedLabel}>✓ Verified state-by-state</Text>
        ) : (
          <TouchableOpacity style={styles.verifyButton} onPress={onVerifyMap}>
            <Text style={styles.verifyButtonText}>Verify Map</Text>
          </TouchableOpacity>
        )
      ) : null}

      {mapData && mapData.kind === "distance" && mapData.distanceMiles != null ? (
        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>
            {mapData.points[0]?.label} to {mapData.points[1]?.label}: {mapData.distanceMiles.toLocaleString()} mi (
            {mapData.distanceKm?.toLocaleString()} km)
          </Text>
        </View>
      ) : null}

      <PointDetailModal
        point={selectedPoint}
        onClose={() => setSelectedPoint(null)}
        onDelete={selectedPoint && "id" in selectedPoint ? handleDeleteSelected : undefined}
      />
      <RegionDetailModal region={selectedRegion} onClose={() => setSelectedRegion(null)} />

      <Modal
        visible={addStep === "choose"}
        transparent
        animationType="fade"
        onRequestClose={closeAddFlow}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add a point</Text>
            <TouchableOpacity style={styles.choiceButton} onPress={() => setAddStep("awaiting-tap")}>
              <Text style={styles.choiceText}>Tap on the map</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.choiceButton} onPress={() => setAddStep("manual-coords")}>
              <Text style={styles.choiceText}>Enter coordinates</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.choiceButton} onPress={() => setAddStep("url")}>
              <Text style={styles.choiceText}>Import from a URL</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={closeAddFlow} style={styles.cancelLink}>
              <Text style={styles.cancelLinkText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={addStep === "manual-coords"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Coordinates</Text>
            <TextInput
              style={styles.input}
              placeholder="Latitude"
              keyboardType="numeric"
              value={manualCoords.lat}
              onChangeText={(v) => setManualCoords((c) => ({ ...c, lat: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Longitude"
              keyboardType="numeric"
              value={manualCoords.lon}
              onChangeText={(v) => setManualCoords((c) => ({ ...c, lon: v }))}
            />
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitManualCoords}>
                <Text style={styles.submitButtonText}>Next</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={addStep === "url"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Import from a URL</Text>
            <TextInput
              style={styles.input}
              placeholder="https://…"
              autoCapitalize="none"
              value={urlDraft.url}
              onChangeText={(v) => setUrlDraft((d) => ({ ...d, url: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Category (optional)"
              value={urlDraft.category}
              onChangeText={(v) => setUrlDraft((d) => ({ ...d, category: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Subcategory (optional)"
              value={urlDraft.subcategory}
              onChangeText={(v) => setUrlDraft((d) => ({ ...d, subcategory: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Icon emoji (optional)"
              value={urlDraft.icon}
              onChangeText={(v) => setUrlDraft((d) => ({ ...d, icon: v }))}
            />
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitUrl} disabled={submitting}>
                <Text style={styles.submitButtonText}>{submitting ? "Importing…" : "Import"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={addStep === "details"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <ScrollView style={styles.card} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={styles.cardTitle}>Details</Text>
            {pendingLocation ? (
              <Text style={styles.coordsLabel}>
                {pendingLocation.lat.toFixed(5)}, {pendingLocation.lon.toFixed(5)}
              </Text>
            ) : null}
            <TextInput
              style={styles.input}
              placeholder="Name"
              value={detailsDraft.name}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, name: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Category (e.g. restaurant)"
              value={detailsDraft.category}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, category: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Subcategory (e.g. Chinese fusion restaurant)"
              value={detailsDraft.subcategory}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, subcategory: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Icon emoji"
              value={detailsDraft.icon}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, icon: v }))}
            />
            <TextInput
              style={[styles.input, styles.blurbInput]}
              placeholder="Notes (optional)"
              multiline
              value={detailsDraft.blurb}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, blurb: v }))}
            />
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitDetails} disabled={submitting}>
                <Text style={styles.submitButtonText}>{submitting ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapWrap: { flex: 1 },
  addButton: {
    position: "absolute",
    right: 16,
    bottom: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#2980b9",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    // Leaflet's own zoom/attribution controls carry z-index: 1000 inside a
    // container div that doesn't establish its own stacking context on web,
    // so without this the map's controls render above this button even
    // though it's a later sibling.
    zIndex: 1000,
  },
  addButtonText: { color: "#fff", fontSize: 28, lineHeight: 30, fontFamily: fonts.medium },
  tapBanner: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    elevation: 4,
    zIndex: 1000,
  },
  tapBannerText: { fontFamily: fonts.medium, fontSize: 13, color: "#222" },
  tapBannerCancel: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  infoBox: { padding: 12, borderTopWidth: 1, borderTopColor: "#eee" },
  verifyButton: { alignSelf: "center", paddingVertical: 8 },
  verifyButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  verifiedLabel: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: "#27ae60",
    textAlign: "center",
    paddingVertical: 8,
  },
  infoTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: "#222" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, width: 320, maxWidth: "90%", maxHeight: "80%" },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222", marginBottom: 14 },
  choiceButton: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  choiceText: { fontFamily: fonts.medium, fontSize: 14, color: "#2980b9" },
  cancelLink: { marginTop: 14, alignSelf: "flex-start" },
  cancelLinkText: { fontFamily: fonts.medium, fontSize: 13, color: "#888" },
  input: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
  },
  blurbInput: { minHeight: 90, textAlignVertical: "top" },
  coordsLabel: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginBottom: 10 },
  errorText: { fontFamily: fonts.regular, fontSize: 12, color: "#c0392b", marginBottom: 8 },
  formButtons: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  submitButton: { backgroundColor: "#2980b9", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  submitButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
});
