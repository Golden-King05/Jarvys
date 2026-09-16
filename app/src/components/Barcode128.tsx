import React, { forwardRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import ViewShot, { type ViewShotRef } from "react-native-view-shot";
import { encodeCode128C, type BarcodePattern } from "../utils/barcode128";
import { fonts } from "../theme";

interface Props {
  // A 12-digit numeric barcode value (see InventoryItem.barcode) — every
  // value this app generates, so Subset C (two digits per symbol) always
  // applies; see barcode128.ts.
  value: string;
  moduleWidth?: number;
  height?: number;
  showText?: boolean;
}

// Renders a scannable Code 128 barcode purely from React Native `View`
// stripes — no SVG/canvas dependency, works identically on web and native.
// Wrapped in a ViewShot so a caller holding the forwarded ref can call
// `.capture()` to rasterize it to a PNG for saving/sharing (see
// saveBarcodePng in inventoryPhoto.ts).
const Barcode128 = forwardRef<ViewShotRef, Props>(function Barcode128(
  { value, moduleWidth = 2.5, height = 70, showText = true },
  ref
) {
  let pattern: BarcodePattern | null = null;
  let error: string | null = null;
  try {
    pattern = encodeCode128C(value);
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not generate barcode";
  }

  if (error || !pattern) {
    return (
      <View style={styles.errorBox}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  // Code 128's spec calls for a quiet (blank) margin of at least 10 module
  // widths on each side so a scanner doesn't misread where the symbology
  // starts/ends against whatever's printed next to it.
  const quiet = moduleWidth * 10;

  return (
    <ViewShot ref={ref} options={{ format: "png", quality: 1, result: "data-uri" }} style={styles.shot}>
      <View style={styles.wrap}>
        <View style={[styles.bars, { height }]}>
          <View style={{ width: quiet }} />
          {pattern.widths.map((w, i) => (
            <View key={i} style={{ width: w * moduleWidth, height, backgroundColor: i % 2 === 0 ? "#000" : "#fff" }} />
          ))}
          <View style={{ width: quiet }} />
        </View>
        {showText ? <Text style={styles.code}>{value}</Text> : null}
      </View>
    </ViewShot>
  );
});

export default Barcode128;

const styles = StyleSheet.create({
  shot: { backgroundColor: "#fff" },
  wrap: { backgroundColor: "#fff", alignItems: "center", paddingVertical: 10, paddingHorizontal: 4 },
  bars: { flexDirection: "row" },
  code: { fontFamily: fonts.medium, fontSize: 13, letterSpacing: 3, color: "#000", marginTop: 6 },
  errorBox: { padding: 12, backgroundColor: "#fee", borderRadius: 8 },
  errorText: { fontFamily: fonts.regular, fontSize: 12, color: "#c0392b" },
});
