/**
 * Generic admin boundary loader / cache / styling utilities with dong-level support.
 *
 * - `dong` = 읍면동 (Korean eup · myeon · dong), the lowest-level administrative unit.
 *   For other countries it means the equivalent lowest admin level exposed by the
 *   boundary source (e.g. GADM level-3 / geoBoundaries lowest shape, US county
 *   subdivisions, JP oaza/koaza aggregates, etc.).
 * - Engine-agnostic: works with Leaflet / MapLibre / Cesium. Boundary files are
 *   served statically from `public/boundaries/` as GeoJSON.
 * - Sources normalized here: VWorld (CTP/SIG/EMD), GADM (NAME_0..3 / GID_0..3),
 *   Natural Earth (ADMIN / NAME / ISO_A3), geoBoundaries (shapeName / shapeISO).
 */

/** 3-letter country code (ISO 3166-1 alpha-3, e.g. "KOR"). */
export type ISO3 = string;

/** Administrative level. `dong` is 읍면동 and the equivalent lowest level per country. */
export type AdminLevel = "country" | "sido" | "sigungu" | "dong";

/** Normalized display properties for a single boundary feature. */
export interface BoundaryFeatureProperties {
  /** Display name (never empty; falls back to "unknown"). */
  name: string;
  /** Optional English/romanized display name. */
  nameEn?: string;
  /** Stable id (e.g. CTPRVN_CD / SIG_CD / EMD_CD or GADM GID). Never empty. */
  code: string;
  /** Admin level of this feature. */
  level: AdminLevel;
  /** Upper-cased ISO3 of the owning country. */
  countryIso: string;
  /** Any leftover source attributes, stringified. */
  extra?: Record<string, string>;
}

/** FeatureCollection whose features carry normalized boundary properties. */
export type BoundaryGeoJson = GeoJSON.FeatureCollection<
  GeoJSON.Geometry,
  BoundaryFeatureProperties
>;

/** Index entry describing one available boundary file. */
export interface AdminBoundaryIndexEntry {
  iso: string;
  level: AdminLevel;
  url: string;
  count: number;
  bbox: [number, number, number, number];
}

/** Index of available boundary files. */
export type AdminBoundaryIndex = AdminBoundaryIndexEntry[];

/** Korean labels per admin level. */
export const ADMIN_LEVEL_LABEL: Record<AdminLevel, string> = {
  country: "국가",
  sido: "시·도",
  sigungu: "시군구",
  dong: "읍면동",
};

/** Countries with prebuilt boundary files (ISO3). Minimum 9 supported. */
export const SUPPORTED_COUNTRIES: readonly ISO3[] = [
  "KOR",
  "USA",
  "JPN",
  "CHN",
  "VNM",
  "THA",
  "DEU",
  "FRA",
  "GBR",
];

