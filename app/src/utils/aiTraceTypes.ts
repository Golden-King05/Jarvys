// Shared between OsmEditorMap.web.tsx (which does the real work — capturing
// map imagery, running MobileSAM and the road-centerline CV pipeline) and
// JlosmeScreen.tsx (which just needs to know what banner text/buttons to
// show), plus OsmEditorMap.tsx (native) so its prop types stay compatible
// even though it never actually reports any of these.
export type AiTraceStatus =
  | { kind: "idle" }
  | { kind: "loading-model"; message: string }
  | { kind: "busy"; message: string }
  // A draft (traced polygon or polyline) is ready and awaiting Accept/Discard.
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };
