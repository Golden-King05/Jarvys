import { BASE_URL } from "../AuthContext";

// USGS's own pre-cached shaded-relief tiles (USGSShadedReliefOnly) turned
// out to be a coarse, low-contrast render with nothing cached past zoom 13
// — nowhere near the fine terrain texture (old roads, field lines,
// terracing) that dedicated lidar-detecting apps show, even though it's
// built from the same 3D Elevation Program (3DEP) lidar/DEM data (~99%
// nationwide coverage as of FY2025, much of it down to 1-meter resolution).
// That detail lives in 3DEP's *dynamic* elevation service instead, rendered
// on demand via its "Hillshade Gray-Stretch" function — confirmed by hand
// to produce a dramatically sharper, higher-contrast result at the same
// location. It only speaks bbox-based exportImage requests, not a tile
// scheme, so our own server proxies it into ordinary {z}/{x}/{y} tiles
// (see server/src/lidarTiles.ts), computing each tile's bbox and caching
// the result server-side.
export const USGS_LIDAR_TILE_URL = `${BASE_URL}/lidar-tiles/{z}/{x}/{y}.png`;

export const USGS_LIDAR_ATTRIBUTION = "USGS The National Map: 3D Elevation Program (lidar/DEM)";
