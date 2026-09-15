// MobileSAM (a distilled, browser-viable version of Meta's Segment
// Anything Model) running client-side via onnxruntime-web. Used by the
// building/area tracer: encoder runs once per captured map region, decoder
// runs once per click within that region (cheap — this is exactly the
// encoder-once/decoder-per-click split the model is designed around).
//
// Model I/O shapes below were confirmed by loading both ONNX graphs and
// reading their actual declared inputs/outputs (via the `onnx` Python
// package) rather than assumed from general SAM documentation:
//   encoder: input_image FLOAT[height,width,3] (raw 0-255 RGB, HWC — the
//     graph itself applies ImageNet-style normalization
//     (mean [123.675,116.28,103.53], std [58.395,57.12,57.375]) and pads to
//     a square; it does NOT resize, so the caller must already have
//     resized so the image fits within the model's working size before
//     the internal pad-to-square happens. We sidestep resizing entirely by
//     capturing directly at 1024x1024 — the encoder's native long side).
//     -> output image_embeddings FLOAT[1,256,64,64]
//   decoder: image_embeddings, point_coords FLOAT[1,N,2], point_labels
//     FLOAT[1,N], mask_input FLOAT[1,1,256,256] (zeros — no prior mask),
//     has_mask_input FLOAT[1] (0), orig_im_size FLOAT[2]. Point coords are
//     in the same 1024x1024 pixel space the encoder saw. The decoder graph
//     itself resizes its low-res mask up to orig_im_size, so "masks" comes
//     back already at full captured-image resolution — no manual upscale
//     needed on our side.
//
// SAM's point-only-prompt ONNX convention (no box) requires padding
// point_coords/labels with one extra (0,0)/-1 "no-op" point — this isn't
// obvious from the graph shapes alone; it's a documented quirk of the
// official SAM ONNX export (see facebookresearch/segment-anything's
// onnx_model_example notebook) that the MobileSAM-in-the-Browser reference
// project (github.com/akbartus/MobileSAM-in-the-Browser) also follows.

export const MOBILESAM_ENCODER_URL = "https://huggingface.co/spaces/Akbartus/projects/resolve/main/mobilesam.encoder.onnx";
export const MOBILESAM_DECODER_URL =
  "https://raw.githubusercontent.com/akbartus/MobileSAM-in-the-Browser/main/models/mobilesam.decoder.quant.onnx";

// The square size (px) we capture map imagery at and feed the encoder —
// matches SAM/MobileSAM's native 1024 working resolution exactly, so no
// separate resize step is needed (see comment above).
export const SAM_INPUT_SIZE = 1024;

// Must match the onnxruntime-web version in app/package.json.
//
// onnxruntime-web is loaded at runtime from jsdelivr via a plain <script>
// tag — the same pattern OsmEditorMap.web.tsx already uses for Leaflet
// (loadLeaflet()) — rather than through Metro's `import("onnxruntime-web")`.
// Confirmed by hand this session that this matters, not just style: Metro's
// dynamic import of the npm package hung indefinitely with no error (never
// even resolved), while loading the identical version's UMD build via a
// <script> tag reliably initializes in a few seconds. onnxruntime-web still
// stays a real package.json dependency (for its TypeScript types and so a
// native build could use onnxruntime-react-native the same way later), it
// just isn't the code path the running web app actually executes. Its own
// npm package also ships the .wasm binaries, but getting Metro to serve
// those is a separate known friction point — sidestepped the same way, by
// pointing ort at this jsdelivr build's /dist/ instead (confirmed reachable
// with permissive CORS) rather than fighting Metro's asset pipeline for a
// single runtime-fetched binary.
const ORT_VERSION = "1.30.0";
const ORT_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ort = any;
let ortPromise: Promise<Ort> | null = null;
function loadOrt(): Promise<Ort> {
  const w = window as unknown as { ort?: Ort };
  if (w.ort) return Promise.resolve(w.ort);
  if (!ortPromise) {
    ortPromise = new Promise<Ort>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ORT_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve((window as unknown as { ort: Ort }).ort);
      script.onerror = () => reject(new Error("Failed to load onnxruntime-web"));
      document.body.appendChild(script);
    }).then((ort) => {
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
      // Threaded wasm needs cross-origin-isolation (COOP/COEP) headers for
      // SharedArrayBuffer, which this app's dev/prod hosting doesn't set —
      // force single-threaded so it works wherever the app is served from.
      ort.env.wasm.numThreads = 1;
      // Confirmed by hand this session: with this onnxruntime-web version's
      // default (proxy: true), InferenceSession.create() runs wasm inside a
      // Web Worker via a message-passing proxy — and that worker never
      // finished initializing in testing, silently hanging
      // InferenceSession.create() forever with no error. Forcing it off
      // runs wasm on the main thread instead, which reliably works.
      ort.env.wasm.proxy = false;
      return ort;
    });
  }
  return ortPromise;
}

