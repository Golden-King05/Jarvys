// A from-scratch Code 128 (Subset C, numeric pairs) barcode encoder — turns
// a string of even-length digits into the sequence of bar/space widths a
// renderer draws as a scannable barcode. Subset C is the right choice here
// since every inventory barcode this app generates (see
// server/src/db.ts's generateInventoryBarcode) is a fixed 12-digit numeric
// code: Subset C packs two digits per symbol, so 12 digits need only 6 data
// symbols instead of 12 — a shorter, denser barcode than Subset B/A would
// give the same value.
//
// The 107-entry bar-pattern table below (symbol values 0-106: 103 data
// symbols + START A/B/C + STOP) is Code 128's own published symbology, not
// something to hand-derive — transcribed verbatim from the widely-used
// JsBarcode library's constants.js (MIT licensed), cross-checked against
// its encoder logic for the checksum algorithm below.

const START_C = 105;
const STOP = 106;
const MODULO = 103;

// Index i holds symbol value i's bar pattern as a string of 1s and 0s
// (1 = black module, 0 = white) — 11 modules for every value except the
// STOP symbol (index 106), which is 13.
const BARS: string[] = [
  "11011001100", "11001101100", "11001100110", "10010011000", "10010001100",
  "10001001100", "10011001000", "10011000100", "10001100100", "11001001000",
  "11001000100", "11000100100", "10110011100", "10011011100", "10011001110",
  "10111001100", "10011101100", "10011100110", "11001110010", "11001011100",
  "11001001110", "11011100100", "11001110100", "11101101110", "11101001100",
  "11100101100", "11100100110", "11101100100", "11100110100", "11100110010",
  "11011011000", "11011000110", "11000110110", "10100011000", "10001011000",
  "10001000110", "10110001000", "10001101000", "10001100010", "11010001000",
  "11000101000", "11000100010", "10110111000", "10110001110", "10001101110",
  "10111011000", "10111000110", "10001110110", "11101110110", "11010001110",
  "11000101110", "11011101000", "11011100010", "11011101110", "11101011000",
  "11101000110", "11100010110", "11101101000", "11101100010", "11100011010",
  "11101111010", "11001000010", "11110001010", "10100110000", "10100001100",
  "10010110000", "10010000110", "10000101100", "10000100110", "10110010000",
  "10110000100", "10011010000", "10011000010", "10000110100", "10000110010",
  "11000010010", "11001010000", "11110111010", "11000010100", "10001111010",
  "10100111100", "10010111100", "10010011110", "10111100100", "10011110100",
  "10011110010", "11110100100", "11110010100", "11110010010", "11011011110",
  "11011110110", "11110110110", "10101111000", "10100011110", "10001011110",
  "10111101000", "10111100010", "11110101000", "11110100010", "10111011110",
  "10111101110", "11101011110", "11110101110", "11010000100", "11010010000",
  "11010011100", "1100011101011",
];

// Every entry's module count should be 11 (13 for the stop symbol) by
// construction of the standard — checked once here rather than trusted
// blindly, so a future transcription slip anywhere above fails loudly at
// import time instead of silently producing an unscannable barcode.
BARS.forEach((pattern, i) => {
  const expected = i === STOP ? 13 : 11;
  if (pattern.length !== expected || !/^[01]+$/.test(pattern)) {
    throw new Error(`Code128 bar table corrupt at index ${i}`);
  }
});

// Run-length-encodes a bar pattern into alternating widths, starting with a
// black bar — the shape a renderer wants (one stripe per run, not one per
// module).
function toWidths(pattern: string): number[] {
  const widths: number[] = [];
  let run = 1;
  for (let i = 1; i <= pattern.length; i++) {
    if (i < pattern.length && pattern[i] === pattern[i - 1]) {
      run++;
    } else {
      widths.push(run);
      run = 1;
    }
  }
  return widths;
}

export interface BarcodePattern {
  // Alternating bar/space widths in abstract "modules", always starting
  // and ending with a bar (black) — draw each as a black/white stripe this
  // many module-widths wide, left to right.
  widths: number[];
  totalModules: number;
}

// Encodes an even-length numeric string as Code 128 Subset C. Throws on
// anything else — every barcode value this app generates is a fixed
// 12-digit numeric code, so this is a defensive check against a future
// caller passing the wrong kind of value, not a general-purpose encoder.
export function encodeCode128C(digits: string): BarcodePattern {
  if (digits.length === 0 || digits.length % 2 !== 0 || !/^\d+$/.test(digits)) {
    throw new Error("Code128 Subset C needs a non-empty, even-length digit string");
  }

  const values: number[] = [START_C];
  for (let i = 0; i < digits.length; i += 2) {
    values.push(Number(digits.slice(i, i + 2)));
  }
  // Checksum = start value + sum(symbol value * 1-based position), mod 103
  // — Code 128's own algorithm, the same for every subset (only what a
  // given value maps to differs between them).
  let checksum = values[0];
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % MODULO);
  values.push(STOP);

  const widths = values.flatMap((v) => toWidths(BARS[v]));
  return { widths, totalModules: widths.reduce((a, b) => a + b, 0) };
}
