const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// onnxruntime-web (the AI building tracer's ONNX runtime) ships .wasm
// binaries. We don't actually ask Metro to bundle/serve them for this
// app — instead we point onnxruntime-web at a CDN build of the same
// version at runtime (see app/src/utils/mobileSam.ts's ORT_VERSION/
// wasmPaths) — that sidesteps a known Metro/onnxruntime-web friction
// point where getting the wasm binary reachable at the right URL after
// bundling takes extra wiring. This is kept anyway as a defensive measure
// in case some future dependency does try to `import`/`require` a .wasm
// file directly: without it, Metro doesn't know how to handle that
// extension at all and bundling would fail outright rather than degrade
// gracefully.
config.resolver.assetExts = [...config.resolver.assetExts, "wasm"];

module.exports = config;