type CountryBBox = {
  iso: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

const COUNTRY_BBOXES: readonly CountryBBox[] = [
  { iso: "KOR", minLon: 124.5, minLat: 33, maxLon: 131.5, maxLat: 43.5 },
  { iso: "JPN", minLon: 129, minLat: 31, maxLon: 146, maxLat: 45.5 },
  { iso: "VNM", minLon: 102, minLat: 8, maxLon: 110, maxLat: 23.5 },
  { iso: "THA", minLon: 97.5, minLat: 5.5, maxLon: 105.5, maxLat: 20.5 },
  { iso: "GBR", minLon: -6, minLat: 49.5, maxLon: 2, maxLat: 59 },
  { iso: "DEU", minLon: 5.5, minLat: 47, maxLon: 15.5, maxLat: 55 },
  { iso: "FRA", minLon: -5, minLat: 41, maxLon: 10, maxLat: 51.5 },
  { iso: "CHN", minLon: 73, minLat: 18, maxLon: 135, maxLat: 53.5 },
  { iso: "USA", minLon: -125, minLat: 24, maxLon: -66.5, maxLat: 49.5 },
  { iso: "USA", minLon: -170, minLat: 51, maxLon: -129, maxLat: 72 },
  { iso: "USA", minLon: -161, minLat: 18.5, maxLon: -154, maxLat: 23 },
];

export function detectCountryByLatLon(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  for (const box of COUNTRY_BBOXES) {
    if (lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat) {
      return box.iso;
    }
  }
  return null;
}

/** Maximum cached boundary documents (LRU via Map insertion order). */
const BOUNDARY_CACHE_LIMIT = 20;

/** In-memory cache keyed by `${ISO}:${level}` (ISO upper-cased). */
const boundaryCache: Map<string, BoundaryGeoJson> = new Map();

const toCacheKey = (iso: string, level: AdminLevel): string => {
  return `${iso.toUpperCase()}:${level}`;
};

/**
 * 한국 행정구역 한글명 매핑 (`public/boundaries/kor_name_ko.json`).
 * 키: 레벨별 shapeID, 값: 한글명. 출처: vuski/admdongkor(통계청 SGIS 기반, CC BY 4.0).
 */
let korNameCache: Record<string, Record<string, string>> | null = null;
let korNamePromise: Promise<Record<string, Record<string, string>>> | null = null;

function ensureKorNames(): Promise<Record<string, Record<string, string>>> {
  if (korNamePromise) {
    return korNamePromise;
  }
  korNamePromise = fetch("/boundaries/kor_name_ko.json", { credentials: "omit" })
    .then((res) => (res.ok ? res.json() : {}))
    .then((json: unknown) => {
      korNameCache =
        typeof json === "object" && json !== null
          ? (json as Record<string, Record<string, string>>)
          : {};
      return korNameCache;
    })
    .catch(() => {
      korNameCache = {};
      return korNameCache;
    });
  return korNamePromise;
}

const createEmptyCollection = (): BoundaryGeoJson => {
  return { type: "FeatureCollection", features: [] };
};

const touchCache = (key: string, value: BoundaryGeoJson): void => {
  if (boundaryCache.has(key)) {
    boundaryCache.delete(key);
  }
  boundaryCache.set(key, value);
  while (boundaryCache.size > BOUNDARY_CACHE_LIMIT) {
    const oldest: string | undefined = boundaryCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    boundaryCache.delete(oldest);
  }
};

/**
 * Resolve the static URL for a boundary file.
 * Country level shares the world file; all other levels are per-country.
 * Prefers TopoJSON (.topojson) when available for 70%+ smaller payloads
 * (kor_dong 6.7MB -> 1.9MB). Falls back to GeoJSON.
 */
export function getBoundaryUrl(iso: string, level: AdminLevel): string {
  if (level === "country") {
    return "/boundaries/world_countries.geojson";
  }
  return `/boundaries/${iso.toLowerCase()}_${level}.geojson`;
}

export function getBoundaryTopoUrl(iso: string, level: AdminLevel): string {
  if (level === "country") {
    return "/boundaries/world_countries.geojson";
  }
  return `/boundaries/${iso.toLowerCase()}_${level}.topojson`;
}

const isTopology = (json: unknown): boolean => {
  return (
    typeof json === "object" &&
    json !== null &&
    (json as { type?: unknown }).type === "Topology" &&
    typeof (json as { objects?: unknown }).objects === "object"
  );
};

const topologyToGeoJson = (topo: unknown): BoundaryGeoJson | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const topoClient = require("topojson-client") as {
      feature: (topo: unknown, obj: unknown) => GeoJSON.FeatureCollection;
    };
    const objects = (topo as { objects: Record<string, unknown> }).objects;
    const firstKey = Object.keys(objects)[0];
    if (!firstKey) return null;
    const fc = topoClient.feature(topo, objects[firstKey]) as unknown as BoundaryGeoJson;
    if (fc.type === "FeatureCollection" && Array.isArray(fc.features)) return fc;
    return null;
  } catch {
    return null;
  }
};

/**
 * Fetch (and cache) a boundary FeatureCollection.
 * Tries TopoJSON first (.topojson, 1.1M) then GeoJSON fallback.
 * Never throws: on 404 / network / parse failure it warns and returns
 * an empty FeatureCollection.
 */
