import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import Slider from "@react-native-community/slider";
import OsmEditorMap, {
  type EditorBaseLayer,
  type EditorMode,
  type OsmEditorMapHandle,
  type WayDraftPoint,
  type WayHookTarget,
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
import { jlosmeSavedRedrawIdsStorage } from "../storage";
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

// One parked "Save ID" entry (see savedRedrawIds below). Way-only fields:
// nodeSnapshot is the original constituent nodes' positions (in order,
// deduplicated) for the ghost-guide overlay shown while redrawing, and
// exclusiveNodeIds is the subset of those not shared with any other way
// still in the working set — those are the ones actually hidden/parked
// alongside the way itself. A shared node (a road intersection, say) is
// deliberately left off both: it stays visible and tappable so redrawing
// one of the two ways can reconnect to it normally, the same as any other
// existing node.
type SavedRedrawRecord = {
  type: "node" | "way";
  id: number;
  label: string;
  // Each snapshot entry carries its own tags too — a tagged one (a stop
  // sign, a hydrant riding along the way) gets highlighted in the
  // ghost-guide overlay and can be reattached to a newly drawn point
  // instead of just being deleted with the rest of the old geometry (see
  // OsmEditorMap's redrawGuide/reattachId and handleWayFinish below).
  nodeSnapshot?: { id: number; lat: number; lon: number; tags: Record<string, string> }[];
  exclusiveNodeIds?: number[];
};

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
  // Every element a click/tap landed near, nearest first (see
  // OsmEditorMap.web.tsx's selectAt) — lets the detail panel offer cycling
  // through close-together or directly overlapping features (e.g. two
  // areas tagged over the same spot) instead of only ever reaching
  // whichever one happened to render on top. selectedKey is always
  // selectionCandidates[selectionIndex] while candidates exist.
  const [selectionCandidates, setSelectionCandidates] = useState<string[]>([]);
  const [selectionIndex, setSelectionIndex] = useState(0);
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
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  // Popup from holding the toolbar's "+" button — lets it jump straight
  // into the explicit "new-node"/"new-way" modes instead of the unified
  // "add" mode's single-tap-then-decide flow (see toggleMode/handleAddPress
  // below and EditorMode's own comment in OsmEditorMap).
  const [showAddMenu, setShowAddMenu] = useState(false);
  // Progress/state for the two AI-assisted tracing tools (see
  // aiTraceTypes.ts) — OsmEditorMap.web.tsx reports into this so the mode
  // banner can show the right text/buttons without knowing how tracing
  // itself works.
  const [aiTraceStatus, setAiTraceStatus] = useState<AiTraceStatus>({ kind: "idle" });

  // A way/node whose geometry was too far gone to nudge back into shape —
  // "Save ID" (in its detail panel) parks its real id/type here and hides
  // it from the map, so you can draw an entirely fresh shape and reattach
  // it to that same id (a modify) instead of delete-then-recreate, which
  // would break its OSM edit history (see osmEditorUpload.ts). Persisted
  // so a parked id survives a restart before it's redrawn.
  const [savedRedrawIds, setSavedRedrawIds] = useState<SavedRedrawRecord[]>([]);
  // The one entry from the list above currently "loaded" — the next
  // new-node placement or new-way finish (including any AI trace tool,
  // since they all funnel through the same finish handlers) re-attaches to
  // this id instead of creating a new element.
  const [armedRedrawId, setArmedRedrawId] = useState<{ type: "node" | "way"; id: number } | null>(null);
  const [showSavedIds, setShowSavedIds] = useState(false);

  useEffect(() => {
    jlosmeSavedRedrawIdsStorage.get().then((raw) => {
      if (!raw) return;
      try {
        setSavedRedrawIds(JSON.parse(raw));
      } catch {
        // Ignore corrupt/old-shape storage — starts empty rather than crashing.
      }
    });
  }, []);
  useEffect(() => {
    jlosmeSavedRedrawIdsStorage.set(JSON.stringify(savedRedrawIds));
  }, [savedRedrawIds]);

  // Every element key currently hidden from the map — each saved way/node
  // itself, plus (for a saved way) any exclusiveNodeIds it parked alongside
  // it. A node shared with another still-visible way is never in here.
  const hiddenElementKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of savedRedrawIds) {
      keys.add(osmEditorElementKey(r.type, r.id));
      for (const nid of r.exclusiveNodeIds ?? []) keys.add(osmEditorElementKey("node", nid));
    }
    return keys;
  }, [savedRedrawIds]);
  // What the map actually renders — a saved-for-redraw element (and its
  // parked exclusive sub-nodes) stay in `elements` (their real ids/
  // versions/tags are still needed to reattach the redrawn geometry later,
  // or to just un-park them again) but disappear from the map itself,
  // which is the whole point: a clean slate to draw the replacement into.
  const mapElements = useMemo(
    () => elements.filter((el) => !hiddenElementKeys.has(osmEditorElementKey(el.type, el.id))),
    [elements, hiddenElementKeys]
  );
  // The armed entry's full record (not just its type/id) — looked up
  // freshly rather than carried on armedRedrawId itself so its
  // nodeSnapshot/exclusiveNodeIds are always current with savedRedrawIds.
  const armedRedrawRecord = useMemo(
    () => (armedRedrawId ? (savedRedrawIds.find((r) => r.type === armedRedrawId.type && r.id === armedRedrawId.id) ?? null) : null),
    [armedRedrawId, savedRedrawIds]
  );
  // Ghost markers at the original way's node positions, shown while a way
  // redraw is armed — a visual reference so the new taps can naturally line
  // up with the old layout (the first new node landing back where the first
  // old one was, etc.) rather than any literal auto-snapping.
  const redrawGuide = armedRedrawRecord?.nodeSnapshot ?? null;

  useEffect(() => {
    setDeleteArmed(false);
  }, [selectedKey]);

  // Any mode change dismisses the "+" quick menu — the escape hatch for
  // opening it by accident, since there's no dedicated close button.
  useEffect(() => {
    setShowAddMenu(false);
  }, [mode]);

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

  // Selects exactly one known element (a fresh selection — a newly created
  // way, a relation picked from its own list, or a full deselect) and
  // drops any leftover candidate list from a previous ambiguous click.
  function selectSingle(key: string | null) {
    setSelectedKey(key);
    setSelectionCandidates([]);
    setSelectionIndex(0);
  }

  // The map's click-candidate callback — keys are nearest-to-the-click
  // first; the closest one is selected immediately, with the rest (if any)
  // available via the cycle arrows in the detail panel.
  function handleSelectCandidates(keys: string[]) {
    if (keys.length === 0) {
      selectSingle(null);
      return;
    }
    setSelectionCandidates(keys);
    setSelectionIndex(0);
    setSelectedKey(keys[0]);
  }

  function cycleSelection(delta: number) {
    if (selectionCandidates.length < 2) return;
    const next = (selectionIndex + delta + selectionCandidates.length) % selectionCandidates.length;
    setSelectionIndex(next);
    setSelectedKey(selectionCandidates[next]);
  }

  // Parks the selected way/node's real id for a later redraw (see
  // savedRedrawIds above) and closes its panel — the element itself stays
  // in `elements` untouched (mapElements is what hides it), so its tags
  // and version are still there to reattach fresh geometry to once redrawn.
  function saveIdForRedraw() {
    if (!selectedElement || selectedElement.type === "relation") return;
    // Captured as locals (not a live property access) so the closure below
    // keeps TypeScript's narrowing of type to "node" | "way".
    const { type, id } = selectedElement;
    const label = elementDisplayName(selectedElement);
    let nodeSnapshot: SavedRedrawRecord["nodeSnapshot"];
    let exclusiveNodeIds: SavedRedrawRecord["exclusiveNodeIds"];
    if (type === "way") {
      const uniqueNodeIds = [...new Set(wayGeometry(selectedElement).nodeIds)];
      // A node this way shares with another way still in the working set
      // (a road intersection, a stop sign's node, etc.) must stay put and
      // tappable — only nodes exclusive to this way get parked with it.
      const sharedWithOtherWay = new Set<number>();
      for (const el of elements) {
        if (el.type !== "way" || el.id === id) continue;
        for (const nid of wayGeometry(el).nodeIds) sharedWithOtherWay.add(nid);
      }
      nodeSnapshot = [];
      exclusiveNodeIds = [];
      for (const nid of uniqueNodeIds) {
        const node = elements.find((el) => el.type === "node" && el.id === nid);
        if (node) nodeSnapshot.push({ id: nid, ...nodeGeometry(node), tags: node.tags });
        if (!sharedWithOtherWay.has(nid)) exclusiveNodeIds.push(nid);
      }
    }
    setSavedRedrawIds((prev) => [...prev, { type, id, label, nodeSnapshot, exclusiveNodeIds }]);
    selectSingle(null);
  }

  // Un-hides a saved id without redrawing it — back to normal, still on
  // the map, no longer parked.
  function restoreSavedRedrawId(rec: { type: "node" | "way"; id: number }) {
    setSavedRedrawIds((prev) => prev.filter((r) => !(r.type === rec.type && r.id === rec.id)));
    if (armedRedrawId && armedRedrawId.type === rec.type && armedRedrawId.id === rec.id) setArmedRedrawId(null);
  }

  // "Loads" a saved id as the target for the next new-node placement or
  // new-way finish, and jumps straight into the matching draw tool.
  function armSavedRedrawId(rec: { type: "node" | "way"; id: number }) {
    setArmedRedrawId(rec);
    setShowSavedIds(false);
    setMode(rec.type === "node" ? "new-node" : "new-way");
  }

  // Called once a redraw's new geometry has actually been attached to the
  // parked id (see handleCreateNode/handleWayFinish) — removes it from the
  // saved list entirely, since it's no longer parked, it's just that
  // element again with new geometry.
  function consumeArmedRedraw() {
    if (!armedRedrawId) return;
    const { type, id } = armedRedrawId;
    setSavedRedrawIds((prev) => prev.filter((r) => !(r.type === type && r.id === id)));
    setArmedRedrawId(null);
  }

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

  async function handleCreateNode(lat: number, lon: number, hook?: WayHookTarget) {
    if (!token) return;
    try {
      // A redraw is loaded (see armSavedRedrawId) — reattach this new
      // position to the parked id (a modify of the same real node) instead
      // of creating a brand-new one, so its OSM history stays continuous.
      if (armedRedrawId && armedRedrawId.type === "node") {
        const updated = await api.patchOsmEditorElement(baseUrl, token, "node", armedRedrawId.id, { geometry: { lat, lon } });
        upsertElement(updated);
        selectSingle(osmEditorElementKey("node", armedRedrawId.id));
        consumeArmedRedraw();
        return;
      }
      const el = await api.createOsmEditorElement(baseUrl, token, { type: "node", tags: {}, geometry: { lat, lon } });
      upsertElement(el);
      if (hook) await hookNodeIntoWay(hook, el.id);
      // The unified "+" mode places a single pending point and commits it
      // as a standalone node once finished — unlike the explicit
      // "new-node" mode (repeat taps, stays active until Done), placing
      // one node here is the whole job, so drop back to view.
      setMode((m) => (m === "add" ? "view" : m));
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not create node" });
    }
  }

  // Splices a newly placed node into an existing way's line — "hooking" a
  // new point onto a way (a stop sign, a driveway, a branching path) at a
  // precise spot along it, without needing to redraw the whole way. Finds
  // the same two original neighbor node ids the tap snapped between (see
  // WayHookTarget), not a raw array index, which the insertion would shift,
  // so this stays correct however many other edits have happened since.
  async function hookNodeIntoWay(hook: WayHookTarget, newNodeId: number) {
    if (!token) return;
    const way = elements.find((el) => el.type === "way" && el.id === hook.wayId);
    if (!way) return;
    const nodeIds = wayGeometry(way).nodeIds;
    const idx = nodeIds.findIndex((id, i) => id === hook.nodeIdA && nodeIds[i + 1] === hook.nodeIdB);
    if (idx === -1) return; // the way's geometry moved on since the hook was found — skip rather than corrupt it
    const nextNodeIds = [...nodeIds.slice(0, idx + 1), newNodeId, ...nodeIds.slice(idx + 1)];
    const updatedWay = await api.patchOsmEditorElement(baseUrl, token, "way", hook.wayId, { geometry: { nodeIds: nextNodeIds } });
    upsertElement(updatedWay);
  }

  // `closeLoop`: used by the AI building tracer's closed-polygon draft —
  // every point there is brand-new (no existingId), so the way needs its
  // first created node's id repeated at the end to close the ring. Plain
  // manual way-drawing never sets this.
  async function handleWayFinish(points: WayDraftPoint[], closeLoop = false) {
    if (!token) return;
    const redrawingWay = armedRedrawId && armedRedrawId.type === "way" ? armedRedrawId : null;
    setMode("view");
    setBusy(redrawingWay ? "Redrawing way…" : "Creating way…");
    setStatusMessage(null);
    try {
      const nodeIds: number[] = [];
      // Tagged sub-nodes (a stop sign, a hydrant) the user tapped on the
      // ghost-guide overlay to keep — reattached below rather than
      // deleted along with the rest of the way's old, now-orphaned nodes.
      const reattachedNodeIds = new Set<number>();
      // Local working copies of any way this draw hooks a new point into
      // (see WayHookTarget) — several points can hook into the same way,
      // each needing to see the previous one's insertion well before any
      // of it reaches component state, so every hooked way is patched
      // once at the end instead of mid-loop.
      const hookedWayNodeIds = new Map<number, number[]>();
      function workingNodeIds(wayId: number): number[] {
        if (!hookedWayNodeIds.has(wayId)) {
          const way = elements.find((el) => el.type === "way" && el.id === wayId);
          hookedWayNodeIds.set(wayId, way ? [...wayGeometry(way).nodeIds] : []);
        }
        return hookedWayNodeIds.get(wayId)!;
      }
      for (const p of points) {
        if ("existingId" in p) {
          nodeIds.push(p.existingId);
        } else if ("reattachId" in p) {
          const node = await api.patchOsmEditorElement(baseUrl, token, "node", p.reattachId, { geometry: { lat: p.lat, lon: p.lon } });
          upsertElement(node);
          nodeIds.push(node.id);
          reattachedNodeIds.add(p.reattachId);
        } else {
          const node = await api.createOsmEditorElement(baseUrl, token, {
            type: "node",
            tags: {},
            geometry: { lat: p.lat, lon: p.lon },
          });
          upsertElement(node);
          nodeIds.push(node.id);
          if (p.hook) {
            const list = workingNodeIds(p.hook.wayId);
            const idx = list.findIndex((id, i) => id === p.hook!.nodeIdA && list[i + 1] === p.hook!.nodeIdB);
            if (idx !== -1) list.splice(idx + 1, 0, node.id);
          }
        }
      }
      if (closeLoop && nodeIds.length >= 3) {
        nodeIds.push(nodeIds[0]);
      }
      for (const [wayId, finalNodeIds] of hookedWayNodeIds) {
        const updatedWay = await api.patchOsmEditorElement(baseUrl, token, "way", wayId, { geometry: { nodeIds: finalNodeIds } });
        upsertElement(updatedWay);
      }
      // The new nodes are genuinely new either way — only the *way's own*
      // identity carries forward from the parked id when redrawing.
      if (redrawingWay) {
        const updated = await api.patchOsmEditorElement(baseUrl, token, "way", redrawingWay.id, { geometry: { nodeIds } });
        upsertElement(updated);
        selectSingle(osmEditorElementKey("way", redrawingWay.id));
        const orphanedNodeIds = (armedRedrawRecord?.exclusiveNodeIds ?? []).filter((nid) => !reattachedNodeIds.has(nid));
        consumeArmedRedraw();
        // The way's old exclusive sub-nodes (parked alongside it, see
        // saveIdForRedraw) were only hidden in case the redraw got
        // cancelled — now that it's actually gone through, the way no
        // longer references them at all, so they're genuinely orphaned and
        // can be deleted for real rather than left as invisible clutter.
        // A tagged one the user chose to reattach (above) is excluded —
        // it's still in use, just at its new spot on the redrawn way.
        for (const nid of orphanedNodeIds) {
          await deleteElement("node", nid);
        }
        return;
      }
      const way = await api.createOsmEditorElement(baseUrl, token, { type: "way", tags: {}, geometry: { nodeIds } });
      upsertElement(way);
      selectSingle(osmEditorElementKey("way", way.id));
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
      if (osmEditorElementKey(type, id) === selectedKey) selectSingle(null);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not delete" });
    }
  }

  async function handleClearWorkingSet() {
    if (!token) return;
    await api.clearOsmEditorWorkingSet(baseUrl, token);
    setElements([]);
    selectSingle(null);
    setClearArmed(false);
    setShowImagery(false);
    // Any parked id would now point at data that's no longer in the local
    // working set (or on the server, if it hadn't been uploaded yet).
    setSavedRedrawIds([]);
    setArmedRedrawId(null);
  }

  function toggleMode(next: EditorMode) {
    setMode((cur) => (cur === next ? "view" : next));
    selectSingle(null);
    setAiTraceStatus({ kind: "idle" });
  }

  // The toolbar's single "+" button: not already adding → arm the unified
  // "add" mode (tap the map for a pending point). Already in it → the
  // button now means "finish" — commits whatever's pending as a node (one
  // point) or a way (two or more), same as the mode banner's own Finish.
  function handleAddPress() {
    if (mode === "add") {
      mapRef.current?.finishDraw();
    } else {
      toggleMode("add");
    }
  }

  const isAiTraceMode = mode === "ai-trace-building" || mode === "ai-trace-road" || mode === "ai-trace-stream";
  const aiTraceMessage = isAiTraceMode && aiTraceStatus.kind !== "idle" ? aiTraceStatus.message : null;
  const aiTraceBusy = isAiTraceMode && (aiTraceStatus.kind === "busy" || aiTraceStatus.kind === "loading-model");
  const aiTraceReady = isAiTraceMode && aiTraceStatus.kind === "ready";

  const hasTaggedGuide = (redrawGuide ?? []).some((p) => Object.keys(p.tags).length > 0);
  const redrawSuffix = armedRedrawId
    ? ` Redrawing ${armedRedrawId.type} #${armedRedrawId.id} — this becomes its new shape.${
        hasTaggedGuide ? " Tap a red guide marker to keep that spot's own id/tags." : ""
      }`
    : "";
  const modeBannerText =
    mode === "draw-boundary"
      ? "Tap the map to add boundary points, then Finish."
      : mode === "add"
        ? "Tap the map to place a point — near an existing way hooks onto it. Tap + again to keep just that one node, or keep tapping to build a way — tap its highlighted starting point to close it into an area."
        : mode === "new-way"
          ? `Tap existing nodes, or near a way's line to hook onto it, or empty space to build a way, then Finish. Tap its highlighted starting point to close it into an area.${redrawSuffix}`
          : mode === "new-node"
            ? `Tap the map to add nodes — near an existing way hooks onto it.${redrawSuffix}`
            : mode === "ai-trace-building"
              ? (aiTraceMessage ?? "Click inside a building's outline (zoom in for best results). Traced automatically with MobileSAM.")
              : mode === "ai-trace-road"
                ? (aiTraceMessage ?? "Click a start point on the road, then more points along it, then Finish.")
                : mode === "ai-trace-stream"
                  ? (aiTraceMessage ?? "Click a start point on the stream, then more points along it, then Finish. Uses lidar only — satellite can't see through tree canopy.")
                  : null;

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <OsmEditorMap
          ref={mapRef}
          elements={mapElements}
          selectedKey={selectedKey}
          onSelectCandidates={handleSelectCandidates}
          mode={mode}
          onBoundaryFinish={handleBoundaryFinish}
          onWayFinish={handleWayFinish}
          onCreateNode={handleCreateNode}
          onNodeDragEnd={handleNodeDragEnd}
          onAiTraceStatus={setAiTraceStatus}
          baseLayer={baseLayer}
          showLidar={showLidar}
          lidarOpacity={lidarOpacity}
          redrawGuide={redrawGuide}
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
                  // Un-arms without un-parking — the id stays in the saved
                  // list, ready to arm again later from the gear menu.
                  setArmedRedrawId(null);
                }}
              >
                <Text style={styles.modeBannerCancel}>{mode === "new-node" ? "Done" : aiTraceReady ? "Discard" : "Cancel"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {(mode === "new-way" || mode === "add") && Platform.OS !== "web" ? (
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
          {/* Single add button: tap places a point, tap again to keep it
              as one node or keep tapping to grow it into a way/area (see
              handleAddPress/EditorMode's "add"). Hold it for a quick menu
              straight into the explicit node-only/way-only modes. */}
          <TouchableOpacity
            style={[
              styles.toolbarButton,
              styles.addButton,
              (mode === "add" || mode === "new-node" || mode === "new-way") && styles.toolbarButtonActive,
            ]}
            onPress={handleAddPress}
            onLongPress={() => setShowAddMenu(true)}
            delayLongPress={400}
          >
            <Text
              style={[
                styles.toolbarButtonText,
                styles.addButtonText,
                (mode === "add" || mode === "new-node" || mode === "new-way") && styles.toolbarButtonTextActive,
              ]}
            >
              +
            </Text>
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
          {/* Same tracer as "AI trace: road" but lidar-only — most stream
              channels are under tree canopy, invisible to satellite
              imagery (worse, canopy texture actively misleads the edge
              detector there), while lidar sees the drainage relief
              regardless of tree cover. See roadTrace.ts's TraceSources. */}
          {Platform.OS === "web" ? (
            <TouchableOpacity
              style={[styles.toolbarButton, mode === "ai-trace-stream" && styles.toolbarButtonActive]}
              onPress={() => toggleMode("ai-trace-stream")}
            >
              <Text style={styles.toolbarButtonText}>AI trace: stream</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.toolbarButton} onPress={() => setShowRelations(true)}>
            <Text style={styles.toolbarButtonText}>Relations ({relations.length})</Text>
          </TouchableOpacity>
          {/* Square selection and Clear data both live under this gear menu
              rather than as their own toolbar buttons — less-used/riskier
              actions tucked behind one tap instead of crowding the row. */}
          <TouchableOpacity
            style={[styles.toolbarButton, showToolsMenu && styles.toolbarButtonActive]}
            onPress={() => setShowToolsMenu((v) => !v)}
          >
            <Text style={[styles.toolbarButtonText, showToolsMenu && styles.toolbarButtonTextActive]}>⚙️</Text>
          </TouchableOpacity>
        </View>

        {/* Holding "+" gives direct access to the explicit modes it
            otherwise merges away — "new-node" for repeated standalone taps,
            "new-way" to start the multi-tap way/area flow immediately
            without the single-tap-then-decide ambiguity. */}
        {showAddMenu ? (
          <View style={styles.addMenu}>
            <TouchableOpacity
              style={styles.toolsMenuItem}
              onPress={() => {
                toggleMode("new-node");
                setShowAddMenu(false);
              }}
            >
              <Text style={styles.toolsMenuItemText}>📍 Add node</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.toolsMenuItem}
              onPress={() => {
                toggleMode("new-way");
                setShowAddMenu(false);
              }}
            >
              <Text style={styles.toolsMenuItemText}>🛣️ Add way / area</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {showToolsMenu ? (
          <View style={styles.toolsMenu}>
            {/* Square selection (JOSM's Orthogonalize) — snaps the selected
                way's corners to right angles. Hold rather than tap, so a
                stray touch doesn't reshape a building; Ctrl+Q does the same
                thing on web/desktop (see the keydown listener above). */}
            <TouchableOpacity
              style={[styles.toolsMenuItem, (!selectedElement || selectedElement.type !== "way") && styles.toolbarButtonDisabled]}
              onPress={() => setStatusMessage({ kind: "info", text: "Hold this row to square the selected way (or press Ctrl+Q)." })}
              onLongPress={() => {
                handleSquareSelection();
                setShowToolsMenu(false);
              }}
              delayLongPress={500}
            >
              <Text style={styles.toolsMenuItemText}>Square selection (hold)</Text>
            </TouchableOpacity>
            {/* Same clear-the-working-set action as the imagery panel's
                (🗺️) own copy — shares clearArmed/handleClearWorkingSet so
                either one's confirm step covers the other too. */}
            <TouchableOpacity
              style={styles.toolsMenuItem}
              onPress={() => {
                if (clearArmed) {
                  handleClearWorkingSet();
                  setShowToolsMenu(false);
                } else {
                  setClearArmed(true);
                }
              }}
              onBlur={() => setClearArmed(false)}
            >
              <Text style={[styles.toolsMenuItemText, clearArmed && styles.toolbarButtonDangerText]}>
                {clearArmed ? "Tap again to confirm — clears local edits only, not OSM" : "🗑️ Clear data"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.toolsMenuItem}
              onPress={() => {
                setShowSavedIds(true);
                setShowToolsMenu(false);
              }}
            >
              <Text style={styles.toolsMenuItemText}>📌 Saved IDs ({savedRedrawIds.length})</Text>
            </TouchableOpacity>
          </View>
        ) : null}

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
        onRequestClose={() => selectSingle(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            {selectedElement ? (
              <ScrollView>
                {selectionCandidates.length > 1 ? (
                  // The click landed near/on more than one feature (close
                  // together, or directly overlapping — e.g. an island
                  // tagged both swamp and intermittent-water needs two
                  // stacked areas) — step through the rest without having
                  // to close and re-click precisely on each one.
                  <View style={styles.candidateNav}>
                    <TouchableOpacity onPress={() => cycleSelection(-1)} hitSlop={8}>
                      <Text style={styles.candidateNavArrow}>◀</Text>
                    </TouchableOpacity>
                    <Text style={styles.candidateNavLabel}>
                      {selectionIndex + 1} of {selectionCandidates.length} nearby
                    </Text>
                    <TouchableOpacity onPress={() => cycleSelection(1)} hitSlop={8}>
                      <Text style={styles.candidateNavArrow}>▶</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>
                    {selectedElement.type} #{selectedElement.id}
                  </Text>
                  <TouchableOpacity onPress={() => selectSingle(null)} hitSlop={8}>
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

                {/* Parks this element's real id for a full redraw — see
                    savedRedrawIds above. For when adjusting the existing
                    shape isn't worth it and it's easier to draw it fresh,
                    without losing the id's OSM edit history the way a
                    plain delete-then-recreate would. */}
                <TouchableOpacity style={styles.saveIdButton} onPress={saveIdForRedraw}>
                  <Text style={styles.saveIdButtonText}>📌 Save ID (redraw from scratch)</Text>
                </TouchableOpacity>

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
        onRequestClose={() => selectSingle(null)}
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
                onClose={() => selectSingle(null)}
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
                    selectSingle(osmEditorElementKey("relation", r.id));
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
                selectSingle(osmEditorElementKey("relation", el.id));
              }}
            >
              <Text style={styles.newRelationButtonText}>+ New relation</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Saved IDs — elements parked for a full redraw (see savedRedrawIds
          above); pick one to load it as the target for the next new-node
          placement or new-way finish. */}
      <Modal visible={showSavedIds} transparent animationType="fade" onRequestClose={() => setShowSavedIds(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Saved IDs</Text>
              <TouchableOpacity onPress={() => setShowSavedIds(false)} hitSlop={8}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.savedIdsHint}>
              Parked from a way/node's detail panel ("Save ID") — pick one, then draw its replacement on the map. The new
              shape reattaches to this same id, so its OSM edit history carries forward instead of forking into a new
              element. A parked way's own (non-intersection) nodes are hidden along with it and shown as small guide
              markers at their old positions while you redraw, so the new shape can line up the same way — a shared
              intersection node stays put and tappable the whole time. A tagged sub-node (a stop sign, a hydrant — a
              real feature, not just a bend in the way) shows up highlighted in red; tap it while redrawing to keep
              that same id/tags at its new spot instead of losing them.
            </Text>
            <ScrollView style={styles.relationsList}>
              {savedRedrawIds.length === 0 ? <Text style={styles.emptyText}>Nothing parked for redraw yet.</Text> : null}
              {savedRedrawIds.map((r) => (
                <View key={osmEditorElementKey(r.type, r.id)} style={styles.savedIdRow}>
                  <TouchableOpacity style={styles.savedIdRowMain} onPress={() => armSavedRedrawId(r)}>
                    <Text style={styles.relationRowText}>
                      {r.type} #{r.id} — {r.label}
                    </Text>
                    <Text style={styles.savedIdRowHint}>
                      {armedRedrawId && armedRedrawId.type === r.type && armedRedrawId.id === r.id
                        ? "Loaded — draw its new shape"
                        : `Tap to draw a new ${r.type}`}
                      {r.exclusiveNodeIds && r.exclusiveNodeIds.length > 0
                        ? ` (+ ${r.exclusiveNodeIds.length} sub-node${r.exclusiveNodeIds.length === 1 ? "" : "s"} parked with it)`
                        : ""}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => restoreSavedRedrawId(r)} hitSlop={8}>
                    <Text style={styles.savedIdRestore}>Restore</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
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
                {clearArmed ? "Tap again to confirm — clears local edits only, not OSM" : "Clear working set (start over)"}
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
  toolbarButtonDangerText: { color: "#c0392b" },
  toolbarButtonText: { fontFamily: fonts.medium, fontSize: 12, color: "#333" },
  toolbarButtonTextActive: { color: "#fff" },
  addButton: { paddingHorizontal: 16 },
  addButtonText: { fontSize: 18, lineHeight: 18, fontFamily: fonts.medium },
  toolsMenu: {
    position: "absolute",
    right: 12,
    bottom: 68, // clears the toolbar's own height, opens upward from the gear button
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 4,
    minWidth: 190,
    elevation: 6,
    zIndex: 1001,
  },
  addMenu: {
    position: "absolute",
    left: 12,
    bottom: 68, // same idea as toolsMenu, opening upward from the "+" button instead
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 4,
    minWidth: 190,
    elevation: 6,
    zIndex: 1001,
  },
  toolsMenuItem: { paddingHorizontal: 14, paddingVertical: 10 },
  toolsMenuItemText: { fontFamily: fonts.medium, fontSize: 13, color: "#333" },
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
  candidateNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingTop: 12,
    paddingBottom: 4,
    backgroundColor: "#f7f9fb",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  candidateNavArrow: { fontFamily: fonts.semiBold, fontSize: 16, color: "#2980b9", paddingHorizontal: 6 },
  candidateNavLabel: { fontFamily: fonts.medium, fontSize: 12, color: "#555" },
  actionBadge: { fontFamily: fonts.regular, fontSize: 11, color: "#888", paddingHorizontal: 16, marginBottom: 8 },
  saveIdButton: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#2980b9",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  saveIdButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
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
  savedIdsHint: { fontFamily: fonts.regular, fontSize: 12, color: "#777", paddingHorizontal: 16, marginBottom: 8, lineHeight: 17 },
  savedIdRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  savedIdRowMain: { flex: 1 },
  savedIdRowHint: { fontFamily: fonts.regular, fontSize: 11, color: "#2980b9", marginTop: 2 },
  savedIdRestore: { fontFamily: fonts.medium, fontSize: 12, color: "#888", marginLeft: 12 },
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
