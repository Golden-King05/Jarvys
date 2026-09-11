import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import MapCanvas, { type MapCanvasHandle } from "../components/MapCanvas";
import OsmClusterModal from "../components/OsmClusterModal";
import OsmTagPicker from "../components/OsmTagPicker";
import PointDetailModal from "../components/PointDetailModal";
import RegionDetailModal from "../components/RegionDetailModal";
import RegionLegend from "../components/RegionLegend";
import TagsEditor from "../components/TagsEditor";
import WikipediaClusterModal from "../components/WikipediaClusterModal";
import {
  api,
  isSavedPoint,
  type MapData,
  type MapPoint,
  type OsmElement,
  type Point,
  type PointTag,
  type RegionMapData,
  type TagDefinition,
  type WikipediaCluster,
} from "../api";
import { useAuth } from "../AuthContext";
import { fonts } from "../theme";
import {
  clusterOsmElements,
  inferOsmCategory,
  osmElementKey,
  osmElementName,
  OSM_CATEGORY_OPTIONS,
  suggestOsmIcon,
  type OsmCluster,
} from "../utils/osm";
import { suggestIcon } from "../utils/suggestIcon";

interface MapScreenProps {
  mapData: MapData | null;
  onVerifyMap: () => void;
  // Lifted up to App.tsx so they survive this screen unmounting on tab
  // switch, and so the assistant's set_map_layer tool (handled in App.tsx)
  // can change them regardless of which tab is active.
  showRadar: boolean;
  setShowRadar: (v: boolean) => void;
  showTimezoneBands: boolean;
  setShowTimezoneBands: (v: boolean) => void;
  showPins: boolean;
  setShowPins: (v: boolean) => void;
  showFlights: boolean;
  setShowFlights: (v: boolean) => void;
  showWikipedia: boolean;
  setShowWikipedia: (v: boolean) => void;
  showOsm: boolean;
  setShowOsm: (v: boolean) => void;
}

type AddStep = "closed" | "choose" | "manual-coords" | "url" | "details" | "osm-import" | "awaiting-tap";

function toMapPoint(p: Point): MapPoint {
  return {
    id: p.id,
    label: p.name,
    lat: p.lat,
    lon: p.lon,
    icon: p.icon,
    category: p.category || undefined,
    subcategory: p.subcategory || undefined,
    urls: p.urls,
    blurb: p.blurb,
    tags: p.tags,
  };
}

// --- Historic-brand search matching (see findHistoricBrandMatch below) ---
// Lowercases, drops apostrophes so "McDonald's"/"Mcdonalds" collapse to the
// same word, and splits everything else on word boundaries so punctuation
// (hyphens, commas, "Fort Wayne, Indiana") never blocks a match.
function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// A couple of letters swapped or dropped shouldn't sink a match — "Frist"
// for "First", "Mcdonlads" for "Mcdonalds" — but short words need an exact
// hit or everything starts looking alike.
function wordsFuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  const threshold = shortest <= 3 ? 0 : shortest <= 6 ? 1 : 2;
  return editDistance(a, b) <= threshold;
}

// Every one of `needleTokens` (a brand's words, or a city/state name's
// words) has to show up somewhere in `haystackTokens` (the search query),
// fuzzily — but haystackTokens can freely carry extra words (an
// unmatched "first"/"frist", a trailing location) without breaking it.
function tokensFuzzyContain(haystackTokens: string[], needleTokens: string[]): boolean {
  if (needleTokens.length === 0) return false;
  return needleTokens.every((needle) => haystackTokens.some((hay) => wordsFuzzyEqual(hay, needle)));
}

// Ranks how well a search matches a brand/name: exact > the old
// substring-either-way check > a fuzzy, typo-tolerant token match. -1 means
// no match at all.
function fuzzyMatchRank(candidate: string, queryTokens: string[]): number {
  const candidateTokens = normalizeTokens(candidate);
  if (candidateTokens.length === 0) return -1;
  const candidateBlob = candidateTokens.join(" ");
  const queryBlob = queryTokens.join(" ");
  if (queryBlob === candidateBlob) return 3;
  if (queryBlob.includes(candidateBlob) || candidateBlob.includes(queryBlob)) return 2;
  if (tokensFuzzyContain(queryTokens, candidateTokens)) return 1;
  return -1;
}

// Splits a search like "first mcdonald's in fort wayne, indiana" into the
// brand part and a trailing place name, on the last standalone "in" — so
// the brand match and the location match run independently instead of the
// location text having to appear verbatim next to the brand.
function splitLocationSuffix(query: string): { brandQuery: string; locationQuery: string | null } {
  const match = query.match(/^(.*)\bin\b\s+(.+)$/i);
  if (!match || !match[1].trim() || !match[2].trim()) return { brandQuery: query, locationQuery: null };
  return { brandQuery: match[1].trim(), locationQuery: match[2].trim() };
}

// The brand_historic_location values this feature surfaces, and how much
// each is worth when nothing else (an explicit location match) breaks a
// tie — a true "first" beats a same-brand point that's merely first *in one
// country* (country) or *in one city* (municipality, narrower still than
// country) or split across two locations (the with/without-name pair,
// tied with plain "first" since both are still global claims).
const HISTORIC_RANK: Record<string, number> = {
  first: 4,
  first_with_name: 3,
  first_without_name: 3,
  country: 2,
  municipality: 1,
};