export async function fetchBoundary(
  iso: string,
  level: AdminLevel,
): Promise<BoundaryGeoJson> {
  // 한글명 매핑이 필요하면 정규화 전에 미리 로드한다.
  if (iso.toUpperCase() === "KOR") {
    await ensureKorNames();
  }
  const key: string = toCacheKey(iso, level);
  const cached: BoundaryGeoJson | undefined = boundaryCache.get(key);
  if (cached !== undefined) {
    // Refresh LRU recency.
    boundaryCache.delete(key);
    boundaryCache.set(key, cached);
    return cached;
  }

  const urls: string[] = [getBoundaryTopoUrl(iso, level), getBoundaryUrl(iso, level)].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  for (const url of urls) {
    try {
      const res: Response = await fetch(url, { credentials: "omit" });
      if (!res.ok) {
        if (url === urls[urls.length - 1]) {
          console.warn(`[admin-boundaries] fetch failed (${String(res.status)}): ${url}`);
          const empty: BoundaryGeoJson = createEmptyCollection();
          touchCache(key, empty);
          return empty;
        }
        continue;
      }
      const json: unknown = await res.json();

      if (isTopology(json)) {
        const converted = topologyToGeoJson(json);
        if (converted) {
          touchCache(key, converted as BoundaryGeoJson);
          return converted as BoundaryGeoJson;
        }
        console.warn(`[admin-boundaries] invalid TopoJSON: ${url}`);
        continue;
      }

      if (
        typeof json !== "object" ||
        json === null ||
        (json as { type?: unknown }).type !== "FeatureCollection" ||
        !Array.isArray((json as { features?: unknown }).features)
      ) {
        console.warn(`[admin-boundaries] invalid GeoJSON: ${url}`);
        if (url === urls[urls.length - 1]) {
          const empty: BoundaryGeoJson = createEmptyCollection();
          touchCache(key, empty);
          return empty;
        }
        continue;
      }
      const collection: BoundaryGeoJson = json as BoundaryGeoJson;
      touchCache(key, collection);
      return collection;
    } catch (err: unknown) {
      if (url === urls[urls.length - 1]) {
        console.warn(`[admin-boundaries] fetch error: ${url}`, err);
        return createEmptyCollection();
      }
    }
  }
  return createEmptyCollection();
}

/** Prefer `name`, then `nameEn`, then `code`. Never returns an empty string. */
export function getDisplayName(props: BoundaryFeatureProperties): string {
  const name: string = props.name.trim();
  if (name !== "") {
    return props.name;
  }
  const nameEn: string | undefined = props.nameEn?.trim();
  if (nameEn !== undefined && nameEn !== "") {
    return props.nameEn as string;
  }
  return props.code;
}

/** Leaflet/MapLibre-compatible polygon style for a boundary level + state. */
export interface BoundaryStyle {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWeight: number;
}

const STROKE_UNSELECTED = "#ffffff";
const STROKE_SELECTED = "#ff0000";

/**
 * Style per level. Opacity/weight triplets are [base, hovered, selected].
 * dong (읍면동): opacity 0.12/0.28/0.42, weight 0.6/1.2/2.0.
 */
export function getBoundaryStyle(
  level: AdminLevel,
  isSelected: boolean,
  isHovered: boolean,
): BoundaryStyle {
  let baseOpacity: number;
  let hoverOpacity: number;
  let selectedOpacity: number;
  let baseWeight: number;
  let hoverWeight: number;
  let selectedWeight: number;

  switch (level) {
    case "dong":
      baseWeight = 1.2;
      hoverWeight = 1.8;
      selectedWeight = 2.8;
      break;
    case "sigungu":
      baseWeight = 1.3;
      hoverWeight = 1.9;
      selectedWeight = 2.9;
      break;
    case "sido":
      baseWeight = 1.4;
      hoverWeight = 2.0;
      selectedWeight = 3.0;
      break;
    case "country":
    default:
      baseWeight = 1.5;
      hoverWeight = 2.1;
      selectedWeight = 3.2;
      break;
  }

  const fillColor: string = "transparent";
  const fillOpacity: number = 0;
  const strokeColor: string = isSelected ? STROKE_SELECTED : STROKE_UNSELECTED;
  const strokeWeight: number = isSelected
    ? selectedWeight
    : isHovered
      ? hoverWeight
      : baseWeight;

  return { fillColor, fillOpacity, strokeColor, strokeWeight };
}

type RawRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is RawRecord => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const readString = (raw: RawRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value: unknown = raw[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
};

/**
 * Normalize a raw source feature's properties to {@link BoundaryFeatureProperties}.
 * Handles VWorld (CTP_KOR_NM / SIG_KOR_NM / EMD_KOR_NM + *_CD),
 * GADM (NAME_0..3 / GID_0..3), Natural Earth (ADMIN / NAME / ISO_A3),
 * and geoBoundaries (shapeName / shapeISO). Never yields an empty
 * name/code (falls back to "unknown").
 */
export function normalizeProperties(
  raw: unknown,
  iso: string,
  level: AdminLevel,
): BoundaryFeatureProperties {
  const record: RawRecord = isRecord(raw) ? raw : {};
  const countryIso: string = iso.toUpperCase();

  const levelIndex: number =
    level === "country" ? 0 : level === "sido" ? 1 : level === "sigungu" ? 2 : 3;

  // VWorld Korean names/codes per level.
  const vworldNameKeys: string[] =
    level === "dong"
      ? ["EMD_KOR_NM", "EMD_CD_NM", "emd_kor_nm"]
      : level === "sigungu"
        ? ["SIG_KOR_NM", "SIG_CD_NM", "sig_kor_nm"]
        : level === "sido"
          ? ["CTP_KOR_NM", "CTPRVN_KOR_NM", "ctp_kor_nm"]
          : ["CTP_ENG_NM", "ctp_eng_nm"];
  const vworldCodeKeys: string[] =
    level === "dong"
      ? ["EMD_CD", "emd_cd"]
      : level === "sigungu"
        ? ["SIG_CD", "sig_cd"]
        : level === "sido"
          ? ["CTPRVN_CD", "CTP_CD", "ctp_cd"]
          : ["ISO_A3", "iso_a3"];

  // GADM names/codes: prefer the deepest available up to this level.
  const gadmNameKeys: string[] = [];
  const gadmCodeKeys: string[] = [];
  for (let i: number = levelIndex; i >= 0; i -= 1) {
    gadmNameKeys.push(`NAME_${String(i)}`, `name_${String(i)}`);
    gadmCodeKeys.push(`GID_${String(i)}`, `gid_${String(i)}`);
  }

  const code: string =
    readString(record, vworldCodeKeys) ??
    readString(record, gadmCodeKeys) ??
    readString(record, ["shapeISO", "shapeID", "ISO_A3", "iso_a3", "ADM0_A3", "id", "ID", "code", "CODE"]) ??
    "unknown";

  // 한국(KOR)은 geoBoundaries 영문명 대신 한글명 매핑을 우선 사용한다.
  const koName: string | undefined =
    countryIso === "KOR" ? korNameCache?.[level]?.[code] : undefined;

  const name: string =
    koName ??
    readString(record, vworldNameKeys) ??
    readString(record, gadmNameKeys) ??
    readString(record, ["shapeName", "ADMIN", "NAME", "name", "Name"]) ??
    "unknown";

  const nameEn: string | undefined =
    readString(record, ["ENG_NM", "eng_nm", `NAME_${String(levelIndex)}`, "name_en", "NAME_EN"]) ??
    readString(record, ["ADMIN", "NAME"]) ??
    undefined;

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      extra[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      extra[key] = String(value);
    }
  }

  const normalized: BoundaryFeatureProperties = {
    name,
    code,
    level,
    countryIso,
    extra,
  };
  if (nameEn !== undefined) {
    normalized.nameEn = nameEn;
  }
  return normalized;
}

