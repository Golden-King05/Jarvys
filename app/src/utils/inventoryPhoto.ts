import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

// Item photos are stored as base64 in the server's DB (see
// server/src/db.ts's inventory_items.photo_base64) — there's no object
// storage or filesystem path for this app to use instead, so every photo
// gets shrunk to a small thumbnail before it's ever sent, keeping both the
// request body and the stored row reasonable regardless of how large the
// original camera/library photo was.
const MAX_DIMENSION = 640;
const JPEG_QUALITY = 0.6;

export interface PickedPhoto {
  base64: string;
  mime: string;
}

async function compress(uri: string): Promise<PickedPhoto> {
  const result = await manipulateAsync(uri, [{ resize: { width: MAX_DIMENSION } }], {
    base64: true,
    compress: JPEG_QUALITY,
    format: SaveFormat.JPEG,
  });
  if (!result.base64) throw new Error("Could not process the photo.");
  return { base64: result.base64, mime: "image/jpeg" };
}

export async function pickItemPhotoFromLibrary(): Promise<PickedPhoto | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error("Photo library access was denied.");
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
  if (result.canceled || !result.assets[0]) return null;
  return compress(result.assets[0].uri);
}

export async function pickItemPhotoFromCamera(): Promise<PickedPhoto | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera access was denied.");
  const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
  if (result.canceled || !result.assets[0]) return null;
  return compress(result.assets[0].uri);
}

// iPadOS 13+ reports as "MacIntel" in the UA string (desktop-class
// Safari) — indistinguishable from an actual Mac except that only a
// touch-capable device has multiple touch points, so that's the tell for
// "this is really iOS" once the classic iPhone/iPad UA regex misses it.
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// Only meaningful on web — opens a blank tab, synchronously, so it must be
// called as the very first thing inside a tap handler, before any `await`
// (including the barcode's own async render/capture). A `window.open`
// called any later — even after a barcode capture that only takes ~100ms —
// no longer reads as a direct result of the user's tap to the browser's
// popup blocker, and gets silently dropped: confirmed by testing that this
// exact thing was why the iOS fallback below wasn't working at all. Opening
// a blank tab immediately and pointing it at the real content once it's
// ready (via saveBarcodePng's `fallbackTab` param) sidesteps that, since
// the popup blocker only cares about the moment `open()` itself is called.
export function openFallbackTab(): Window | null {
  if (Platform.OS !== "web") return null;
  return window.open("", "_blank");
}

// Saves a rendered barcode (a data: URI PNG, from Barcode128's ViewShot
// ref) to the user's device — a share sheet on native, and on web,
// whichever of a few approaches actually works on the browser in front of
// it. No single "save to X" API is both permission-light and consistent
// across iOS/Android/desktop, and the share sheet (native) / Web Share API
// (web) lets the user pick where it lands without this app needing
// expo-media-library (and its own extra permission) just for this.
//
// `fallbackTab`: the return value of openFallbackTab(), called synchronously
// at the start of the same tap handler this was eventually invoked from —
// see that function's comment for why. Only actually used if every other
// approach below fails; closed again otherwise so it doesn't linger as a
// stray blank tab.
export async function saveBarcodePng(dataUri: string, filenameHint: string, fallbackTab?: Window | null): Promise<void> {
  const safeName = filenameHint.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "barcode";
  if (Platform.OS === "web") {
    // iOS Safari (including installed-to-home-screen "web app" mode)
    // silently ignores <a download> on a data: URI — tapping it just
    // navigates/opens the image instead of saving a file, which is why
    // that alone "doesn't work" there. The Web Share API's native sheet
    // (with a real Save Image option) is the reliable path on iOS, and
    // works on plenty of other browsers too, so it's tried first
    // everywhere it's available.
    try {
      const blob = await (await fetch(dataUri)).blob();
      const file = new window.File([blob], `${safeName}.png`, { type: "image/png" });
      if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ files: [file] });
        fallbackTab?.close();
        return;
      }
    } catch (e) {
      // AbortError = the user closed the share sheet themselves — done,
      // not a failure to fall back from. Anything else falls through to
      // the next approach below.
      if (e instanceof Error && e.name === "AbortError") {
        fallbackTab?.close();
        return;
      }
    }
    if (isIOS()) {
      // Reached only when Web Share's file support wasn't there either
      // (an older iOS Safari) — <a download> would just silently no-op
      // here too. Navigating the tab itself to the data: URI (e.g. via
      // `location.href =`) doesn't work either — Chromium and WebKit both
      // silently block top-level navigation to a data: URI as an
      // anti-phishing measure, confirmed by testing that the tab was
      // still just sitting on about:blank afterwards. Writing an <img>
      // with the data URI as its src isn't a navigation at all, so it's
      // unaffected, and gives a long-press → Save Image target.
      const html = `<!DOCTYPE html><html><head><title>${safeName}</title></head><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111"><img src="${dataUri}" alt="${safeName}" style="max-width:100%;height:auto"></body></html>`;
      if (fallbackTab && !fallbackTab.closed) {
        fallbackTab.document.write(html);
        fallbackTab.document.close();
      } else {
        const w = window.open("", "_blank");
        w?.document.write(html);
        w?.document.close();
      }
      return;
    }
    fallbackTab?.close();
    const a = document.createElement("a");
    a.href = dataUri;
    a.download = `${safeName}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const base64 = dataUri.replace(/^data:image\/png;base64,/, "");
  const file = new File(Paths.cache, `${safeName}.png`);
  file.create({ overwrite: true });
  file.write(base64, { encoding: "base64" });
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, { mimeType: "image/png", dialogTitle: "Save barcode" });
  }
}
