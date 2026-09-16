import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import type { ViewShotRef } from "react-native-view-shot";
import { api, type InventoryCategory, type InventoryItem } from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";
import Barcode128 from "../components/Barcode128";
import { pickItemPhotoFromCamera, pickItemPhotoFromLibrary, saveBarcodePng, type PickedPhoto } from "../utils/inventoryPhoto";

// The barcode inventory tab: a catalog of physical items sorted into
// categories, each wearing a locally-generated barcode (see
// utils/barcode128.ts) that a camera scan looks up to flip checked-out
// state — "what did I take out, what's still missing" tracking, not a
// retail-style stock count.
export default function InventoryScreen() {
  const { baseUrl, token } = useAuth();
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const [view, setView] = useState<"categories" | "checkedOut">("categories");

  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryDeleteArmedId, setCategoryDeleteArmedId] = useState<string | null>(null);

  const [showAddItem, setShowAddItem] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCategoryId, setDraftCategoryId] = useState<string | null>(null);
  const [draftPhoto, setDraftPhoto] = useState<PickedPhoto | null>(null);
  const [savingItem, setSavingItem] = useState(false);

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const barcodeRef = useRef<ViewShotRef>(null);

  const [showScan, setShowScan] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // Debounces the camera firing onBarcodeScanned repeatedly for the same
  // code every frame it's still in view — without this, holding a barcode
  // steady in front of the camera for even a second would toggle it
  // checked-out/in several times over.
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    Promise.all([api.getInventoryCategories(baseUrl, token), api.getInventoryItems(baseUrl, token)])
      .then(([c, i]) => {
        setCategories(c.categories);
        setItems(i.items);
      })
      .catch((e) => setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Failed to load" }))
      .finally(() => setLoading(false));
  }, [baseUrl, token]);

  const selectedItem = useMemo(() => items.find((i) => i.id === selectedItemId) ?? null, [items, selectedItemId]);
  const checkedOutItems = useMemo(() => items.filter((i) => i.checkedOut), [items]);

  const grouped = useMemo(() => {
    const byCategory = new Map<string | null, InventoryItem[]>();
    for (const it of items) {
      const key = it.categoryId;
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key)!.push(it);
    }
    return {
      sections: categories.map((c) => ({ id: c.id, name: c.name, items: byCategory.get(c.id) ?? [] })),
      uncategorized: byCategory.get(null) ?? [],
    };
  }, [items, categories]);

  function categoryName(id: string | null): string {
    if (!id) return "Uncategorized";
    return categories.find((c) => c.id === id)?.name ?? "Uncategorized";
  }

  async function submitAddCategory() {
    if (!token || !newCategoryName.trim()) return;
    try {
      const cat = await api.createInventoryCategory(baseUrl, token, newCategoryName.trim());
      setCategories((prev) => {
        const idx = prev.findIndex((c) => c.id === cat.id);
        const next = idx === -1 ? [...prev, cat] : prev.map((c) => (c.id === cat.id ? cat : c));
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
      setNewCategoryName("");
      setShowAddCategory(false);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not add category" });
    }
  }

  async function deleteCategory(id: string) {
    if (!token) return;
    try {
      await api.deleteInventoryCategory(baseUrl, token, id);
      setCategories((prev) => prev.filter((c) => c.id !== id));
      // Its items fall back to Uncategorized server-side (ON DELETE SET
      // NULL) rather than being deleted — mirror that locally.
      setItems((prev) => prev.map((it) => (it.categoryId === id ? { ...it, categoryId: null } : it)));
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not delete category" });
    }
  }

  function handleCategoryDeletePress(id: string) {
    if (categoryDeleteArmedId === id) {
      deleteCategory(id);
      setCategoryDeleteArmedId(null);
    } else {
      setCategoryDeleteArmedId(id);
    }
  }

  function openAddItem() {
    setDraftName("");
    setDraftCategoryId(null);
    setDraftPhoto(null);
    setShowAddItem(true);
  }

  async function pickPhoto(source: "camera" | "library") {
    try {
      const photo = source === "camera" ? await pickItemPhotoFromCamera() : await pickItemPhotoFromLibrary();
      if (photo) setDraftPhoto(photo);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not get photo" });
    }
  }

  async function submitAddItem() {
    if (!token || !draftName.trim()) return;
    setSavingItem(true);
    try {
      const item = await api.createInventoryItem(baseUrl, token, {
        name: draftName.trim(),
        categoryId: draftCategoryId,
        photoBase64: draftPhoto?.base64 ?? null,
        photoMime: draftPhoto?.mime ?? null,
      });
      setItems((prev) => [...prev, item]);
      setShowAddItem(false);
      // Jump straight to its detail panel — the barcode it was just given
      // is usually the whole reason for adding it, so show it right away.
      setSelectedItemId(item.id);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not add item" });
    } finally {
      setSavingItem(false);
    }
  }

  async function toggleCheckedOut(item: InventoryItem) {
    if (!token) return;
    try {
      const updated = item.checkedOut
        ? await api.checkInInventoryItem(baseUrl, token, item.id)
        : await api.checkOutInventoryItem(baseUrl, token, item.id);
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not update" });
    }
  }

  async function deleteItem(id: string) {
    if (!token) return;
    try {
      await api.deleteInventoryItem(baseUrl, token, id);
      setItems((prev) => prev.filter((i) => i.id !== id));
      setSelectedItemId(null);
      setDeleteArmed(false);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not delete item" });
    }
  }

  async function saveBarcode(item: InventoryItem) {
    try {
      const uri = await barcodeRef.current?.capture();
      if (!uri) return;
      await saveBarcodePng(uri, item.name || item.barcode);
    } catch (e) {
      setStatusMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not save barcode" });
    }
  }

  function openScan() {
    setScanFeedback(null);
    lastScanRef.current = null;
    setShowScan(true);
    if (!permission?.granted) requestPermission();
  }

  function closeScan() {
    setShowScan(false);
    setScanFeedback(null);
  }

  async function handleBarcodeScanned(result: BarcodeScanningResult) {
    const now = Date.now();
    if (lastScanRef.current && lastScanRef.current.code === result.data && now - lastScanRef.current.at < 2500) return;
    lastScanRef.current = { code: result.data, at: now };
    if (!token) return;
    try {
      const res = await api.scanInventoryBarcode(baseUrl, token, result.data);
      setItems((prev) => prev.map((it) => (it.id === res.item.id ? res.item : it)));
      setScanFeedback({
        kind: "info",
        text: res.action === "checked-out" ? `✅ Checked out: ${res.item.name}` : `↩️ Checked in: ${res.item.name}`,
      });
    } catch (e) {
      setScanFeedback({ kind: "error", text: e instanceof Error ? e.message : "That barcode isn't in your inventory." });
    }
  }

  function renderItemRow(item: InventoryItem) {
    return (
      <TouchableOpacity key={item.id} style={styles.itemRow} onPress={() => setSelectedItemId(item.id)}>
        {item.photoBase64 ? (
          <Image source={{ uri: `data:${item.photoMime ?? "image/jpeg"};base64,${item.photoBase64}` }} style={styles.itemThumb} />
        ) : (
          <View style={styles.itemThumbPlaceholder}>
            <Text style={styles.itemThumbPlaceholderText}>📦</Text>
          </View>
        )}
        <View style={styles.itemRowMain}>
          <Text style={styles.itemName}>{item.name}</Text>
          <Text style={styles.itemBarcode}>#{item.barcode}</Text>
        </View>
        {item.checkedOut ? (
          <View style={styles.checkedOutBadge}>
            <Text style={styles.checkedOutBadgeText}>OUT</Text>
          </View>
        ) : null}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Inventory</Text>
        <TouchableOpacity style={styles.scanButton} onPress={openScan}>
          <Text style={styles.scanButtonText}>📷 Scan</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabChip, view === "categories" && styles.tabChipActive]}
          onPress={() => setView("categories")}
        >
          <Text style={[styles.tabChipText, view === "categories" && styles.tabChipTextActive]}>By category</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabChip, view === "checkedOut" && styles.tabChipActive]}
          onPress={() => setView("checkedOut")}
        >
          <Text style={[styles.tabChipText, view === "checkedOut" && styles.tabChipTextActive]}>
            Checked out ({checkedOutItems.length})
          </Text>
        </TouchableOpacity>
      </View>

      {statusMessage ? (
        <View style={[styles.statusBanner, statusMessage.kind === "error" && styles.statusBannerError]}>
          <Text style={styles.statusBannerText}>{statusMessage.text}</Text>
          <TouchableOpacity onPress={() => setStatusMessage(null)} hitSlop={8}>
            <Text style={styles.statusBannerClose}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
          {view === "categories" ? (
            <>
              {grouped.sections.map((section) => (
                <View key={section.id} style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>
                      {section.name} ({section.items.length})
                    </Text>
                    <TouchableOpacity onPress={() => handleCategoryDeletePress(section.id)} hitSlop={8}>
                      <Text style={styles.sectionDelete}>{categoryDeleteArmedId === section.id ? "Tap again" : "🗑️"}</Text>
                    </TouchableOpacity>
                  </View>
                  {section.items.length === 0 ? <Text style={styles.emptyText}>No items yet.</Text> : null}
                  {section.items.map(renderItemRow)}
                </View>
              ))}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Uncategorized ({grouped.uncategorized.length})</Text>
                {grouped.uncategorized.length === 0 ? <Text style={styles.emptyText}>Nothing here.</Text> : null}
                {grouped.uncategorized.map(renderItemRow)}
              </View>

              {showAddCategory ? (
                <View style={styles.inlineAddRow}>
                  <TextInput
                    style={styles.inlineInput}
                    placeholder="Category name"
                    value={newCategoryName}
                    onChangeText={setNewCategoryName}
                    autoFocus
                    onSubmitEditing={submitAddCategory}
                  />
                  <TouchableOpacity onPress={submitAddCategory}>
                    <Text style={styles.inlineAddConfirm}>Add</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      setShowAddCategory(false);
                      setNewCategoryName("");
                    }}
                  >
                    <Text style={styles.inlineAddCancel}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.addCategoryButton} onPress={() => setShowAddCategory(true)}>
                  <Text style={styles.addCategoryButtonText}>+ New category</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <View style={styles.section}>
              {checkedOutItems.length === 0 ? (
                <Text style={styles.emptyText}>Nothing checked out — you have everything.</Text>
              ) : (
                checkedOutItems.map(renderItemRow)
              )}
            </View>
          )}
        </ScrollView>
      )}

      <TouchableOpacity style={styles.addItemFab} onPress={openAddItem}>
        <Text style={styles.addItemFabText}>+</Text>
      </TouchableOpacity>

      {/* Add item */}
      <Modal visible={showAddItem} transparent animationType="fade" onRequestClose={() => setShowAddItem(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Add item</Text>
              <TouchableOpacity onPress={() => setShowAddItem(false)} hitSlop={8}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.cardBody}>
              <Text style={styles.label}>Name</Text>
              <TextInput style={styles.input} value={draftName} onChangeText={setDraftName} placeholder="e.g. Cordless drill" />

              <Text style={styles.label}>Category</Text>
              <View style={styles.chipWrap}>
                <TouchableOpacity
                  style={[styles.chip, draftCategoryId === null && styles.chipActive]}
                  onPress={() => setDraftCategoryId(null)}
                >
                  <Text style={[styles.chipText, draftCategoryId === null && styles.chipTextActive]}>Uncategorized</Text>
                </TouchableOpacity>
                {categories.map((c) => (
                  <TouchableOpacity
                    key={c.id}
                    style={[styles.chip, draftCategoryId === c.id && styles.chipActive]}
                    onPress={() => setDraftCategoryId(c.id)}
                  >
                    <Text style={[styles.chipText, draftCategoryId === c.id && styles.chipTextActive]}>{c.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>Photo</Text>
              {draftPhoto ? (
                <View style={styles.photoPreviewWrap}>
                  <Image source={{ uri: `data:${draftPhoto.mime};base64,${draftPhoto.base64}` }} style={styles.photoPreview} />
                  <TouchableOpacity onPress={() => setDraftPhoto(null)}>
                    <Text style={styles.removePhoto}>Remove photo</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.photoButtonRow}>
                  <TouchableOpacity style={styles.photoButton} onPress={() => pickPhoto("camera")}>
                    <Text style={styles.photoButtonText}>📷 Take photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.photoButton} onPress={() => pickPhoto("library")}>
                    <Text style={styles.photoButtonText}>🖼️ Choose photo</Text>
                  </TouchableOpacity>
                </View>
              )}

              <TouchableOpacity
                style={[styles.saveButton, (!draftName.trim() || savingItem) && styles.saveButtonDisabled]}
                onPress={submitAddItem}
                disabled={!draftName.trim() || savingItem}
              >
                <Text style={styles.saveButtonText}>{savingItem ? "Adding…" : "Add item — generates its barcode"}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Item detail */}
      <Modal visible={Boolean(selectedItem)} transparent animationType="fade" onRequestClose={() => setSelectedItemId(null)}>
        {selectedItem ? (
          <View style={styles.overlay}>
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{selectedItem.name}</Text>
                <TouchableOpacity onPress={() => setSelectedItemId(null)} hitSlop={8}>
                  <Text style={styles.closeIcon}>✕</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.cardBody}>
                {selectedItem.photoBase64 ? (
                  <Image
                    source={{ uri: `data:${selectedItem.photoMime ?? "image/jpeg"};base64,${selectedItem.photoBase64}` }}
                    style={styles.detailPhoto}
                  />
                ) : null}
                <Text style={styles.detailMeta}>{categoryName(selectedItem.categoryId)}</Text>
                <Text style={[styles.detailStatus, selectedItem.checkedOut && styles.detailStatusOut]}>
                  {selectedItem.checkedOut ? "Checked out" : "In storage"}
                </Text>

                <View style={styles.barcodeWrap}>
                  <Barcode128 ref={barcodeRef} value={selectedItem.barcode} />
                </View>
                <TouchableOpacity style={styles.savePngButton} onPress={() => saveBarcode(selectedItem)}>
                  <Text style={styles.savePngButtonText}>💾 Save barcode as PNG</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.checkButton, selectedItem.checkedOut ? styles.checkInButton : styles.checkOutButton]}
                  onPress={() => toggleCheckedOut(selectedItem)}
                >
                  <Text style={styles.checkButtonText}>{selectedItem.checkedOut ? "↩️ Check in" : "✅ Check out"}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.deleteButton}
                  onPress={() => {
                    if (deleteArmed) deleteItem(selectedItem.id);
                    else setDeleteArmed(true);
                  }}
                  onBlur={() => setDeleteArmed(false)}
                >
                  <Text style={styles.deleteButtonText}>{deleteArmed ? "Tap again to delete" : "Delete item"}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        ) : null}
      </Modal>

      {/* Scan */}
      <Modal visible={showScan} animationType="slide" onRequestClose={closeScan}>
        <View style={styles.scanContainer}>
          {!permission?.granted ? (
            <View style={styles.center}>
              <Text style={styles.scanPermissionText}>Camera access is needed to scan barcodes.</Text>
              <TouchableOpacity style={styles.saveButton} onPress={requestPermission}>
                <Text style={styles.saveButtonText}>Grant camera access</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["code128"] }}
              onBarcodeScanned={handleBarcodeScanned}
            />
          )}
          {scanFeedback ? (
            <View style={[styles.scanFeedback, scanFeedback.kind === "error" && styles.scanFeedbackError]}>
              <Text style={styles.scanFeedbackText}>{scanFeedback.text}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.scanDoneButton} onPress={closeScan}>
            <Text style={styles.scanDoneButtonText}>Done scanning</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 80 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  title: { fontFamily: fonts.semiBold, fontSize: 20, color: "#222" },
  scanButton: { backgroundColor: "#2980b9", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  scanButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
  tabRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, marginTop: 12 },
  tabChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: "#ccc", backgroundColor: "#fff" },
  tabChipActive: { backgroundColor: "#222", borderColor: "#222" },
  tabChipText: { fontFamily: fonts.medium, fontSize: 13, color: "#444" },
  tabChipTextActive: { color: "#fff" },
  statusBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: "#eaf4ea",
    borderRadius: 10,
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusBannerError: { backgroundColor: "#fdecea" },
  statusBannerText: { fontFamily: fonts.regular, fontSize: 12, color: "#333", flex: 1, marginRight: 8 },
  statusBannerClose: { fontFamily: fonts.medium, fontSize: 13, color: "#888" },
  section: { marginTop: 20 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: "#222" },
  sectionDelete: { fontFamily: fonts.medium, fontSize: 12, color: "#c0392b" },
  emptyText: { fontFamily: fonts.regular, fontSize: 12, color: "#999", paddingVertical: 8 },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f7f7f7",
    borderRadius: 10,
    padding: 8,
    marginTop: 8,
    gap: 10,
  },
  itemThumb: { width: 44, height: 44, borderRadius: 8, backgroundColor: "#eee" },
  itemThumbPlaceholder: { width: 44, height: 44, borderRadius: 8, backgroundColor: "#eee", alignItems: "center", justifyContent: "center" },
  itemThumbPlaceholderText: { fontSize: 20 },
  itemRowMain: { flex: 1 },
  itemName: { fontFamily: fonts.medium, fontSize: 14, color: "#222" },
  itemBarcode: { fontFamily: fonts.regular, fontSize: 11, color: "#999", marginTop: 2 },
  checkedOutBadge: { backgroundColor: "#e67e22", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  checkedOutBadgeText: { fontFamily: fonts.semiBold, fontSize: 10, color: "#fff" },
  inlineAddRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 },
  inlineInput: {
    flex: 1,
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineAddConfirm: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  inlineAddCancel: { fontFamily: fonts.medium, fontSize: 13, color: "#888" },
  addCategoryButton: { marginTop: 16, alignSelf: "flex-start" },
  addCategoryButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  addItemFab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#2980b9",
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
  },
  addItemFabText: { fontFamily: fonts.semiBold, fontSize: 28, lineHeight: 30, color: "#fff" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 0, width: 360, maxWidth: "92%", maxHeight: "85%" },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222", flex: 1, marginRight: 8 },
  closeIcon: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  cardBody: { padding: 16 },
  label: { fontFamily: fonts.medium, fontSize: 13, color: "#444", marginTop: 12, marginBottom: 4 },
  input: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: "#ccc", backgroundColor: "#fff" },
  chipActive: { backgroundColor: "#222", borderColor: "#222" },
  chipText: { fontFamily: fonts.medium, fontSize: 12, color: "#444" },
  chipTextActive: { color: "#fff" },
  photoButtonRow: { flexDirection: "row", gap: 10 },
  photoButton: { flex: 1, backgroundColor: "#f0f0f0", borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  photoButtonText: { fontFamily: fonts.medium, fontSize: 12, color: "#333" },
  photoPreviewWrap: { alignItems: "center", gap: 8 },
  photoPreview: { width: 140, height: 140, borderRadius: 10, backgroundColor: "#eee" },
  removePhoto: { fontFamily: fonts.medium, fontSize: 12, color: "#c0392b" },
  saveButton: { backgroundColor: "#2980b9", borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 20 },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { fontFamily: fonts.medium, fontSize: 14, color: "#fff" },
  detailMeta: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginTop: 8 },
  detailStatus: { fontFamily: fonts.medium, fontSize: 13, color: "#27ae60", marginTop: 4 },
  detailStatusOut: { color: "#e67e22" },
  detailPhoto: { width: "100%", height: 180, borderRadius: 10, backgroundColor: "#eee", marginTop: 4 },
  barcodeWrap: { alignItems: "center", marginTop: 16 },
  savePngButton: { alignItems: "center", marginTop: 10 },
  savePngButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  checkButton: { borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 20 },
  checkOutButton: { backgroundColor: "#27ae60" },
  checkInButton: { backgroundColor: "#e67e22" },
  checkButtonText: { fontFamily: fonts.medium, fontSize: 14, color: "#fff" },
  deleteButton: { borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 12, marginBottom: 8 },
  deleteButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  scanContainer: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  scanPermissionText: { fontFamily: fonts.regular, fontSize: 14, color: "#fff", textAlign: "center", marginBottom: 16, paddingHorizontal: 24 },
  scanFeedback: {
    position: "absolute",
    top: 40,
    left: 16,
    right: 16,
    backgroundColor: "rgba(39,174,96,0.92)",
    borderRadius: 10,
    padding: 12,
  },
  scanFeedbackError: { backgroundColor: "rgba(192,57,43,0.92)" },
  scanFeedbackText: { fontFamily: fonts.medium, fontSize: 14, color: "#fff", textAlign: "center" },
  scanDoneButton: {
    position: "absolute",
    bottom: 32,
    left: 24,
    right: 24,
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  scanDoneButtonText: { fontFamily: fonts.semiBold, fontSize: 15, color: "#222" },
});
