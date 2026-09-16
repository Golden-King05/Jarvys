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

// Saves a rendered barcode (a data: URI PNG, from Barcode128's ViewShot
// ref) to the user's device — a plain browser download on web, a share
// sheet (Files/Photos/AirDrop/etc.) on native. No single "save to X" API is
// both permission-light and consistent across iOS/Android, and the share
// sheet lets the user pick where it lands without this app needing
// expo-media-library (and its own extra permission) just for this.
export async function saveBarcodePng(dataUri: string, filenameHint: string): Promise<void> {
  const safeName = filenameHint.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "barcode";
  if (Platform.OS === "web") {
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
