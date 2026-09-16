import AsyncStorage from "@react-native-async-storage/async-storage";

// AsyncStorage is already cross-platform (web via localStorage, native via
// its own backing store) — this just wraps one key at a time behind the
// same get/set/clear shape every caller already expects, so a new bit of
// per-viewer state (which OSM upload target was last selected, say) doesn't
// need its own bespoke wrapper.
export function makeKeyStorage(key: string) {
  return {
    get: () => AsyncStorage.getItem(key),
    set: (value: string) => AsyncStorage.setItem(key, value),
    clear: () => AsyncStorage.removeItem(key),
  };
}

export const tokenStorage = makeKeyStorage("jarvys.token");
// The JLOSME editor's "save ID for redraw" list (see JlosmeScreen.tsx) —
// persisted so a parked way/node id survives an app restart while its
// replacement geometry hasn't been drawn yet.
export const jlosmeSavedRedrawIdsStorage = makeKeyStorage("jarvys.jlosmeSavedRedrawIds");
