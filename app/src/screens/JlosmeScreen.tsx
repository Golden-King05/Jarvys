import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import Slider from "@react-native-community/slider";
import OsmEditorMap, {
  type EditorBaseLayer,
  type EditorMode,
  type OsmEditorMapHandle,
  type WayDraftPoint,
} from "../components/OsmEditorMap";
import RelationEditor from "../components/RelationEditor";
import OsmUploadPanel from "../components/OsmUploadPanel";
import TagsEditor from "../components/TagsEditor";
import {
  api,
  CancelledError,
  type OsmEditorElement,
  type OsmEditorGeometry,
  type OsmElementType,
  type OsmUploadTarget,
  type TagDefinition,
} from "../api";
import { osmTargetStorage } from "../utils/osmAuth";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";
import { isBingConfigured } from "../utils/bingImagery";
import type { AiTraceStatus } from "../utils/aiTraceTypes";
import {
  elementDisplayName,
  nodeGeometry,
  osmEditorElementKey,
  tagsListToRecord,
  tagsRecordToList,
  wayGeometry,
} from "../utils/osmEditorGeometry";
import { useDebouncedTagsDraft } from "../utils/useDebouncedTagsDraft";
import { squareWayNodes } from "../utils/squareWay";

// The tab is labeled "JLOSME" in the UI (the user's own chosen name) even
// though every internal file/component uses plain descriptive names — this
// screen, its map, and its helpers are all just "the OSM editor" in code.
export default function JlosmeScreen() {
  const { baseUrl, token } = useAuth();
  const mapRef = useRef<OsmEditorMapHandle>(null);

  const [elements, setElements] = useState<OsmEditorElement[]>([]);
  const [tagDefinitions, setTagDefinitions] = useState<TagDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<EditorMode>("view");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [baseLayer, setBaseLayer] = useState<EditorBaseLayer>("osm");
  const [showLidar, setShowLidar] = useState(false);
  const [lidarOpacity, setLidarOpacity] = useState(0.7);
  const [showImagery, setShowImagery] = useState(false);
  const [showRelations, setShowRelations] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // a short label while an async action is in flight
  const [downloadElapsedMs, setDownloadElapsedMs] = useState(0);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  // Progress/state for the two AI-assisted tracing tools (see
  // aiTraceTypes.ts) — OsmEditorMap.web.tsx reports into this so the mode
  // banner can show the right text/buttons without knowing how tracing
  // itself works.
  const [aiTraceStatus, setAiTraceStatus] = useState<AiTraceStatus>({ kind: "idle" });

  useEffect(() => {
    setDeleteArmed(false);
  }, [selectedKey]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([api.getOsmEditorElements(baseUrl, token), api.getOsmEditorTagDefinitions(baseUrl, token)])
      .then(([elementsRes, tagsRes]) => {
        if (cancelled) return;
        setElements(elementsRes.elements);
        setTagDefinitions(tagsRes.definitions);
      })
      .catch((e) => {
        if (!cancelled) setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Failed to load" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token]);

  const selectedElement = useMemo(
    () => elements.find((el) => osmEditorElementKey(el.type, el.id) === selectedKey) ?? null,
    [elements, selectedKey]
  );
  // A local, debounced draft of the selected node/way's tags — see
  // useDebouncedTagsDraft for why this can't just be a straight PATCH per
  // keystroke.
  const [draftTags, setDraftTags] = useDebouncedTagsDraft(
    selectedKey ?? "",
    selectedElement ? tagsRecordToList(selectedElement.tags) : [],
    (tags) => {
      if (selectedElement && selectedElement.type !== "relation") {
        patchElement(selectedElement.type, selectedElement.id, { tags: tagsListToRecord(tags) });
      }
    }
  );
  const dirtyCount = useMemo(() => elements.filter((el) => el.action !== "none").length, [elements]);
  const relations = useMemo(() => elements.filter((el) => el.type === "relation"), [elements]);
  const suggestedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const el of elements) for (const k of Object.keys(el.tags)) keys.add(k);
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [elements]);

  function upsertElement(el: OsmEditorElement) {
    setElements((prev) => {
      const key = osmEditorElementKey(el.type, el.id);
      const idx = prev.findIndex((p) => osmEditorElementKey(p.type, p.id) === key);
      if (idx === -1) return [...prev, el];
      const next = [...prev];
      next[idx] = el;
      return next;
    });
  }

  async function downloadArea(area: Parameters<typeof api.downloadOsmEditorArea>[2]) {
    if (!token) return;
    // Leaves draw mode immediately (rather than waiting for the download to
    // resolve) so the "tap the map…" banner — which sits in the same spot
    // as the busy/status banners and would otherwise hide them — gets out
    // of the way right away instead of appearing stuck for however long the
    // download takes (Overpass can take anywhere from a couple seconds to
    // tens of seconds).
    setMode("view");
    setStatusMessage(null);
    setDownloadElapsedMs(0);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    const startedAt = Date.now();
    setBusy("Downloading from OpenStreetMap…");
    // A single indeterminate spinner gave no sense of whether a slow
    // download was progressing or frozen — Overpass has no real progress
    // API to report against, so this can't be a true percentage bar, but a
    // ticking elapsed-time readout plus a way to bail out is a big step up
    // from nothing moving on screen at all.
    const tick = setInterval(() => setDownloadElapsedMs(Date.now() - startedAt), 500);
    try {
      // Read (not just write) has to match whichever target the upload
      // panel has selected — sandbox and production are separate
      // databases with disjoint element ids/versions, so editing data
      // pulled from one and uploading it to the other would fail on every
      // modify/delete the moment it wasn't a brand-new local creation.
      const storedTarget = await osmTargetStorage.get();
      const target: OsmUploadTarget = storedTarget === "production" ? "production" : "sandbox";
      const result = await api.downloadOsmEditorArea(baseUrl, token, area, target, controller.signal);
      setElements(result.elements);
      setStatusMessage({
        kind: "info",
        text: `Downloaded ${result.downloadedCount} element${result.downloadedCount === 1 ? "" : "s"}${
          result.truncated ? " (area was large — some elements were left out; expand in smaller steps)" : ""
        }.`,
      });
    } catch (e) {
      if (!(e instanceof CancelledError)) {
        setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Download failed" });
      }
    } finally {
      clearInterval(tick);
      downloadAbortRef.current = null;
      setBusy(null);
    }
  }

  function cancelDownload() {
    downloadAbortRef.current?.abort();
  }

  function handleBoundaryFinish(points: { lat: number; lon: number }[]) {
    downloadArea({ kind: "polygon", points });
  }

  async function handleDownloadVisibleArea() {
    const bounds = await mapRef.current?.getViewportBounds();
    if (!bounds) return;
    downloadArea({ kind: "bbox", ...bounds });
  }

  async function handleCreateNode(lat: number, lon: number) {
    if (!token) return;
    try {
      const el = await api.createOsmEditorElement(baseUrl, token, { type: "node", tags: {}, geometry: { lat, lon } });
      upsertElement(el);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not create node" });
    }
  }

  // `closeLoop`: used by the AI building tracer's closed-polygon draft —
  // every point there is brand-new (no existingId), so the way needs its
  // first created node's id repeated at the end to close the ring. Plain
  // manual way-drawing never sets this.
  async function handleWayFinish(points: WayDraftPoint[], closeLoop = false) {
    if (!token) return;
    setMode("view");
    setBusy("Creating way…");
    setStatusMessage(null);
    try {
      const nodeIds: number[] = [];
      for (const p of points) {
        if ("existingId" in p) {
          nodeIds.push(p.existingId);
        } else {
          const node = await api.createOsmEditorElement(baseUrl, token, {
            type: "node",
            tags: {},
            geometry: { lat: p.lat, lon: p.lon },
          });
          upsertElement(node);
          nodeIds.push(node.id);
        }
      }
      if (closeLoop && nodeIds.length >= 3) {
        nodeIds.push(nodeIds[0]);
      }
      const way = await api.createOsmEditorElement(baseUrl, token, { type: "way", tags: {}, geometry: { nodeIds } });
      upsertElement(way);
      setSelectedKey(osmEditorElementKey("way", way.id));
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not create way" });
    } finally {
      setBusy(null);
    }
  }

  async function handleNodeDragEnd(id: number, lat: number, lon: number) {
    if (!token) return;
    try {
      const updated = await api.patchOsmEditorElement(baseUrl, token, "node", id, { geometry: { lat, lon } });
      upsertElement(updated);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not move node" });
    }
  }

  async function patchElement(type: OsmElementType, id: number, patch: { tags?: Record<string, string>; geometry?: OsmEditorGeometry }) {
    if (!token) return;
    try {
      const updated = await api.patchOsmEditorElement(baseUrl, token, type, id, patch);
      upsertElement(updated);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not save" });
    }
  }

  // "Square selection" (JOSM calls this Orthogonalize, its Q shortcut) —
  // snaps the selected way's corners to clean right angles. Only makes
  // sense for a way (a building outline, typically one that was hand-drawn
  // or AI-traced and came out slightly off-rectangular).
  async function handleSquareSelection() {
    if (!token || !selectedElement || selectedElement.type !== "way") return;
    const nodeIds = wayGeometry(selectedElement).nodeIds;
    const nodePositions = nodeIds.map((id) => {
      const node = elements.find((el) => el.type === "node" && el.id === id);
      return node ? nodeGeometry(node) : null;
    });
    if (nodePositions.some((p) => p === null)) {
      setStatusMessage({ kind: "error", text: "Can't square this way — it references a node outside the downloaded area." });
      return;
    }
    const squared = squareWayNodes(nodePositions as { lat: number; lon: number }[]);
    if (!squared) {
      setStatusMessage({ kind: "error", text: "Too few distinct corners to square." });
      return;
    }
    setBusy("Squaring…");
    try {
      // A closed way repeats its first node id as its last — patch each
      // unique node id once, not once per position in the (possibly
      // repeated) node list.
      const seen = new Set<number>();
      for (let i = 0; i < nodeIds.length; i++) {
        const id = nodeIds[i];
        if (seen.has(id)) continue;
        seen.add(id);
        const pos = squared[i];
        const updated = await api.patchOsmEditorElement(baseUrl, token, "node", id, { geometry: pos });
        upsertElement(updated);
      }
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not square selection" });
    } finally {
      setBusy(null);
    }
  }

  // Ctrl+Q (web/desktop only — native's equivalent is the long-press on the
  // square-selection toolbar button below).
  useEffect(() => {
    if (Platform.OS !== "web") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        handleSquareSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedElement, token]);

  async function deleteElement(type: OsmElementType, id: number) {
    if (!token) return;
    try {
      const result = await api.deleteOsmEditorElement(baseUrl, token, type, id);
      if (result.removed) {
        setElements((prev) => prev.filter((el) => !(el.type === type && el.id === id)));
      } else {
        setElements((prev) => prev.map((el) => (el.type === type && el.id === id ? { ...el, action: "delete" } : el)));
      }
      if (osmEditorElementKey(type, id) === selectedKey) setSelectedKey(null);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not delete" });
    }
  }

  async function handleClearWorkingSet() {
    if (!token) return;
    await api.clearOsmEditorWorkingSet(baseUrl, token);
    setElements([]);
    setSelectedKey(null);
    setClearArmed(false);
    setShowImagery(false);
  }

  function toggleMode(next: EditorMode) {
    setMode((cur) => (cur === next ? "view" : next));
    setSelectedKey(null);
    setAiTraceStatus({ kind: "idle" });
  }

  const isAiTraceMode = mode === "ai-trace-building" || mode === "ai-trace-road";
  const aiTraceMessage = isAiTraceMode && aiTraceStatus.kind !== "idle" ? aiTraceStatus.message : null;
  const aiTraceBusy = isAiTraceMode && (aiTraceStatus.kind === "busy" || aiTraceStatus.kind === "loading-model");
  const aiTraceReady = isAiTraceMode && aiTraceStatus.kind === "ready";

  const modeBannerText =
    mode === "draw-boundary"
      ? "Tap the map to add boundary points, then Finish."
      : mode === "new-way"
        ? "Tap existing nodes or empty space to build a way, then Finish."
        : mode === "new-node"
          ? "Tap the map to add nodes."
          : mode === "ai-trace-building"
            ? (aiTraceMessage ?? "Click inside a building's outline (zoom in for best results). Traced automatically with MobileSAM.")
            : mode === "ai-trace-road"
              ? (aiTraceMessage ?? "Click a start point on the road, then more points along it, then Finish.")
              : null;

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <OsmEditorMap
          ref={mapRef}
          elements={elements}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          mode={mode}
          onBoundaryFinish={handleBoundaryFinish}
          onWayFinish={handleWayFinish}
          onCreateNode={handleCreateNode}
          onNodeDragEnd={handleNodeDragEnd}
          onAiTraceStatus={setAiTraceStatus}
          baseLayer={baseLayer}
          showLidar={showLidar}
          lidarOpacity={lidarOpacity}
        />

        {loading ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator />
          </View>
        ) : null}

        {modeBannerText ? (
          <View style={styles.modeBanner}>
            <Text style={styles.modeBannerText}>{modeBannerText}</Text>
            <View style={styles.modeBannerButtons}>
              {mode !== "new-node" && !aiTraceBusy ? (
                <TouchableOpacity
                  onPress={() => {
                    mapRef.current?.finishDraw();
                    if (isAiTraceMode) setAiTraceStatus({ kind: "idle" });
                  }}
                >
                  <Text style={styles.modeBannerFinish}>{aiTraceReady ? "Accept" : "Finish"}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={() => {
                  mapRef.current?.cancelDraw();
                  setMode("view");
                  setAiTraceStatus({ kind: "idle" });
                }}
              >
                <Text style={styles.modeBannerCancel}>{mode === "new-node" ? "Done" : aiTraceReady ? "Discard" : "Cancel"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {mode === "new-way" && Platform.OS !== "web" ? (
          <Text style={styles.nativeWayHint}>Tip: freeform way drawing is easiest on web.</Text>
        ) : null}

        {statusMessage ? (
          <View style={[styles.statusBanner, statusMessage.kind === "error" && styles.statusBannerError]}>
            <Text style={styles.statusBannerText}>{statusMessage.text}</Text>
            <TouchableOpacity onPress={() => setStatusMessage(null)} hitSlop={8}>
              <Text style={styles.statusBannerClose}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {busy ? (
          <View style={styles.busyBanner}>
            <ActivityIndicator size="small" />
            <Text style={[styles.busyText, styles.busyTextFlex]}>
              {busy}
              {downloadAbortRef.current ? ` (${Math.round(downloadElapsedMs / 1000)}s)` : ""}
            </Text>
            {downloadAbortRef.current ? (
              <TouchableOpacity onPress={cancelDownload} hitSlop={8} style={styles.busyCancelButton}>
                <Text style={styles.busyCancelText}>Cancel</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <View style={styles.toolbar}>
          <TouchableOpacity
            style={[styles.toolbarButton, mode === "draw-boundary" && styles.toolbarButtonActive]}
            onPress={() => toggleMode("draw-boundary")}
          >
            <Text style={styles.toolbarButtonText}>{elements.length === 0 ? "Draw boundary" : "Expand selection"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolbarButton} onPress={handleDownloadVisibleArea}>
            <Text style={styles.toolbarButtonText}>Download view</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toolbarButton, mode === "new-node" && styles.toolbarButtonActive]}
            onPress={() => toggleMode("new-node")}
          >
            <Text style={styles.toolbarButtonText}>New node</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toolbarButton, mode === "new-way" && styles.toolbarButtonActive]}
            onPress={() => toggleMode("new-way")}
          >
            <Text style={styles.toolbarButtonText}>New way</Text>
          </TouchableOpacity>
          {/* AI-assisted tracing — web only (Leaflet + onnxruntime-web +
              canvas pixel access), same web/native asymmetry as the native
              hint below for freeform way drawing. */}
          {Platform.OS === "web" ? (
            <TouchableOpacity
              style={[styles.toolbarButton, mode === "ai-trace-building" && styles.toolbarButtonActive]}
              onPress={() => toggleMode("ai-trace-building")}
            >
              <Text style={styles.toolbarButtonText}>AI trace: building</Text>
            </TouchableOpacity>
          ) : null}
          {Platform.OS === "web" ? (
            <TouchableOpacity
              style={[styles.toolbarButton, mode === "ai-trace-road" && styles.toolbarButtonActive]}
              onPress={() => toggleMode("ai-trace-road")}
            >
              <Text style={styles.toolbarButtonText}>AI trace: road</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.toolbarButton} onPress={() => setShowRelations(true)}>
            <Text style={styles.toolbarButtonText}>Relations ({relations.length})</Text>
          </TouchableOpacity>
          {/* Square selection (JOSM's Orthogonalize) — snaps the selected
              way's corners to right angles. Hold rather than tap, so a
              stray touch doesn't reshape a building; Ctrl+Q does the same
              thing on web/desktop (see the keydown listener above). */}
          <TouchableOpacity
            style={[styles.toolbarButton, !selectedElement || selectedElement.type !== "way" ? styles.toolbarButtonDisabled : null]}
            onPress={() => setStatusMessage({ kind: "info", text: "Hold this button to square the selected way (or press Ctrl+Q)." })}
            onLongPress={handleSquareSelection}
            delayLongPress={500}
          >
            <Text style={styles.toolbarButtonText}>⚙️ Square</Text>
          </TouchableOpacity>
          {/* Same clear-the-working-set action already in the imagery panel
              (🗺️) — also here in the main toolbar since that's the more
              obvious place to look for it. Shares clearArmed/
              handleClearWorkingSet so either button's confirm step covers
              the other too. */}
          <TouchableOpacity
            style={[styles.toolbarButton, clearArmed && styles.toolbarButtonDanger]}
            onPress={() => (clearArmed ? handleClearWorkingSet() : setClearArmed(true))}
            onBlur={() => setClearArmed(false)}
          >
            <Text style={[styles.toolbarButtonText, clearArmed && styles.toolbarButtonDangerText]}>
              {clearArmed ? "Tap again to confirm" : "🗑️ Clear data"}
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.imageryButton} onPress={() => setShowImagery(true)}>
          <Text style={styles.imageryButtonText}>🗺️</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.uploadFab} onPress={() => setShowUpload(true)}>
          <Text style={styles.uploadFabText}>⬆{dirtyCount > 0 ? ` ${dirtyCount}` : ""}</Text>
        </TouchableOpacity>
      </View>

      {/* Node/way detail panel */}
      <Modal
        visible={Boolean(selectedElement) && selectedElement?.type !== "relation"}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedKey(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            {selectedElement ? (
              <ScrollView>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>
                    {selectedElement.type} #{selectedElement.id}
                  </Text>
                  <TouchableOpacity onPress={() => setSelectedKey(null)} hitSlop={8}>
                    <Text style={styles.closeIcon}>✕</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.actionBadge}>{selectedElement.action === "none" ? "unchanged" : selectedElement.action}</Text>

                <TagsEditor
                  tags={draftTags}
                  onChange={setDraftTags}
                  suggestedKeys={suggestedKeys}
                  tagDefinitions={tagDefinitions}
                />

                <TouchableOpacity
                  style={[styles.deleteButton, deleteArmed && styles.deleteButtonArmed]}
                  onPress={() => {
                    if (deleteArmed) {
                      deleteElement(selectedElement.type, selectedElement.id);
                    } else {
                      setDeleteArmed(true);
                    }
                  }}
                >
                  <Text style={styles.deleteButtonText}>{deleteArmed ? "Tap again to confirm delete" : "Delete"}</Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Relation editor */}
      <Modal
        visible={Boolean(selectedElement) && selectedElement?.type === "relation"}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedKey(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            {selectedElement && selectedElement.type === "relation" ? (
              <RelationEditor
                relation={selectedElement}
                allElements={elements}
                tagDefinitions={tagDefinitions}
                suggestedKeys={suggestedKeys}
                onPatch={(patch) => patchElement("relation", selectedElement.id, patch)}
                onDelete={() => deleteElement("relation", selectedElement.id)}
                onClose={() => setSelectedKey(null)}
              />
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Relations list */}
      <Modal visible={showRelations} transparent animationType="fade" onRequestClose={() => setShowRelations(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Relations</Text>
              <TouchableOpacity onPress={() => setShowRelations(false)} hitSlop={8}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.relationsList}>
              {relations.length === 0 ? <Text style={styles.emptyText}>No relations downloaded or created yet.</Text> : null}
              {relations.map((r) => (
                <TouchableOpacity
                  key={osmEditorElementKey("relation", r.id)}
                  style={styles.relationRow}
                  onPress={() => {
                    setSelectedKey(osmEditorElementKey("relation", r.id));
                    setShowRelations(false);
                  }}
                >
                  <Text style={styles.relationRowText}>
                    #{r.id} — {elementDisplayName(r)}
                  </Text>
                  <Text style={styles.relationRowAction}>{r.action === "none" ? "" : r.action}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.newRelationButton}
              onPress={async () => {
                if (!token) return;
                const el = await api.createOsmEditorElement(baseUrl, token, { type: "relation", tags: {}, geometry: { members: [] } });
                upsertElement(el);
                setShowRelations(false);
                setSelectedKey(osmEditorElementKey("relation", el.id));
              }}
            >
              <Text style={styles.newRelationButtonText}>+ New relation</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Imagery picker */}
      <Modal visible={showImagery} transparent animationType="fade" onRequestClose={() => setShowImagery(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Imagery</Text>
              <TouchableOpacity onPress={() => setShowImagery(false)} hitSlop={8}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.imageryRow} onPress={() => setBaseLayer("osm")}>
              <View style={[styles.radio, baseLayer === "osm" && styles.radioSelected]} />
              <Text style={styles.imageryLabel}>OpenStreetMap</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.imageryRow} onPress={() => setBaseLayer("satellite")}>
              <View style={[styles.radio, baseLayer === "satellite" && styles.radioSelected]} />
              <Text style={styles.imageryLabel}>Esri satellite imagery</Text>
            </TouchableOpacity>
            {Platform.OS === "web" ? (
              <TouchableOpacity
                style={styles.imageryRow}
                disabled={!isBingConfigured()}
                onPress={() => setBaseLayer("bing")}
              >
                <View style={[styles.radio, baseLayer === "bing" && styles.radioSelected, !isBingConfigured() && styles.radioDisabled]} />
                <View style={styles.imageryLabelCol}>
                  <Text style={[styles.imageryLabel, !isBingConfigured() && styles.imageryLabelDisabled]}>Bing aerial imagery</Text>
                  {!isBingConfigured() ? (
                    <Text style={styles.imageryHint}>Add a Bing Maps API key (EXPO_PUBLIC_BING_MAPS_KEY) to enable</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            ) : null}

            <View style={styles.lidarRow}>
              <Text style={styles.imageryLabel}>Lidar hillshade overlay</Text>
              <Switch value={showLidar} onValueChange={setShowLidar} />
            </View>
            {showLidar ? (
              <View style={styles.lidarOpacityRow}>
                <Text style={styles.imageryHint}>Opacity</Text>
                <Slider
                  style={styles.lidarOpacitySlider}
                  minimumValue={0.1}
                  maximumValue={1}
                  value={lidarOpacity}
                  onValueChange={setLidarOpacity}
                  minimumTrackTintColor="#2980b9"
                />
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.clearButton, clearArmed && styles.clearButtonArmed]}
              onPress={() => (clearArmed ? handleClearWorkingSet() : setClearArmed(true))}
              onBlur={() => setClearArmed(false)}
            >
              <Text style={styles.clearButtonText}>
                {clearArmed ? "Tap again to confirm — clears all local edits" : "Clear working set (start over)"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Upload panel */}
      <Modal visible={showUpload} transparent animationType="fade" onRequestClose={() => setShowUpload(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <OsmUploadPanel
              dirtyCount={dirtyCount}
              onClose={() => setShowUpload(false)}
              onUploaded={async () => {
                if (!token) return;
                const res = await api.getOsmEditorElements(baseUrl, token);
                setElements(res.elements);
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapWrap: { flex: 1 },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 900,
  },
  modeBanner: {
    position: "absolute",
    top: 12,
    left: 12,
    // Stops short of the imagery button (right:16, 44px wide, same top) so
    // its Finish/Cancel/Done text never sits underneath that opaque
    // circle — confirmed by hand that a plain right:12 here let the button
    // visually and click-wise cover them entirely.
    right: 68,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    elevation: 4,
    zIndex: 1000,
  },
  modeBannerText: { fontFamily: fonts.medium, fontSize: 12, color: "#222", flex: 1, marginRight: 8 },
  modeBannerButtons: { flexDirection: "row", gap: 14 },
  modeBannerFinish: { fontFamily: fonts.semiBold, fontSize: 13, color: "#2980b9" },
  modeBannerCancel: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  nativeWayHint: {
    position: "absolute",
    top: 60,
    left: 12,
    right: 12,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: "#888",
    textAlign: "center",
    zIndex: 1000,
  },
  statusBanner: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 68, // clears the imagery button — see modeBanner's comment
    backgroundColor: "#eaf4ea",
    borderRadius: 10,
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    elevation: 4,
    zIndex: 999,
  },
  statusBannerError: { backgroundColor: "#fdecea" },
  statusBannerText: { fontFamily: fonts.regular, fontSize: 12, color: "#333", flex: 1, marginRight: 8 },
  statusBannerClose: { fontFamily: fonts.medium, fontSize: 13, color: "#888" },
  busyBanner: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 68, // clears the imagery button — see modeBanner's comment
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    elevation: 4,
    zIndex: 1000,
  },
  busyText: { fontFamily: fonts.regular, fontSize: 12, color: "#444" },
  busyTextFlex: { flex: 1 },
  busyCancelButton: { paddingHorizontal: 8, paddingVertical: 4 },
  busyCancelText: { fontFamily: fonts.medium, fontSize: 12, color: "#c0392b" },
  toolbar: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 16,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    elevation: 4,
    zIndex: 1000,
  },
  toolbarButton: { backgroundColor: "#f0f0f0", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  toolbarButtonActive: { backgroundColor: "#2980b9" },
  toolbarButtonDisabled: { opacity: 0.5 },
  toolbarButtonDanger: { backgroundColor: "#fdecea" },
  toolbarButtonDangerText: { color: "#c0392b" },
  toolbarButtonText: { fontFamily: fonts.medium, fontSize: 12, color: "#333" },
  imageryButton: {
    position: "absolute",
    right: 16,
    top: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    zIndex: 1000,
  },
  imageryButtonText: { fontSize: 20 },
  uploadFab: {
    position: "absolute",
    right: 16,
    bottom: 80,
    minWidth: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#27ae60",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 10,
    elevation: 4,
    zIndex: 1000,
  },
  uploadFabText: { color: "#fff", fontSize: 18, fontFamily: fonts.semiBold },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 0, width: 360, maxWidth: "92%", maxHeight: "85%" },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    paddingBottom: 8,
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222" },
  closeIcon: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  actionBadge: { fontFamily: fonts.regular, fontSize: 11, color: "#888", paddingHorizontal: 16, marginBottom: 8 },
  deleteButton: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#c0392b",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  deleteButtonArmed: { backgroundColor: "#c0392b" },
  deleteButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  relationsList: { maxHeight: 320, paddingHorizontal: 16 },
  emptyText: { fontFamily: fonts.regular, fontSize: 12, color: "#999", paddingVertical: 12 },
  relationRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  relationRowText: { fontFamily: fonts.regular, fontSize: 13, color: "#333", flex: 1 },
  relationRowAction: { fontFamily: fonts.medium, fontSize: 11, color: "#e67e22" },
  newRelationButton: { padding: 16 },
  newRelationButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  imageryRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: "#bbb" },
  radioSelected: { borderColor: "#2980b9", backgroundColor: "#2980b9" },
  radioDisabled: { borderColor: "#ddd" },
  imageryLabelCol: { flex: 1 },
  imageryLabel: { fontFamily: fonts.regular, fontSize: 13, color: "#333" },
  imageryLabelDisabled: { color: "#aaa" },
  imageryHint: { fontFamily: fonts.regular, fontSize: 10, color: "#aaa", marginTop: 2 },
  lidarRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 4,
  },
  lidarOpacityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  lidarOpacitySlider: { flex: 1, height: 32 },
  clearButton: {
    marginHorizontal: 16,
    marginVertical: 16,
    borderWidth: 1,
    borderColor: "#c0392b",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  clearButtonArmed: { backgroundColor: "#fdecea" },
  clearButtonText: { fontFamily: fonts.medium, fontSize: 12, color: "#c0392b", textAlign: "center" },
});
