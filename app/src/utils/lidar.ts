// USGS's own shaded-relief basemap tile service, built from 3D Elevation
// Program (3DEP) lidar/DEM data — the nationwide 1-meter lidar mosaic 3DEP
// has been assembling reached ~99% coverage in FY2025, and this service is
// the ready-to-use rendered result of it (a raw point-cloud layer isn't
// something a map tile can show directly). Public, keyless, pre-cached
// (a real tile pyramid, not rendered per-request), and refreshed as 3DEP's
// own source data updates.
export const USGS_LIDAR_TILE_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}";

export const USGS_LIDAR_ATTRIBUTION = "USGS The National Map: 3D Elevation Program (lidar/DEM)";
