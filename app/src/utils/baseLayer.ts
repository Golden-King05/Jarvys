// The two base map choices the Layers panel's "Map / Satellite" switch
// picks between — kept here (rather than inline in each MapCanvas) the
// same way radar.ts/lidar.ts hold their own tile constants, so both
// platforms' MapCanvas read the identical URLs/attribution.
export type BaseLayerKind = "map" | "satellite";

export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";

// Esri's free, keyless World Imagery service — the standard free satellite
// basemap for exactly this kind of use, global coverage (confirmed by hand
// down to zoom 21 in a dense US city; unlike the lidar layer's hard
// nationwide zoom-13 cutoff, this has no such uniform ceiling).
export const SATELLITE_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const SATELLITE_ATTRIBUTION = "Esri, Maxar, Earthstar Geographics, and the GIS community";