const STALL_TIMEOUT_MS = 20000; // a single reader.read() taking longer than this is treated as a dead connection
const MAX_FETCH_ATTEMPTS = 4;

// A plain `fetch()` + stream-read works fine for a ~10-30MB file on a
// normal connection, but this turned out to matter in practice: under a
// flaky proxy/network, a large transfer can silently stall mid-stream
// (the read() promise just never settles — no error, no progress) rather
// than failing outright. Confirmed by hand this session against the real
// model URLs through this sandbox's network path. So: race each chunk read
// against a stall timeout, and retry the whole download from scratch (small
// enough files that range-resume isn't worth the complexity) a few times
// before giving up.
async function fetchWithProgress(url: string, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    try {
      // The initial connection itself (DNS/TCP/TLS) can also silently hang
      // rather than error — not just the byte stream below — so it needs
      // its own stall timeout too.
      const stallTimer = new Promise<"stall">((resolve) => setTimeout(() => resolve("stall"), STALL_TIMEOUT_MS));
      const fetched = await Promise.race([fetch(url, { signal: controller.signal }), stallTimer]);
      if (fetched === "stall") {
        controller.abort();
        throw new Error("Connection stalled");
      }
      const res = fetched;
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      if (!res.body) return await res.arrayBuffer();

      const total = Number(res.headers.get("content-length") ?? 0);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const stallTimer = new Promise<"stall">((resolve) => setTimeout(() => resolve("stall"), STALL_TIMEOUT_MS));
        const result = await Promise.race([reader.read(), stallTimer]);
        if (result === "stall") {
          controller.abort();
          throw new Error("Download stalled");
        }
        const { done, value } = result;
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          if (total > 0) onProgress(received / total);
        }
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out.buffer;
    } catch (e) {
      lastError = e;
      onProgress(0); // restart the visible progress bar for the retry
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed");
}

export interface MobileSamSession {
  encoderSession: Ort;
  decoderSession: Ort;
  ort: Ort;
}

let sessionPromise: Promise<MobileSamSession> | null = null;

// Lazily downloads (~35MB total, first activation only — cached by the
// browser's normal HTTP cache after that) and initializes both ONNX
// sessions. Safe to call repeatedly; subsequent calls reuse the same
// in-flight/completed load.
export function loadMobileSam(onProgress: (message: string) => void): Promise<MobileSamSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      onProgress("Loading AI model (~34MB, one-time — cached after)… encoder 0%");
      const encoderBuf = await fetchWithProgress(MOBILESAM_ENCODER_URL, (f) =>
        onProgress(`Loading AI model (~34MB, one-time — cached after)… encoder ${Math.round(f * 100)}%`)
      );
      onProgress("Loading AI model (~34MB, one-time — cached after)… decoder 0%");
      const decoderBuf = await fetchWithProgress(MOBILESAM_DECODER_URL, (f) =>
        onProgress(`Loading AI model (~34MB, one-time — cached after)… decoder ${Math.round(f * 100)}%`)
      );
      onProgress("Loading AI model… initializing…");
      const [encoderSession, decoderSession] = await Promise.all([
        ort.InferenceSession.create(encoderBuf, { executionProviders: ["wasm"] }),
        ort.InferenceSession.create(decoderBuf, { executionProviders: ["wasm"] }),
      ]);
      return { encoderSession, decoderSession, ort };
    })().catch((e) => {
      sessionPromise = null; // allow retry on next activation
      throw e;
    });
  }
  return sessionPromise;
}

