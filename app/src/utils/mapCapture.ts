// Captures a raster snapshot of the live Leaflet map — whatever's actually
// rendered on screen, base layer plus any active overlay (e.g. the lidar
// hillshade) — by drawing Leaflet's own already-loaded tile <img> elements
// onto an offscreen canvas, rather than re-fetching tiles ourselves. This
// avoids a duplicate fetch and guarantees exact pixel alignment with what
// the user actually sees. Used by the building tracer (mobileSam.ts), which
// wants "whatever satellite/lidar imagery is currently on screen around the
// click." The road tracer instead fetches both satellite and lidar tiles
// directly by URL (tileMosaic.ts) since it needs both sources regardless of
// which one the user has toggled visible.
//
// Requires every tile layer's <img> elements to have crossOrigin set (done
// in OsmEditorMap.web.tsx's createBaseLayer/lidar tileLayer) — otherwise
// the canvas is "tainted" and getImageData() throws a SecurityError. That
// throw is left to propagate; callers surface it as a friendly error.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Leaflet = any;

export interface CapturedRegion {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pixelToLatLon: (x: number, y: number) => { lat: number; lon: number };
  latLonToPixel: (lat: number, lon: number) => { x: number; y: number };
}

// Captures a `sizePx` x `sizePx` square centered on `centerContainerPoint`
// (a Leaflet container point, i.e. CSS pixels from the map container's
// top-left — what map.latLngToContainerPoint()/mouse-click coordinates use).
export function captureMapRegion(map: Leaflet, centerContainerPoint: { x: number; y: number }, sizePx: number): CapturedRegion {
  const container: HTMLElement = map.getContainer();
  const containerRect = container.getBoundingClientRect();
  const originX = centerContainerPoint.x - sizePx / 2;
  const originY = centerContainerPoint.y - sizePx / 2;

  const canvas = document.createElement("canvas");
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Every loaded tile <img>, across every tile layer (base + overlays),
  // in DOM order — which matches Leaflet's own stacking order since each
  // tileLayer appends its own layer <div> after previously-added ones.
  const tileImgs = container.querySelectorAll<HTMLImageElement>(".leaflet-tile-pane img.leaflet-tile-loaded");
  tileImgs.forEach((img) => {
    const r = img.getBoundingClientRect();
    // Position relative to the map container, in the same CSS-pixel space
    // as `centerContainerPoint`, resolved by the browser through however
    // many nested CSS transforms Leaflet has applied — no need to walk
    // those transforms by hand.
    const sx = r.left - containerRect.left;
    const sy = r.top - containerRect.top;
    const dx = sx - originX;
    const dy = sy - originY;
    // Skip tiles that don't overlap the capture rect at all.
    if (dx + r.width < 0 || dy + r.height < 0 || dx > sizePx || dy > sizePx) return;
    try {
      ctx.drawImage(img, dx, dy, r.width, r.height);
    } catch {
      // A single bad tile shouldn't abort the whole capture; the resulting
      // gap just won't have any imagery for the model to work with there.
    }
  });

  return {
    canvas,
    width: sizePx,
    height: sizePx,
    pixelToLatLon: (x, y) => {
      const ll = map.containerPointToLatLng([originX + x, originY + y]);
      return { lat: ll.lat, lon: ll.lng };
    },
    latLonToPixel: (lat, lon) => {
      const cp = map.latLngToContainerPoint([lat, lon]);
      return { x: cp.x - originX, y: cp.y - originY };
    },
  };
}