// ---- 한국 읍면동 고해상도 타일 (scripts/build-dong-boundaries-hd.mjs) ----
// 전국 단순화본(kor_dong.topojson) 위에, 확대 시 화면 근처 타일의 고해상도 기하로
// 같은 shapeID 피처를 교체한다. 타일 = 0.2° 그리드, 동은 bbox 중심 타일 하나에만 속한다.

/** 고해상도 타일을 적용하기 시작하는 지도 줌 레벨. */
export const DONG_HD_MIN_ZOOM = 12;

/** 한 번에 불러올 타일 상한 (모바일 메모리·네트워크 보호). */
const DONG_HD_MAX_TILES_PER_REQUEST = 16;

const DONG_HD_BASE_URL = "/boundaries/kor_dong_hd";

interface DongHdIndex {
  v: number;
  tileDeg: number;
  tiles: Record<string, { b: [number, number, number, number]; n: number }>;
}

let dongHdIndexPromise: Promise<DongHdIndex | null> | null = null;
const dongHdTileCache: Map<string, Promise<GeoJSON.Feature[]>> = new Map();

function loadDongHdIndex(): Promise<DongHdIndex | null> {
  if (dongHdIndexPromise) {
    return dongHdIndexPromise;
  }
  dongHdIndexPromise = fetch(`${DONG_HD_BASE_URL}/index.json`, { credentials: "omit" })
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown): DongHdIndex | null => {
      if (
        isRecord(json) &&
        typeof json["tileDeg"] === "number" &&
        isRecord(json["tiles"])
      ) {
        return json as unknown as DongHdIndex;
      }
      return null;
    })
    .catch(() => null);
  return dongHdIndexPromise;
}

function fetchDongHdTile(id: string): Promise<GeoJSON.Feature[]> {
  const cached = dongHdTileCache.get(id);
  if (cached) {
    return cached;
  }
  const promise = fetch(`${DONG_HD_BASE_URL}/${encodeURIComponent(id)}.topojson`, { credentials: "omit" })
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown): GeoJSON.Feature[] => {
      if (!isTopology(json)) {
        return [];
      }
      return topologyToGeoJson(json)?.features ?? [];
    })
    .catch((): GeoJSON.Feature[] => {
      // 실패한 타일은 다음 요청에서 재시도한다.
      dongHdTileCache.delete(id);
      return [];
    });
  dongHdTileCache.set(id, promise);
  return promise;
}

/** 경위도 사각형(들)과 겹치는 고해상도 타일 id 목록 (가까운 순, 상한 적용). */
export async function findDongHdTiles(
  boxes: ReadonlyArray<{ west: number; south: number; east: number; north: number }>,
): Promise<string[]> {
  const index = await loadDongHdIndex();
  if (!index || boxes.length === 0) {
    return [];
  }
  const hits: Array<{ id: string; d: number }> = [];
  for (const [id, tile] of Object.entries(index.tiles)) {
    const [w, s, e, n] = tile.b;
    let best = Infinity;
    for (const box of boxes) {
      if (e < box.west || w > box.east || n < box.south || s > box.north) {
        continue;
      }
      const d =
        Math.abs((w + e) / 2 - (box.west + box.east) / 2) + Math.abs((s + n) / 2 - (box.south + box.north) / 2);
      best = Math.min(best, d);
    }
    if (Number.isFinite(best)) {
      hits.push({ id, d: best });
    }
  }
  hits.sort((a, b) => a.d - b.d);
  return hits.slice(0, DONG_HD_MAX_TILES_PER_REQUEST).map((h) => h.id);
}

/** 고해상도 타일의 원본 피처들 (properties는 geoBoundaries 원본: shapeID/shapeName...). */
export async function fetchDongHdFeatures(tileIds: readonly string[]): Promise<GeoJSON.Feature[]> {
  const lists = await Promise.all(tileIds.map((id) => fetchDongHdTile(id)));
  return lists.flat();
}