export interface SamEmbedding {
  tensor: unknown; // ort.Tensor — opaque to callers
  imageWidth: number;
  imageHeight: number;
}

// Runs the (slow — hundreds of ms to a couple seconds on CPU wasm) encoder
// once for a captured 1024x1024 region. Callers should cache the result and
// only call this again when the user clicks in a different captured
// region.
export async function encodeRegion(session: MobileSamSession, canvas: HTMLCanvasElement): Promise<SamEmbedding> {
  const { ort } = session;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height); // throws SecurityError if tainted
  const hwc = new Float32Array(width * height * 3);
  const src = imageData.data;
  for (let i = 0, p = 0; i < src.length; i += 4, p += 3) {
    hwc[p] = src[i]; // R
    hwc[p + 1] = src[i + 1]; // G
    hwc[p + 2] = src[i + 2]; // B
  }
  const inputTensor = new ort.Tensor("float32", hwc, [height, width, 3]);
  const feeds: Record<string, unknown> = { input_image: inputTensor };
  const outputs = await session.encoderSession.run(feeds);
  const embeddingName = session.encoderSession.outputNames[0];
  return { tensor: outputs[embeddingName], imageWidth: width, imageHeight: height };
}

export interface SamMaskResult {
  mask: Uint8Array; // 0/1, row-major, imageWidth x imageHeight
  width: number;
  height: number;
  score: number; // the chosen mask's IoU prediction, for whatever diagnostic use
}

// Runs the decoder for a single foreground point click within the region
// that was encoded. Fast (tens of ms) — safe to call again and again for
// new clicks in the same encoded region without re-running the encoder.
export async function decodeClick(session: MobileSamSession, embedding: SamEmbedding, clickX: number, clickY: number): Promise<SamMaskResult> {
  const { ort } = session;
  const { imageWidth, imageHeight } = embedding;

  // Single foreground point, plus the mandatory (0,0)/-1 padding point
  // required by SAM's point-only (no box) ONNX decoder convention.
  const pointCoords = new ort.Tensor("float32", new Float32Array([clickX, clickY, 0, 0]), [1, 2, 2]);
  const pointLabels = new ort.Tensor("float32", new Float32Array([1, -1]), [1, 2]);
  const maskInput = new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]);
  const hasMaskInput = new ort.Tensor("float32", new Float32Array([0]), [1]);
  const origImSize = new ort.Tensor("float32", new Float32Array([imageHeight, imageWidth]), [2]);

  const feeds: Record<string, unknown> = {
    image_embeddings: embedding.tensor,
    point_coords: pointCoords,
    point_labels: pointLabels,
    mask_input: maskInput,
    has_mask_input: hasMaskInput,
    orig_im_size: origImSize,
  };
  const outputs = await session.decoderSession.run(feeds);
  const masksTensor = outputs["masks"];
  const iouTensor = outputs["iou_predictions"];
  const iouData = iouTensor.data as Float32Array;

  // masks dims: [1, numMasks, H, W] — pick whichever the model itself
  // scored highest rather than assuming a fixed count/order.
  const dims: number[] = masksTensor.dims;
  const numMasks = dims[1];
  const h = dims[2];
  const w = dims[3];
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < numMasks; i++) {
    if (iouData[i] > bestScore) {
      bestScore = iouData[i];
      bestIdx = i;
    }
  }
  const data = masksTensor.data as Float32Array;
  const planeSize = h * w;
  const offset = bestIdx * planeSize;
  const mask = new Uint8Array(planeSize);
  for (let i = 0; i < planeSize; i++) {
    mask[i] = data[offset + i] > 0 ? 1 : 0; // SAM mask outputs are logits; >0 = foreground
  }
  return { mask, width: w, height: h, score: bestScore };
}