export default function MapScreen({
  mapData,
  onVerifyMap,
  showRadar,
  setShowRadar,
  showTimezoneBands,
  setShowTimezoneBands,
  showPins,
  setShowPins,
  showFlights,
  setShowFlights,
  showWikipedia,
  setShowWikipedia,
  showOsm,
  setShowOsm,
}: MapScreenProps) {
  const { baseUrl, token } = useAuth();
  const mapCanvasRef = useRef<MapCanvasHandle>(null);
  const [initialRegion, setInitialRegion] = useState<{ latitude: number; longitude: number } | undefined>();
  const [points, setPoints] = useState<Point[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<Point | MapPoint | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionMapData | null>(null);
  const [selectedWikiCluster, setSelectedWikiCluster] = useState<WikipediaCluster | null>(null);

  // Raw OSM elements fetched by the "Query" button — kept as a flat,
  // deduped-by-id list (not pre-clustered) so repeated queries as the user
  // pans around merge cleanly; clusterOsmElements groups them for display.
  // Deliberately not polled like flights/Wikipedia — querying live OSM data
  // is a deliberate action, not something that should keep re-fetching.
  const [osmElements, setOsmElements] = useState<OsmElement[]>([]);
  const osmClusters = useMemo(() => clusterOsmElements(osmElements), [osmElements]);
  const [osmQuerying, setOsmQuerying] = useState(false);
  const [osmStatus, setOsmStatus] = useState<string | null>(null);
  const [selectedOsmCluster, setSelectedOsmCluster] = useState<OsmCluster | null>(null);
  // Which OSM tag keys "Query" asks for — the settings gear between the
  // Query/Delete excess buttons narrows this from "every named element in
  // view" (all of OSM_CATEGORY_OPTIONS selected, the default) down to just
  // the categories actually wanted, since an unfiltered query was what was
  // timing out on a busy viewport.
  const [osmCategories, setOsmCategories] = useState<string[]>(OSM_CATEGORY_OPTIONS.map((o) => o.key));
  const [showOsmSettings, setShowOsmSettings] = useState(false);
  const [osmDraft, setOsmDraft] = useState<{
    element: OsmElement;
    name: string;
    category: string;
    subcategory: string;
    icon: string;
    otherTags: Record<string, string>;
    selectedTagKeys: string[];
  } | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<MapPoint | null>(null);
  const [flyToTarget, setFlyToTarget] = useState<{ lat: number; lon: number } | null>(null);
  // Set instead of going through geocoding when the search matches a saved
  // point tagged as a brand's first (or convoluted-first) location — see
  // findHistoricBrandMatch below.
  const [historicInfo, setHistoricInfo] = useState<{ icon: string; name: string; message: string } | null>(null);

  // Not lifted to App.tsx like the other layers — there's no reason for the
  // AI chat to toggle this the way it toggles radar/pins/flights, and
  // dropping the GPS watch when the user leaves the Map tab (rather than
  // keeping it running app-wide) is the behavior you'd actually want.
  const [showLiveLocation, setShowLiveLocation] = useState(false);
  const [liveLocationError, setLiveLocationError] = useState<string | null>(null);

  const [addStep, setAddStep] = useState<AddStep>("closed");
  const [pendingLocation, setPendingLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [pendingUrlFinish, setPendingUrlFinish] = useState<{
    url: string;
    name?: string;
    category?: string;
    subcategory?: string;
    icon?: string;
    tags?: PointTag[];
  } | null>(null);
  const [manualCoords, setManualCoords] = useState({ lat: "", lon: "" });
  const [urlDraft, setUrlDraft] = useState<{
    url: string;
    name: string;
    category: string;
    subcategory: string;
    icon: string;
    tags: PointTag[];
  }>({ url: "", name: "", category: "", subcategory: "", icon: "", tags: [] });
  const [detailsDraft, setDetailsDraft] = useState<{
    name: string;
    category: string;
    subcategory: string;
    icon: string;
    blurb: string;
    tags: PointTag[];
  }>({ name: "", category: "", subcategory: "", icon: "📍", blurb: "", tags: [] });
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [tagDefinitions, setTagDefinitions] = useState<TagDefinition[]>([]);
  // Once someone types their own icon, stop overwriting it with suggestions
  // based on category/subcategory — reset whenever a form is reopened.
  const urlIconLocked = useRef(false);
  const detailsIconLocked = useRef(false);

  function updateUrlDraft(patch: Partial<typeof urlDraft>) {
    setUrlDraft((d) => {
      const next = { ...d, ...patch };
      if (!urlIconLocked.current) {
        const suggestion = suggestIcon(next.category, next.subcategory);
        if (suggestion) next.icon = suggestion;
      }
      return next;
    });
  }

  function updateDetailsDraft(patch: Partial<typeof detailsDraft>) {
    setDetailsDraft((d) => {
      const next = { ...d, ...patch };
      if (!detailsIconLocked.current) {
        const suggestion = suggestIcon(next.category, next.subcategory);
        if (suggestion) next.icon = suggestion;
      }
      return next;
    });
  }

  const [showLayers, setShowLayers] = useState(false);

  // Below this zoom, saved points stay hidden — with enough of them saved,
  // a fully zoomed-out view turns into an unreadable wall of overlapping
  // emoji. Zooming in past roughly a metro-area view reveals them.
  const MIN_PIN_ZOOM = 8;
  const [focusSignal, setFocusSignal] = useState(0);
  // Set once this screen's own first loadPoints() (below) resolves, so the
  // camera fits to the saved points exactly once per visit to this tab —
  // MapCanvas is told not to guess this itself (autoFitOnFirstLoad={false}
  // below) because "points went from empty to non-empty" describes an
  // ordinary add/edit's own refresh just as well as a first load, and
  // guessing from that shape occasionally mistook one for the other,
  // snapping the camera back to fit every saved point mid-edit.
  const hasFitOnLoad = useRef(false);

  useEffect(() => {
    if (mapData) return; // The AI's plotted points drive the view instead once there are any.
    (async () => {
      try {
        // Only a status check, never a request — iOS shows its native
        // permission dialog exactly once per install, and spending that on
        // a passive "center the map" convenience (before the user has done
        // anything that actually needs location) meant the Live location
        // toggle's own first tap found permission already burned, jumping
        // straight to "go to Settings" instead of ever showing the prompt.
        // If permission isn't already granted, the map just opens to its
        // default view — the toggle is the one thing allowed to ask.
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") return;
        const position = await Location.getCurrentPositionAsync({});
        setInitialRegion({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      } catch {
        // No location available — the map just falls back to its default view.
      }
    })();
  }, [mapData]);

  async function loadPoints() {
    if (!token) return;
    try {
      const { points: rows } = await api.getPoints(baseUrl, token);
      setPoints(rows);
      if (!hasFitOnLoad.current) {
        hasFitOnLoad.current = true;
        setFocusSignal((n) => n + 1);
      }
    } catch {
      // A failed refresh just leaves the last-known list on screen.
    }
  }

  // Every tag header already in use — refreshed after a save so a header
  // typed just now shows up as a suggestion for the next point too.
  async function loadTagKeys() {
    if (!token) return;
    try {
      const { keys } = await api.getTagKeys(baseUrl, token);
      setTagKeys(keys);
    } catch {
      // No suggestions if this fails — the tag editor still works.
    }
  }

  useEffect(() => {
    loadTagKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token]);

  // Static reference data (the documented tag vocabulary) — loaded once
  // rather than refreshed after every save like the account's own tagKeys.
  useEffect(() => {
    if (!token) return;
    api
      .getTagDefinitions(baseUrl, token)
      .then(({ definitions }) => setTagDefinitions(definitions))
      .catch(() => {
        // No autofill if this fails — the tag editor still works.
      });
  }, [baseUrl, token]);

  useEffect(() => {
    loadPoints();
    // Re-pull whenever a new search backs up fresh points server-side.
    // Also nudges the map to re-center on this new result — but only for a
    // genuinely new mapData (this effect's whole dependency), never just
    // because the points list itself refreshed after an edit or a drag.
    if (mapData) setFocusSignal((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData]);

  function closeAddFlow() {
    setAddStep("closed");
    setPendingLocation(null);
    setPendingUrlFinish(null);
    setManualCoords({ lat: "", lon: "" });
    setUrlDraft({ url: "", name: "", category: "", subcategory: "", icon: "", tags: [] });
    setDetailsDraft({ name: "", category: "", subcategory: "", icon: "📍", blurb: "", tags: [] });
    setOsmDraft(null);
    urlIconLocked.current = false;
    detailsIconLocked.current = false;
    setAddError(null);
  }

  // Shortcut from the Wikipedia layer's "Add to my map" button — the URL
  // already carries the article's own blurb and coordinates (via
  // /points/from-url), so this just pre-fills the same URL-import form used
  // elsewhere — including the name, since otherwise it wouldn't be visible
  // or editable until after saving — letting the user rename it and pick a
  // category, subcategory, emoji, and tags before saving.
  function handleAddWikipediaArticle(url: string, title: string) {
    urlIconLocked.current = false;
    setUrlDraft({ url, name: title, category: "", subcategory: "", icon: "", tags: [] });
    setAddStep("url");
  }

  // The Layers panel's "Query" button — pulls current-viewport OSM data via
  // the map's ref (rather than polling, since browsing raw OSM data is a
  // deliberate, on-demand action) and merges it into the running set, deduped
  // by element so pressing it again after panning accumulates rather than
  // duplicates.
  async function queryOsm() {
    if (!token) return;
    if (osmCategories.length === 0) {
      setOsmStatus("Pick at least one category in OSM settings first.");
      return;
    }
    const bounds = await mapCanvasRef.current?.getViewportBounds();
    if (!bounds) return;
    setOsmQuerying(true);
    setOsmStatus(null);
    try {
      const { elements, areaTooLarge } = await api.getNearbyOsm(baseUrl, token, bounds, osmCategories);
      setOsmElements((prev) => {
        const merged = new Map(prev.map((e) => [osmElementKey(e), e]));
        for (const el of elements) merged.set(osmElementKey(el), el);
        return [...merged.values()];
      });
      setOsmStatus(
        areaTooLarge
          ? "Zoomed out too far for full coverage — zoom in and query again for more."
          : elements.length === 0
            ? "No named OSM data found in view."
            : null
      );
    } catch (e) {
      setOsmStatus(e instanceof Error ? e.message : "Failed to query OpenStreetMap data");
    } finally {
      setOsmQuerying(false);
    }
  }

  // The Layers panel's "Delete excess" button — clears whatever's still
  // sitting on the OSM layer unimported. Anything the user did add already
  // left this list the moment it was imported (see handleImportOsmElement),
  // so everything left here is by definition "not added".
  function deleteExcessOsm() {
    setOsmElements([]);
    setOsmStatus(null);
  }

  // Opens the import form for one specific OSM element, pre-filled from its
  // own tags — a category/subcategory guessed from whichever OSM key most
  // often says what a place is, an icon suggested from that, and every
  // other raw tag offered as a pickable (not yet selected) point tag.
  function handleAddOsmElement(element: OsmElement) {
    const { category, subcategory } = inferOsmCategory(element.tags);
    const { name: _name, ...otherTags } = element.tags;
    setOsmDraft({
      element,
      name: osmElementName(element),
      category,
      subcategory,
      icon: suggestOsmIcon(category, subcategory) ?? "📍",
      otherTags,
      selectedTagKeys: [],
    });
    setAddStep("osm-import");
  }

  async function submitOsmImport() {
    if (!osmDraft || !token) return;
    if (!osmDraft.name.trim()) {
      setAddError("Give it a name.");
      return;
    }
    setSubmitting(true);
    setAddError(null);
    try {
      await api.createPoint(baseUrl, token, {
        name: osmDraft.name.trim(),
        category: osmDraft.category.trim(),
        subcategory: osmDraft.subcategory.trim(),
        icon: osmDraft.icon.trim() || "📍",
        lat: osmDraft.element.lat,
        lon: osmDraft.element.lon,
        tags: osmDraft.selectedTagKeys.map((key) => ({ key, value: osmDraft.otherTags[key] })),
      });
      const importedKey = osmElementKey(osmDraft.element);
      setOsmElements((prev) => prev.filter((e) => osmElementKey(e) !== importedKey));
      await loadPoints();
      await loadTagKeys();
      closeAddFlow();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add point");
    } finally {
      setSubmitting(false);
    }
  }

  // A saved point tagged brand_historic_location (first / first_without_name
  // / first_with_name / municipality) is a landmark in its own right —
  // searching the brand name should surface it directly instead of just
  // geocoding an address, no AI call needed since it's a straight lookup
  // over already-loaded points. Matches on the brand tag when present (the
  // chain's real name), falling back to the point's own name otherwise, and
  // tolerates typos/misspellings in either the brand or a trailing place
  // name ("first mcdonalds in fort wayne indiana") via fuzzyMatchRank.
  function findHistoricBrandMatch(query: string): { point: Point; message: string } | null {
    const { brandQuery, locationQuery } = splitLocationSuffix(query.trim());
    const queryTokens = normalizeTokens(brandQuery);
    if (queryTokens.length === 0) return null;
    const locationTokens = locationQuery ? normalizeTokens(locationQuery) : null;

    let best: { point: Point; brand: string; historicValue: string; score: number } | null = null;
    for (const p of points) {
      const historic = p.tags.find((t) => t.key.toLowerCase() === "brand_historic_location")?.value;
      if (!historic) continue;
      const values = historic.split(";").map((v) => v.trim().toLowerCase());
      const historicValue = Object.keys(HISTORIC_RANK).find((v) => values.includes(v));
      if (!historicValue) continue;

      const brand = p.tags.find((t) => t.key.toLowerCase() === "brand")?.value ?? p.name;
      const brandRank = fuzzyMatchRank(brand, queryTokens);
      if (brandRank < 0) continue;

      // A location was named ("...in Fort Wayne, Indiana") — this point has
      // to actually be there, checked against its own
      // addr:city/addr:state/addr:country, or it's not a real match no
      // matter how well the brand matched.
      let locationBonus = 0;
      if (locationTokens) {
        const city = p.tags.find((t) => t.key.toLowerCase() === "addr:city")?.value;
        const state = p.tags.find((t) => t.key.toLowerCase() === "addr:state")?.value;
        const country = p.tags.find((t) => t.key.toLowerCase() === "addr:country")?.value;
        const cityMatched = !!city && tokensFuzzyContain(locationTokens, normalizeTokens(city));
        const stateMatched = !!state && tokensFuzzyContain(locationTokens, normalizeTokens(state));
        const countryMatched = !!country && tokensFuzzyContain(locationTokens, normalizeTokens(country));
        if (!cityMatched && !stateMatched && !countryMatched) continue;
        // A state named alongside a matching city is what disambiguates two
        // same-named cities in different states — worth far more than the
        // brand/tag tiers below so it always wins the tie-break. A country
        // match alone is the broadest, least specific signal, so it counts
        // for less than a city/state match.
        locationBonus = (cityMatched ? 100 : 0) + (stateMatched ? 100 : 0) + (countryMatched ? 50 : 0);
      }

      const score = locationBonus + HISTORIC_RANK[historicValue] * 10 + brandRank;
      if (!best || score > best.score) {
        best = { point: p, brand, historicValue, score };
      }
    }
    if (!best) return null;

    const startDate = best.point.tags.find((t) => t.key.toLowerCase() === "start_date")?.value;
    const city = best.point.tags.find((t) => t.key.toLowerCase() === "addr:city")?.value;
    const country = best.point.tags.find((t) => t.key.toLowerCase() === "addr:country")?.value;
    const headline =
      best.historicValue === "first"
        ? `This is the first ${best.brand}.`
        : best.historicValue === "first_with_name"
          ? `The first official ${best.brand} is here.`
          : best.historicValue === "first_without_name"
            ? `This would become ${best.brand}'s first location.`
            : best.historicValue === "country"
              ? `This is the first ${best.brand}${country ? ` in ${country}` : ""}.`
              : `This is the first ${best.brand}${city ? ` in ${city}` : ""}.`;
    const message = startDate ? `${headline} It was established in ${startDate}.` : headline;
    return { point: best.point, message };
  }

  async function handleSearch() {
    const query = searchQuery.trim();
    if (!query || !token) return;
    setSearchError(null);

    const historicMatch = findHistoricBrandMatch(query);
    if (historicMatch) {
      const { point, message } = historicMatch;
      setHistoricInfo({ icon: point.icon, name: point.name, message });
      setSearchResult({ label: point.name, lat: point.lat, lon: point.lon, icon: point.icon });
      setFlyToTarget({ lat: point.lat, lon: point.lon });
      return;
    }
    setHistoricInfo(null);

    setSearching(true);
    try {
      const found = await api.geocode(baseUrl, token, query);
      setSearchResult({ label: found.name, lat: found.lat, lon: found.lon, icon: "🔍" });
      // A fresh object every search — even re-searching the same place —
      // so the flyTo effect always re-triggers, independent of whatever
      // other points (saved pins elsewhere, etc.) are currently on screen.
      setFlyToTarget({ lat: found.lat, lon: found.lon });
    } catch (e) {
      setSearchResult(null);
      setSearchError(e instanceof Error ? e.message : "Location not found");
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchResult(null);
    setSearchError(null);
    setHistoricInfo(null);
  }

  async function toggleLiveLocation(value: boolean) {
    if (!value) {
      setShowLiveLocation(false);
      setLiveLocationError(null);
      return;
    }
    if (Platform.OS === "web") {
      // expo-location's web support is incomplete — its permission-check
      // functions don't reliably call through to the browser's actual
      // geolocation API, so they can report "not granted" without ever
      // triggering Safari's real permission prompt (confirmed: clearing
      // Safari's site data and retrying still showed no prompt and stayed
      // off). Going straight to the browser's own navigator.geolocation is
      // the same primitive MapCanvas.web.tsx already uses successfully for
      // the live marker itself, and it's what actually triggers the
      // browser's native permission dialog on a first call.
      if (!("geolocation" in navigator)) {
        setLiveLocationError("This browser doesn't support location.");
        return;
      }
      navigator.geolocation.getCurrentPosition(
        () => {
          setLiveLocationError(null);
          setShowLiveLocation(true);
        },
        () => {
          setLiveLocationError(
            'Location access is blocked for this site — tap the "aA" icon in Safari\'s address bar → Website Settings → Location, or clear this site\'s data under Settings → Safari → Advanced → Website Data, then try again.'
          );
        },
        { timeout: 10000 }
      );
      return;
    }
    try {
      // Same reasoning as the mic permission fix — iOS only ever shows its
      // native dialog once per install, so check the current status first
      // rather than blindly requesting every time, and send the user to
      // Settings directly once a request would just silently no-op.
      let permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) {
        permission = await Location.requestForegroundPermissionsAsync();
      }
      if (!permission.granted) {
        if (!permission.canAskAgain) {
          Linking.openSettings();
        }
        setLiveLocationError("Location access is off for Jarvys — enable it in Settings to show your live position.");
        return;
      }
      setLiveLocationError(null);
      setShowLiveLocation(true);
    } catch {
      setLiveLocationError("Couldn't get location permission.");
    }
  }

  async function finishUrlImport(lat: number, lon: number) {
    if (!pendingUrlFinish || !token) return;
    setSubmitting(true);
    setAddError(null);
    try {
      const result = await api.createPointFromUrl(baseUrl, token, { ...pendingUrlFinish, lat, lon });
      if (result.needsLocation) {
        setAddError("Still couldn't place that link — try different coordinates.");
      } else {
        await loadPoints();
        closeAddFlow();
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to import URL");
    } finally {
      setSubmitting(false);
    }
  }

  function handleMapPress(lat: number, lon: number) {
    if (addStep !== "awaiting-tap") return;
    if (pendingUrlFinish) {
      finishUrlImport(lat, lon);
    } else {
      setPendingLocation({ lat, lon });
      setAddStep("details");
    }
  }

  function submitManualCoords() {
    const lat = Number(manualCoords.lat);
    const lon = Number(manualCoords.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setAddError("Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    setAddError(null);
    if (pendingUrlFinish) {
      finishUrlImport(lat, lon);
    } else {
      setPendingLocation({ lat, lon });
      setAddStep("details");
    }
  }

  async function submitDetails() {
    if (!pendingLocation || !token) return;
    if (!detailsDraft.name.trim()) {
      setAddError("Give it a name.");
      return;
    }
    setSubmitting(true);
    setAddError(null);
    try {
      await api.createPoint(baseUrl, token, {
        name: detailsDraft.name.trim(),
        category: detailsDraft.category.trim(),
        subcategory: detailsDraft.subcategory.trim(),
        icon: detailsDraft.icon.trim() || "📍",
        lat: pendingLocation.lat,
        lon: pendingLocation.lon,
        blurb: detailsDraft.blurb.trim(),
        tags: detailsDraft.tags
          .map((t) => ({ key: t.key.trim(), value: t.value.trim() }))
          .filter((t) => t.key && t.value),
      });
      await loadPoints();
      await loadTagKeys();
      closeAddFlow();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add point");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitUrl() {
    if (!urlDraft.url.trim() || !token) {
      setAddError("Enter a URL.");
      return;
    }
    setSubmitting(true);
    setAddError(null);
    try {
      const payload = {
        url: urlDraft.url.trim(),
        name: urlDraft.name.trim() || undefined,
        category: urlDraft.category.trim() || undefined,
        subcategory: urlDraft.subcategory.trim() || undefined,
        icon: urlDraft.icon.trim() || undefined,
        tags: urlDraft.tags.map((t) => ({ key: t.key.trim(), value: t.value.trim() })).filter((t) => t.key && t.value),
      };
      const result = await api.createPointFromUrl(baseUrl, token, payload);
      if (result.needsLocation) {
        setPendingUrlFinish(payload);
        setAddStep("awaiting-tap");
        setAddError(null);
      } else {
        await loadPoints();
        closeAddFlow();
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to import URL");
    } finally {
      setSubmitting(false);
    }
  }

  // MapCanvas only knows about MapPoint mirrors (from toMapPoint), not the
  // real saved Point objects — resolve back to the real Point by id so
  // isSavedPoint (and therefore Edit/Delete) actually works. Without this,
  // selectedPoint was always the mirror, which lacks the `createdAt` field
  // isSavedPoint checks for, so editing was never reachable from a tap.
  function handlePointPress(point: MapPoint) {
    const saved = point.id ? points.find((p) => p.id === point.id) : undefined;
    setSelectedPoint(saved ?? point);
  }

  async function handleDeleteSelected() {
    if (!selectedPoint || !isSavedPoint(selectedPoint) || !token) return;
    try {
      await api.deletePoint(baseUrl, token, selectedPoint.id);
      await loadPoints();
    } catch {
      // Leave the point selected if the delete failed — nothing to reconcile.
    } finally {
      setSelectedPoint(null);
    }
  }

  async function handleSaveSelected(patch: {
    name: string;
    category: string;
    subcategory: string;
    icon: string;
    blurb: string;
    urls: string[];
    tags: PointTag[];
  }) {
    if (!selectedPoint || !isSavedPoint(selectedPoint) || !token) return;
    const updated = await api.updatePoint(baseUrl, token, selectedPoint.id, patch);
    await loadPoints();
    await loadTagKeys();
    setSelectedPoint(updated);
  }

  async function handlePointDragEnd(point: MapPoint, lat: number, lon: number) {
    if (!point.id || !token) return;
    try {
      await api.updatePoint(baseUrl, token, point.id, { lat, lon });
      await loadPoints();
    } catch {
      // A failed drag just leaves the pin wherever it was before the next
      // refresh — no local rollback needed since we never moved local state.
    }
  }

  // Memoized so MapCanvas only sees a new `points` array reference when the
  // underlying data actually changes — otherwise every render (e.g. just
  // opening the detail popup, which only touches selectedPoint) would
  // rebuild this array, and MapCanvas's "fit to all points" effect would
  // re-fire and re-zoom out to fit everything, every time.
  const markers = useMemo(() => {
    const savedMarkers = points.map(toMapPoint);
    const withDistance = mapData?.kind === "distance" ? [...savedMarkers, ...mapData.points] : savedMarkers;
    return searchResult ? [...withDistance, searchResult] : withDistance;
  }, [points, mapData, searchResult]);
  const regions = mapData?.kind === "regions" ? mapData.regions : undefined;
  const hasStatusLegend = regions?.some((r) => r.status) ?? false;

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <MapCanvas
          ref={mapCanvasRef}
          points={markers}
          showLine={mapData?.kind === "distance"}
          regions={regions}
          initialRegion={initialRegion}
          onMapPress={handleMapPress}
          onPointPress={handlePointPress}
          onRegionPress={setSelectedRegion}
          onPointDragEnd={handlePointDragEnd}
          pendingMarker={addStep === "details" ? pendingLocation : null}
          showRadar={showRadar}
          showTimezoneBands={showTimezoneBands}
          showPins={showPins}
          showFlights={showFlights}
          showWikipedia={showWikipedia}
          onWikipediaClusterPress={setSelectedWikiCluster}
          showOsm={showOsm}
          osmClusters={osmClusters}
          onOsmClusterPress={setSelectedOsmCluster}
          showLiveLocation={showLiveLocation}
          minPinZoom={MIN_PIN_ZOOM}
          focusKey={focusSignal}
          flyTo={flyToTarget}
          autoFitOnFirstLoad={false}
        />

        {showOsm ? (
          <View style={styles.osmBar}>
            <View style={styles.osmButtonRow}>
              <TouchableOpacity
                style={[styles.osmButton, osmQuerying && styles.osmButtonDisabled]}
                onPress={queryOsm}
                disabled={osmQuerying}
              >
                <Text style={styles.osmButtonText}>{osmQuerying ? "Querying…" : "Query"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.osmSettingsButton}
                onPress={() => setShowOsmSettings(true)}
                hitSlop={8}
              >
                <Ionicons name="settings-outline" size={18} color="#444" />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.osmButton, styles.osmButtonSecondary, osmElements.length === 0 && styles.osmButtonDisabled]}
                onPress={deleteExcessOsm}
                disabled={osmElements.length === 0}
              >
                <Text style={[styles.osmButtonText, styles.osmButtonSecondaryText]}>Delete excess</Text>
              </TouchableOpacity>
            </View>
            {osmStatus ? <Text style={styles.osmStatusText}>{osmStatus}</Text> : null}
          </View>
        ) : null}

        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search for a place or address"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
            autoCapitalize="none"
          />
          {searchQuery || searchResult ? (
            <TouchableOpacity onPress={clearSearch} hitSlop={8} style={styles.searchClearButton}>
              <Text style={styles.searchClearText}>✕</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={handleSearch} disabled={searching} style={styles.searchButton}>
            <Text style={styles.searchButtonText}>{searching ? "…" : "🔍"}</Text>
          </TouchableOpacity>
        </View>
        {searchError ? (
          <View style={styles.searchErrorBanner}>
            <Text style={styles.searchErrorText}>{searchError}</Text>
          </View>
        ) : null}
        {historicInfo ? (
          <View style={styles.historicBanner}>
            <View style={styles.historicBannerBody}>
              <Text style={styles.historicBannerTitle}>
                {historicInfo.icon} {historicInfo.name}
              </Text>
              <Text style={styles.historicBannerText}>{historicInfo.message}</Text>
            </View>
            <TouchableOpacity onPress={() => setHistoricInfo(null)} hitSlop={8}>
              <Text style={styles.searchClearText}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {addStep === "awaiting-tap" ? (
          <View style={styles.tapBanner}>
            <Text style={styles.tapBannerText}>Tap the map to place your point</Text>
            <TouchableOpacity onPress={closeAddFlow}>
              <Text style={styles.tapBannerCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity style={styles.layersButton} onPress={() => setShowLayers(true)}>
          <Text style={styles.layersButtonText}>🗂️</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.addButton} onPress={() => setAddStep("choose")}>
          <Text style={styles.addButtonText}>+</Text>
        </TouchableOpacity>
      </View>

      {hasStatusLegend ? <RegionLegend /> : null}

      {mapData?.kind === "regions" ? (
        mapData.verified ? (
          <Text style={styles.verifiedLabel}>✓ Verified state-by-state</Text>
        ) : (
          <TouchableOpacity style={styles.verifyButton} onPress={onVerifyMap}>
            <Text style={styles.verifyButtonText}>Verify Map</Text>
          </TouchableOpacity>
        )
      ) : null}

      {mapData && mapData.kind === "distance" && mapData.distanceMiles != null ? (
        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>
            {mapData.points[0]?.label} to {mapData.points[1]?.label}: {mapData.distanceMiles.toLocaleString()} mi (
            {mapData.distanceKm?.toLocaleString()} km)
          </Text>
        </View>
      ) : null}

      <PointDetailModal
        point={selectedPoint}
        onClose={() => setSelectedPoint(null)}
        onDelete={selectedPoint && isSavedPoint(selectedPoint) ? handleDeleteSelected : undefined}
        onSave={selectedPoint && isSavedPoint(selectedPoint) ? handleSaveSelected : undefined}
      />
      <RegionDetailModal region={selectedRegion} onClose={() => setSelectedRegion(null)} />

      <Modal visible={showLayers} transparent animationType="fade" onRequestClose={() => setShowLayers(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Layers</Text>
              <TouchableOpacity onPress={() => setShowLayers(false)} hitSlop={8}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>Saved pins</Text>
                <Text style={styles.layerHint}>Hidden until zoomed in, even when on</Text>
              </View>
              <Switch value={showPins} onValueChange={setShowPins} />
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>Weather radar</Text>
                <Text style={styles.layerHint}>Live precipitation (RainViewer)</Text>
              </View>
              <Switch value={showRadar} onValueChange={setShowRadar} />
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>Time zones</Text>
                <Text style={styles.layerHint}>Approximate — not exact borders</Text>
              </View>
              <Switch value={showTimezoneBands} onValueChange={setShowTimezoneBands} />
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>Live flights</Text>
                <Text style={styles.layerHint}>Nearby aircraft (OpenSky), updates periodically</Text>
              </View>
              <Switch value={showFlights} onValueChange={setShowFlights} />
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>Wikipedia</Text>
                <Text style={styles.layerHint}>Browse nearby articles right on the map</Text>
              </View>
              <Switch value={showWikipedia} onValueChange={setShowWikipedia} />
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>OpenStreetMap</Text>
                <Text style={styles.layerHint}>Query raw OSM data in view and import what you want</Text>
              </View>
              <Switch value={showOsm} onValueChange={setShowOsm} />
            </View>

            <View style={styles.layerRow}>
              <View style={styles.layerLabelBox}>
                <Text style={styles.layerLabel}>Live location</Text>
                <Text style={styles.layerHint}>
                  {liveLocationError ?? "Show your current position, updating as you move"}
                </Text>
              </View>
              <Switch value={showLiveLocation} onValueChange={toggleLiveLocation} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showOsmSettings}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOsmSettings(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>OSM query settings</Text>
              <TouchableOpacity onPress={() => setShowOsmSettings(false)} hitSlop={8}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.osmSettingsHint}>
              Which kinds of OSM data "Query" looks for — fewer categories means a faster, less likely to
              time out query.
            </Text>
            <View style={styles.osmSelectAllRow}>
              <TouchableOpacity onPress={() => setOsmCategories(OSM_CATEGORY_OPTIONS.map((o) => o.key))}>
                <Text style={styles.osmSelectAllText}>Select all</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setOsmCategories([])}>
                <Text style={styles.osmSelectAllText}>Unselect all</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.osmCategoryList}>
              {OSM_CATEGORY_OPTIONS.map((option) => {
                const checked = osmCategories.includes(option.key);
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={styles.osmCategoryRow}
                    onPress={() =>
                      setOsmCategories((prev) =>
                        checked ? prev.filter((k) => k !== option.key) : [...prev, option.key]
                      )
                    }
                  >
                    <View style={[styles.osmCheckbox, checked && styles.osmCheckboxChecked]}>
                      {checked ? <Text style={styles.osmCheckboxMark}>✓</Text> : null}
                    </View>
                    <Text style={styles.osmCategoryLabel}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <WikipediaClusterModal
        cluster={selectedWikiCluster}
        onClose={() => setSelectedWikiCluster(null)}
        onAddToMap={handleAddWikipediaArticle}
      />

      <OsmClusterModal
        cluster={selectedOsmCluster}
        onClose={() => setSelectedOsmCluster(null)}
        onAddToMap={handleAddOsmElement}
      />

      <Modal
        visible={addStep === "choose"}
        transparent
        animationType="fade"
        onRequestClose={closeAddFlow}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add a point</Text>
            <TouchableOpacity style={styles.choiceButton} onPress={() => setAddStep("awaiting-tap")}>
              <Text style={styles.choiceText}>Tap on the map</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.choiceButton} onPress={() => setAddStep("manual-coords")}>
              <Text style={styles.choiceText}>Enter coordinates</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.choiceButton} onPress={() => setAddStep("url")}>
              <Text style={styles.choiceText}>Import from a URL</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={closeAddFlow} style={styles.cancelLink}>
              <Text style={styles.cancelLinkText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={addStep === "manual-coords"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Coordinates</Text>
            <TextInput
              style={styles.input}
              placeholder="Latitude"
              keyboardType="numeric"
              value={manualCoords.lat}
              onChangeText={(v) => setManualCoords((c) => ({ ...c, lat: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Longitude"
              keyboardType="numeric"
              value={manualCoords.lon}
              onChangeText={(v) => setManualCoords((c) => ({ ...c, lon: v }))}
            />
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitManualCoords}>
                <Text style={styles.submitButtonText}>Next</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={addStep === "url"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <ScrollView style={styles.card} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={styles.cardTitle}>Import from a URL</Text>
            <TextInput
              style={styles.input}
              placeholder="https://…"
              autoCapitalize="none"
              value={urlDraft.url}
              onChangeText={(v) => setUrlDraft((d) => ({ ...d, url: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Name (optional) — auto-detected from the page"
              value={urlDraft.name}
              onChangeText={(v) => setUrlDraft((d) => ({ ...d, name: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Category (optional)"
              value={urlDraft.category}
              onChangeText={(v) => updateUrlDraft({ category: v })}
            />
            <TextInput
              style={styles.input}
              placeholder="Subcategory (optional)"
              value={urlDraft.subcategory}
              onChangeText={(v) => updateUrlDraft({ subcategory: v })}
            />
            <TextInput
              style={styles.input}
              placeholder="Icon emoji (optional) — auto-suggested from category"
              value={urlDraft.icon}
              onChangeText={(v) => {
                urlIconLocked.current = true;
                setUrlDraft((d) => ({ ...d, icon: v }));
              }}
            />
            <TagsEditor
              tags={urlDraft.tags}
              onChange={(tags) => setUrlDraft((d) => ({ ...d, tags }))}
              suggestedKeys={tagKeys}
              tagDefinitions={tagDefinitions}
            />
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitUrl} disabled={submitting}>
                <Text style={styles.submitButtonText}>{submitting ? "Importing…" : "Import"}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={addStep === "details"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <ScrollView style={styles.card} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={styles.cardTitle}>Details</Text>
            {pendingLocation ? (
              <Text style={styles.coordsLabel}>
                {pendingLocation.lat.toFixed(5)}, {pendingLocation.lon.toFixed(5)}
              </Text>
            ) : null}
            <TextInput
              style={styles.input}
              placeholder="Name"
              value={detailsDraft.name}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, name: v }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Category (e.g. restaurant)"
              value={detailsDraft.category}
              onChangeText={(v) => updateDetailsDraft({ category: v })}
            />
            <TextInput
              style={styles.input}
              placeholder="Subcategory (e.g. Chinese fusion restaurant)"
              value={detailsDraft.subcategory}
              onChangeText={(v) => updateDetailsDraft({ subcategory: v })}
            />
            <TextInput
              style={styles.input}
              placeholder="Icon emoji — auto-suggested from category"
              value={detailsDraft.icon}
              onChangeText={(v) => {
                detailsIconLocked.current = true;
                setDetailsDraft((d) => ({ ...d, icon: v }));
              }}
            />
            <TextInput
              style={[styles.input, styles.blurbInput]}
              placeholder="Notes (optional)"
              multiline
              value={detailsDraft.blurb}
              onChangeText={(v) => setDetailsDraft((d) => ({ ...d, blurb: v }))}
            />
            <TagsEditor
              tags={detailsDraft.tags}
              onChange={(tags) => setDetailsDraft((d) => ({ ...d, tags }))}
              suggestedKeys={tagKeys}
              tagDefinitions={tagDefinitions}
            />
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitDetails} disabled={submitting}>
                <Text style={styles.submitButtonText}>{submitting ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={addStep === "osm-import"} transparent animationType="fade" onRequestClose={closeAddFlow}>
        <View style={styles.overlay}>
          <ScrollView style={styles.card} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={styles.cardTitle}>Add from OpenStreetMap</Text>
            {osmDraft ? (
              <>
                <Text style={styles.coordsLabel}>
                  {osmDraft.element.osmType} {osmDraft.element.osmId} · {osmDraft.element.lat.toFixed(5)},{" "}
                  {osmDraft.element.lon.toFixed(5)}
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="Name"
                  value={osmDraft.name}
                  onChangeText={(v) => setOsmDraft((d) => (d ? { ...d, name: v } : d))}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Category"
                  value={osmDraft.category}
                  onChangeText={(v) => setOsmDraft((d) => (d ? { ...d, category: v } : d))}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Subcategory"
                  value={osmDraft.subcategory}
                  onChangeText={(v) => setOsmDraft((d) => (d ? { ...d, subcategory: v } : d))}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Icon emoji"
                  value={osmDraft.icon}
                  onChangeText={(v) => setOsmDraft((d) => (d ? { ...d, icon: v } : d))}
                />
                <OsmTagPicker
                  tags={osmDraft.otherTags}
                  selectedKeys={osmDraft.selectedTagKeys}
                  onChange={(selectedTagKeys) => setOsmDraft((d) => (d ? { ...d, selectedTagKeys } : d))}
                />
              </>
            ) : null}
            {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
            <View style={styles.formButtons}>
              <TouchableOpacity onPress={closeAddFlow}>
                <Text style={styles.cancelLinkText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitButton} onPress={submitOsmImport} disabled={submitting}>
                <Text style={styles.submitButtonText}>{submitting ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapWrap: { flex: 1 },
  addButton: {
    position: "absolute",
    right: 16,
    bottom: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#2980b9",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    // Leaflet's own zoom/attribution controls carry z-index: 1000 inside a
    // container div that doesn't establish its own stacking context on web,
    // so without this the map's controls render above this button even
    // though it's a later sibling.
    zIndex: 1000,
  },
  addButtonText: { color: "#fff", fontSize: 28, lineHeight: 30, fontFamily: fonts.medium },
  layersButton: {
    position: "absolute",
    left: 16,
    bottom: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    zIndex: 1000,
  },
  layersButtonText: { fontSize: 22 },
  osmBar: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 80,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 10,
    elevation: 4,
    zIndex: 1000,
  },
  osmButtonRow: { flexDirection: "row", gap: 10 },
  osmButton: {
    flex: 1,
    backgroundColor: "#2980b9",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  osmButtonSecondary: { backgroundColor: "#fdecea" },
  osmButtonDisabled: { opacity: 0.5 },
  osmButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
  osmButtonSecondaryText: { color: "#c0392b" },
  osmStatusText: { fontFamily: fonts.regular, fontSize: 11, color: "#888", marginTop: 8 },
  osmSettingsButton: {
    width: 38,
    borderRadius: 8,
    backgroundColor: "#f0f0f0",
    alignItems: "center",
    justifyContent: "center",
  },
  osmSettingsHint: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginBottom: 10 },
  osmSelectAllRow: { flexDirection: "row", gap: 16, marginBottom: 10 },
  osmSelectAllText: { fontFamily: fonts.medium, fontSize: 12, color: "#2980b9" },
  osmCategoryList: { maxHeight: 320 },
  osmCategoryRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  osmCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#ccc",
    alignItems: "center",
    justifyContent: "center",
  },
  osmCheckboxChecked: { backgroundColor: "#2980b9", borderColor: "#2980b9" },
  osmCheckboxMark: { color: "#fff", fontSize: 13, fontFamily: fonts.medium },
  osmCategoryLabel: { fontFamily: fonts.regular, fontSize: 13, color: "#333", flex: 1 },
  tapBanner: {
    position: "absolute",
    top: 68,
    left: 12,
    right: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    elevation: 4,
    zIndex: 1000,
  },
  tapBannerText: { fontFamily: fonts.medium, fontSize: 13, color: "#222" },
  tapBannerCancel: { fontFamily: fonts.medium, fontSize: 13, color: "#c0392b" },
  searchBar: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingLeft: 12,
    elevation: 4,
    zIndex: 1000,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    paddingVertical: 12,
  },
  searchClearButton: { paddingHorizontal: 8 },
  searchClearText: { fontFamily: fonts.medium, fontSize: 14, color: "#888" },
  searchButton: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderLeftWidth: 1,
    borderLeftColor: "#eee",
  },
  searchButtonText: { fontSize: 16 },
  searchErrorBanner: {
    position: "absolute",
    top: 60,
    left: 12,
    right: 12,
    backgroundColor: "#fdecea",
    borderWidth: 1,
    borderColor: "#f0b4ac",
    borderRadius: 8,
    padding: 8,
    zIndex: 1000,
  },
  searchErrorText: { fontFamily: fonts.regular, fontSize: 12, color: "#8a291d" },
  historicBanner: {
    position: "absolute",
    top: 60,
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e0c98a",
    borderRadius: 8,
    padding: 10,
    elevation: 4,
    zIndex: 1000,
  },
  historicBannerBody: { flex: 1 },
  historicBannerTitle: { fontFamily: fonts.semiBold, fontSize: 13, color: "#222", marginBottom: 2 },
  historicBannerText: { fontFamily: fonts.regular, fontSize: 12, color: "#555" },
  infoBox: { padding: 12, borderTopWidth: 1, borderTopColor: "#eee" },
  verifyButton: { alignSelf: "center", paddingVertical: 8 },
  verifyButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#2980b9" },
  verifiedLabel: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: "#27ae60",
    textAlign: "center",
    paddingVertical: 8,
  },
  infoTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: "#222" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, width: 320, maxWidth: "90%", maxHeight: "80%" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: "#222", marginBottom: 14 },
  closeIcon: { fontFamily: fonts.medium, fontSize: 16, color: "#888" },
  layerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  layerLabelBox: { flex: 1, marginRight: 12 },
  layerLabel: { fontFamily: fonts.medium, fontSize: 14, color: "#222" },
  layerHint: { fontFamily: fonts.regular, fontSize: 11, color: "#888", marginTop: 2 },
  choiceButton: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  choiceText: { fontFamily: fonts.medium, fontSize: 14, color: "#2980b9" },
  cancelLink: { marginTop: 14, alignSelf: "flex-start" },
  cancelLinkText: { fontFamily: fonts.medium, fontSize: 13, color: "#888" },
  input: {
    fontFamily: fonts.regular,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
  },
  blurbInput: { minHeight: 90, textAlignVertical: "top" },
  coordsLabel: { fontFamily: fonts.regular, fontSize: 12, color: "#888", marginBottom: 10 },
  errorText: { fontFamily: fonts.regular, fontSize: 12, color: "#c0392b", marginBottom: 8 },
  formButtons: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  submitButton: { backgroundColor: "#2980b9", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  submitButtonText: { fontFamily: fonts.medium, fontSize: 13, color: "#fff" },
});
