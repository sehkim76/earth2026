"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import type { Circle, LayerGroup, Map as LeafletMap, MapOptions, Marker } from "leaflet";
import * as THREE from "three";

import Supercluster from "supercluster";
import type * as CesiumTypes from "cesium";

const CESIUM_CDN_BASE = "https://cdn.jsdelivr.net/npm/cesium@1.146.0/Build/Cesium";

const loadCesium = async (): Promise<typeof import("cesium")> => {
  if (typeof window === "undefined") {
    throw new Error("Cesium is client-only");
  }
  const win = window as unknown as { Cesium?: typeof import("cesium") };
  if (win.Cesium) {
    return win.Cesium;
  }
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(
      `script[src="${CESIUM_CDN_BASE}/Cesium.js"]`
    ) as HTMLScriptElement | null;
    if (existing) {
      if ((window as unknown as { Cesium?: unknown }).Cesium) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Cesium script load failed")));
      return;
    }
    const script = document.createElement("script");
    script.src = `${CESIUM_CDN_BASE}/Cesium.js`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Cesium script load failed"));
    document.head.appendChild(script);
  });
  const loaded = (window as unknown as { Cesium?: typeof import("cesium") }).Cesium;
  if (!loaded) {
    throw new Error("Cesium failed to load");
  }
  return loaded;
};

import Ranking, { type RankingItem } from "@/components/Ranking";
import { clearAllGameSnapshots } from "@/lib/snapshots";
import { positionAtMoveTarget, type UnitMoveTarget } from "@/lib/units";
import { neutralLegSubpath } from "@/lib/neutral-leg";
import {
  ADMIN_LEVEL_LABEL,
  DONG_HD_MIN_ZOOM,
  SUPPORTED_COUNTRIES,
  detectCountryByLatLon,
  fetchBoundary,
  fetchDongHdFeatures,
  findDongHdTiles,
  getBoundaryStyle,
  getDisplayName,
  normalizeProperties,
  type AdminLevel,
} from "@/lib/admin-boundaries";
import {
  DEFAULT_MAP_USER_SETTINGS,
  type MapStyle,
  type MapUserSettings,
  type PlayerCharacter,
} from "@/lib/map-settings";
import { cn } from "@/lib/utils";
import TerritoryUI, { LORD_UNIT_ID } from "@/components/territory/TerritoryUI";

import { clampWalkableMove, snapToNearestWalkableLocation } from "@/lib/walkable-client";
import {
  ensureWalkableData,
  ensureWalkableIndex,
  ensureWalkableLocation,
  ensureWalkableSelectedDong,
  getAdjacentDongIds,
  getWalkableDongIdsAt,
  ensureWalkableRaster,
  getWalkableOverlayTilesBestEffort,
  getWalkablePendingDongs,
  prefetchWalkableRasters,
  subscribeWalkableData,
  wlog,
  type GridFull,
} from "@/lib/walkable-client";
import {
  createWalkableCanvasLayer,
  getWalkableCompositeUrls,
} from "@/lib/walkable-overlay";
import TerritoryDash from "@/components/territory/TerritoryDash";
import TerritoryStartPicker, { type TerritoryStart } from "@/components/TerritoryStartPicker";
import type { CastleBuildDraft } from "@/components/territory/TerritoryUI";

// MapLibre globe renderer structural types. The runtime loads
// `maplibre-gl` via a variable dynamic import so this file still
// typechecks when the package is not installed; globe mode then falls
// back to satellite with a console warning.
type GlobePoiFeatureProperties = {
  id: number;
  label: string;
  eventKey: string;
  eventType: string;
  visited: boolean;
};

type GlobePoiFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: GlobePoiFeatureProperties;
};

type GlobePoiGeoJsonData = {
  type: "FeatureCollection";
  features: GlobePoiFeature[];
};

type GlobeClusterSourceLike = {
  setData: (data: GlobePoiGeoJsonData) => void;
  getClusterExpansionZoom: (
    clusterId: number,
    callback: (error: unknown, zoom: number | null | undefined) => void
  ) => void;
};

type GlobeRenderedFeatureLike = {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown> | null;
};

type GlobeMapMouseEventLike = {
  point?: unknown;
  lngLat?: { lng: number; lat: number };
  features?: GlobeRenderedFeatureLike[];
};

type GlobeLayerEventHandler = (event: GlobeMapMouseEventLike) => void;
type GlobeLoadEventHandler = () => void;

type GlobeLayerSpecLike = {
  id: string;
  type: string;
  source: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

type GlobeMapLike = {
  remove: () => void;
  setCenter: (center: [number, number]) => void;
  getCenter: () => { lng: number; lat: number };
  resize: () => void;
  getZoom: () => number;
  setZoom: (zoom: number) => void;
  zoomIn: (options?: unknown) => void;
  zoomOut: (options?: unknown) => void;
  getBounds: () => {
    getWest: () => number;
    getSouth: () => number;
    getEast: () => number;
    getNorth: () => number;
  };
  easeTo: (options: { center?: [number, number]; zoom?: number }) => void;
  getCanvas: () => HTMLCanvasElement;
  on: {
    (event: string, handler: GlobeLoadEventHandler): void;
    (event: string, layer: string, handler: GlobeLayerEventHandler): void;
  };
  off: {
    (event: string, handler: GlobeLoadEventHandler): void;
    (event: string, layer: string, handler: GlobeLayerEventHandler): void;
  };
  addSource: (
    id: string,
    source:
      | {
          type: "geojson";
          data: GlobePoiGeoJsonData;
          cluster: boolean;
          clusterRadius: number;
          clusterMaxZoom: number;
        }
      | {
          type: "geojson";
          data: unknown;
        }
      | {
          type: "image";
          url: string;
          coordinates: number[][];
        }
  ) => void;
  getSource: (id: string) => (GlobeClusterSourceLike & { setData: (data: unknown) => void }) | undefined;
  removeSource: (id: string) => void;
  addImage: (id: string, image: HTMLImageElement) => void;
  hasImage: (id: string) => boolean;
  addLayer: (layer: GlobeLayerSpecLike) => void;
  getLayer: (id: string) => unknown;
  removeLayer: (id: string) => void;
  setPaintProperty: (layerId: string, name: string, value: unknown) => void;
  queryRenderedFeatures: (
    point?: unknown,
    options?: { layers?: string[] }
  ) => GlobeRenderedFeatureLike[];
};

type GlobeMarkerLike = {
  setLngLat: (lngLat: [number, number]) => GlobeMarkerLike;
  addTo: (map: GlobeMapLike) => GlobeMarkerLike;
  remove: () => void;
};

type GlobeMapConstructor = new (options: {
  container: HTMLElement;
  style: unknown;
  center: [number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  projection: unknown;
}) => GlobeMapLike;

type GlobeMarkerConstructor = new (options?: {
  element?: HTMLElement;
  color?: string;
  anchor?: string;
}) => GlobeMarkerLike;

const MAPLIBRE_MODULE_ID = "maplibre-gl";
const GLOBE_SATELLITE_TILES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];
const GLOBE_DEFAULT_ZOOM = 15;
const GLOBE_STYLE_ID = "globe-satellite-style";
const ADMIN_GLOBE_SOURCE_ID = "admin-boundaries";
/** 메모리에 유지할 고해상도 동 타일 상한 (초과 시 오래된 타일부터 단순화본으로 복귀). */
const DONG_HD_TILE_LIMIT = 32;
/** 행정경계 전용 Leaflet pane (canvas 렌더러, overlayPane(400) 위·markerPane(600) 아래). */
const ADMIN_LEAFLET_PANE = "adminBoundaryPane";
const ADMIN_GLOBE_FILL_LAYER_ID = "admin-fill";
const ADMIN_GLOBE_LINE_LAYER_ID = "admin-line";

type GeoResult = {
  lat: number;
  lon: number;
  accuracy?: number;
  timestamp?: number;
};

type NearbyPlayer = {
  userId: string;
  nickname: string;
  lat: number;
  lon: number;
  updatedAt: string;
  selectedCharacter: PlayerCharacter;
};

type NearbyPlayerMarkerEntry = {
  marker: Marker;
  dispose: () => void;
  selectedCharacter: PlayerCharacter;
};

type Status = "idle" | "loading" | "success" | "error";

type LocationPermissionState = "granted" | "prompt" | "denied" | "unsupported" | null;

type MapPoint = {
  id: number;
  lat: number;
  lon: number;
  label?: string;
  eventType?: string;
  eventKey?: string;
};

type CurrentLocationMapProps = {
  locationCacheKey: string;
  className?: string;
  points?: MapPoint[];
  playerNickname?: string;
  playerScore?: number;
  rankingItems?: RankingItem[];
  rankingNickname?: string;
  initialShowRanking?: boolean;
  debugEventTypes?: Record<string, string | null>;
  initialSettings?: MapUserSettings;
  visitedEventKeys?: string[];
  visitedScores?: Record<string, number>;
  showEventRevisitedDialog?: boolean;
  attackDeniedReason?: string | null;
  territoryEnabled?: boolean;
  missionKey?: string;
};

type MarkerPanel = {
  title: string;
  lines: string[];
  wildId?: number;
  eventKey?: string;
  confirmTarget?: string;
  confirmLabel?: string;
  exitUrl?: string;
  isProximity?: boolean;
  lat?: number;
  lon?: number;
};

const MARKER_CELEBRATED_STORAGE_KEY = "marker-celebrated";
const CELEBRATE_REPLAY_GRACE_MS = 1000;
const NEUTRAL_DAMAGE_ANIMATION_MS = 60_000;
const NEUTRAL_DAMAGE_FRAME_URLS = [1, 2, 3, 4].map(
  (frame) => `/markers/neutral-castle-v2-damaged-${frame}.png`,
);
const SOLDIER_IDLE_FRAME_URLS = Array.from(
  { length: 8 },
  (_, index) => `/markers/soldier_idle_${String(index + 1).padStart(2, "0")}.png`,
);
const SOLDIER_WALK_FRAME_URLS = Array.from(
  { length: 8 },
  (_, index) => `/markers/soldier_walk_${String(index + 1).padStart(2, "0")}.png`,
);
const OUTLAW_FRAME_URLS = Array.from(
  { length: 8 },
  (_, index) => `/markers/outlaw_walk_${String(index + 1).padStart(2, "0")}.png`,
);
const territorySoldierImages = new Set<HTMLImageElement>();
const territoryOutlawImages = new Set<HTMLImageElement>();
let territorySoldierAnimationTimer: number | null = null;
// 지도 드래그·줌 중 스프라이트 stepping 일시정지 (getBoundingClientRect 강제 리플로우 방지).
let territoryAnimPaused = false;
export const setTerritoryAnimPaused = (paused: boolean): void => {
  territoryAnimPaused = paused;
};
// 프레임 PNG를 최초 1회 fetch→blob URL로 상주시켜 이후 src 교체가 네트워크 없이 메모리에서 해결되게 한다.
const frameObjectUrls = new Map<string, string>();
const framePreloading = new Set<string>();
const resolveFrameUrl = (url: string): string => frameObjectUrls.get(url) ?? url;
const ensureFramesPreloaded = (urls: string[]): void => {
  if (typeof window === "undefined") {
    return;
  }
  const pending = urls.filter((url) => !frameObjectUrls.has(url) && !framePreloading.has(url));
  if (pending.length === 0) {
    return;
  }
  for (const url of pending) {
    framePreloading.add(url);
  }
  void Promise.all(
    pending.map(async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return;
        }
        const objectUrl = URL.createObjectURL(await response.blob());
        frameObjectUrls.set(url, objectUrl);
        // 디코딩까지 미리 끝내 실제 교체 시점에 깜빡임이 없게 한다.
        const warmup = new Image();
        warmup.src = objectUrl;
      } catch {
        // 실패 시 원본 URL 폴백 (기존 동작 유지).
      }
    }),
  );
};
const ensureSoldierFramesPreloaded = (): void => {
  ensureFramesPreloaded([...SOLDIER_IDLE_FRAME_URLS, ...SOLDIER_WALK_FRAME_URLS]);
};
const ensureOutlawFramesPreloaded = (): void => {
  ensureFramesPreloaded(OUTLAW_FRAME_URLS);
};
const resolveSoldierFrameUrl = (url: string): string => resolveFrameUrl(url);
// 화면 밖 마커의 src 교체는 건너뛴다 (디코드·페인트 절약). 여유 64px.
const stepFrameImage = (
  image: HTMLImageElement,
  urls: string[],
  frameIndex: number,
  viewportWidth: number,
  viewportHeight: number,
): void => {
  const rect = image.getBoundingClientRect();
  const offscreen =
    rect.width === 0 ||
    rect.bottom < -64 ||
    rect.top > viewportHeight + 64 ||
    rect.right < -64 ||
    rect.left > viewportWidth + 64;
  if (!offscreen) {
    image.src = resolveFrameUrl(urls[frameIndex]);
  }
  image.dataset.frameIndex = String(frameIndex);
};

const registerTerritorySoldierAnimation = (root: ParentNode | null): void => {
  if (typeof window === "undefined" || !root) return;
  ensureSoldierFramesPreloaded();
  ensureOutlawFramesPreloaded();
  if (root instanceof HTMLImageElement) {
    if (root.classList.contains("territory-soldier-idle")) {
      territorySoldierImages.add(root);
    }
    if (root.classList.contains("territory-outlaw")) {
      territoryOutlawImages.add(root);
    }
  }
  root.querySelectorAll<HTMLImageElement>("img.territory-soldier-idle").forEach((image) => {
    territorySoldierImages.add(image);
  });
  root.querySelectorAll<HTMLImageElement>("img.territory-outlaw").forEach((image) => {
    territoryOutlawImages.add(image);
  });
  if (
    territorySoldierAnimationTimer !== null ||
    (territorySoldierImages.size === 0 && territoryOutlawImages.size === 0)
  ) {
    return;
  }
  territorySoldierAnimationTimer = window.setInterval(() => {
    if (territoryAnimPaused) {
      return;
    }
    const frameTick = Math.floor(Date.now() / 120);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    territorySoldierImages.forEach((image) => {
      if (!image.isConnected) {
        territorySoldierImages.delete(image);
        return;
      }
      // 이동 중 마커는 걷기 프레임, 정지 중 마커는 기본 프레임을 사용한다.
      const urls = image.dataset.walk === "1" ? SOLDIER_WALK_FRAME_URLS : SOLDIER_IDLE_FRAME_URLS;
      const frameIndex = frameTick % urls.length;
      if (image.dataset.frameIndex !== String(frameIndex) || image.dataset.walk !== image.dataset.appliedWalk) {
        stepFrameImage(image, urls, frameIndex, viewportWidth, viewportHeight);
        image.dataset.appliedWalk = image.dataset.walk ?? "0";
      }
    });
    // 무법자는 항상 걷기 사이클 (idle 프레임 없음).
    territoryOutlawImages.forEach((image) => {
      if (!image.isConnected) {
        territoryOutlawImages.delete(image);
        return;
      }
      const frameIndex = frameTick % OUTLAW_FRAME_URLS.length;
      if (image.dataset.frameIndex !== String(frameIndex)) {
        stepFrameImage(image, OUTLAW_FRAME_URLS, frameIndex, viewportWidth, viewportHeight);
      }
    });
    if (
      territorySoldierImages.size === 0 &&
      territoryOutlawImages.size === 0 &&
      territorySoldierAnimationTimer !== null
    ) {
      window.clearInterval(territorySoldierAnimationTimer);
      territorySoldierAnimationTimer = null;
    }
  }, 120);
};

const appendTerritorySoldierAnimation = (element: HTMLElement): void => {
  const image = document.createElement("img");
  image.src = SOLDIER_IDLE_FRAME_URLS[0];
  image.alt = "";
  image.className = "territory-soldier-idle";
  element.appendChild(image);
  registerTerritorySoldierAnimation(image);
};

const territorySoldierAnimationMarkup = (): string =>
  `<img src="${SOLDIER_IDLE_FRAME_URLS[0]}" alt="" class="territory-soldier-idle" data-frame-index="0" />`;

const territoryOutlawAnimationMarkup = (): string =>
  `<img src="${OUTLAW_FRAME_URLS[0]}" alt="" class="territory-outlaw" data-frame-index="0" />`;

const neutralDamageAnimationMarkup = (): string =>
  `<div class="neutral-castle-damage-animation">${NEUTRAL_DAMAGE_FRAME_URLS.map(
    (src, index) => `<img src="${src}" alt="" class="neutral-castle-damage-frame neutral-castle-damage-frame-${index + 1}" />`,
  ).join("")}</div>`;

const appendNeutralDamageAnimation = (element: HTMLElement, expiresAt: number): void => {
  const wrapper = document.createElement("div");
  wrapper.className = "neutral-castle-damage-animation";
  NEUTRAL_DAMAGE_FRAME_URLS.forEach((src, index) => {
    const image = document.createElement("img");
    image.src = src;
    image.alt = "";
    image.className = `neutral-castle-damage-frame neutral-castle-damage-frame-${index + 1}`;
    wrapper.appendChild(image);
  });
  element.appendChild(wrapper);
  window.setTimeout(() => {
    if (!wrapper.isConnected) return;
    const baseImage = document.createElement("img");
    baseImage.src = "/markers/neutral-castle-v2-short.png";
    baseImage.alt = "";
    baseImage.className = "neutral-castle-marker-image";
    wrapper.replaceWith(baseImage);
  }, Math.max(0, expiresAt - Date.now()));
};

const readCelebratedTimes = (): Map<string, number> => {
  try {
    const raw = window.sessionStorage.getItem(MARKER_CELEBRATED_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Map(
        parsed
          .filter((value): value is string => typeof value === "string")
          .map((key) => [key, 0])
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      return new Map();
    }
    const times = new Map<string, number>();
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        times.set(key, value);
      }
    });
    return times;
  } catch {
    return new Map();
  }
};

const writeCelebratedTimes = (times: Map<string, number>): void => {
  try {
    const record: Record<string, number> = {};
    times.forEach((value, key) => {
      record[key] = value;
    });
    window.sessionStorage.setItem(MARKER_CELEBRATED_STORAGE_KEY, JSON.stringify(record));
  } catch {
    return;
  }
};

type PlayerMarkerVisual = {
  element: HTMLDivElement;
  dispose: () => void;
  iconSize: [number, number];
  iconAnchor: [number, number];
  applyFacingDirection: (facingLeft: boolean) => void;
};

type ClusterUnit = {
  id: string;
  lat: number;
  lon: number;
  count: number;
};

type EdgeIndicator = {
  id: string;
  left: number;
  top: number;
  angle: number;
  count: number;
  nearestDistanceMeters: number | null;
};

type RotatableLeafletMap = LeafletMap & {
  setBearing: (theta: number) => void;
  getBearing: () => number;
};

type RotatableMapOptions = MapOptions & {
  rotate?: boolean;
  bearing?: number;
};

const EDGE_INDICATOR_MERGE_DISTANCE_RATIO = 0.1;

const mergeOverlappingIndicators = (
  indicators: EdgeIndicator[],
  browserWidthPx: number
): EdgeIndicator[] => {
  if (indicators.length === 0) {
    return [];
  }

  const mergeDistancePx = Math.max(0, browserWidthPx * EDGE_INDICATOR_MERGE_DISTANCE_RATIO);

  const result: EdgeIndicator[] = [];
  const used = new Set<string>();

  for (let i = 0; i < indicators.length; i++) {
    if (used.has(indicators[i].id)) {
      continue;
    }

    const merged: EdgeIndicator = { ...indicators[i] };
    let mergedCount = merged.count;
    let mergedLeft = merged.left * merged.count;
    let mergedTop = merged.top * merged.count;
    let mergedAngle = merged.angle * merged.count;
    let mergedNearestDistance = merged.nearestDistanceMeters;
    let totalWeight = merged.count;

    for (let j = i + 1; j < indicators.length; j++) {
      if (used.has(indicators[j].id)) {
        continue;
      }

      const other = indicators[j];
      const dx = merged.left - other.left;
      const dy = merged.top - other.top;
      const distance = Math.hypot(dx, dy);

      if (distance <= mergeDistancePx) {
        mergedLeft += other.left * other.count;
        mergedTop += other.top * other.count;
        mergedAngle += other.angle * other.count;
        totalWeight += other.count;
        mergedCount += other.count;
        if (other.nearestDistanceMeters !== null) {
          mergedNearestDistance =
            mergedNearestDistance === null
              ? other.nearestDistanceMeters
              : Math.min(mergedNearestDistance, other.nearestDistanceMeters);
        }
        used.add(other.id);
      }
    }

    result.push({
      id: merged.id,
      left: mergedLeft / totalWeight,
      top: mergedTop / totalWeight,
      angle: mergedAngle / totalWeight,
      count: mergedCount,
      nearestDistanceMeters: mergedNearestDistance,
    });
    used.add(merged.id);
  }

  return result;
};

const MIN_ZOOM_LEVEL = 3;
const MAX_ZOOM_LEVEL = 19;
const DEFAULT_ZOOM_LEVEL = 19;
const SATELLITE_ZOOM_RANGE = { min: 3, max: 19 } as const;
const GLOBE_ZOOM_RANGE = { min: 1, max: 20 } as const;
const CESIUM_ZOOM_RANGE = { min: 2, max: 22 } as const;
const ZOOM_RANGE_BY_STYLE: Record<MapStyle, { min: number; max: number }> = {
  satellite: SATELLITE_ZOOM_RANGE,
  globe: GLOBE_ZOOM_RANGE,
  cesium: CESIUM_ZOOM_RANGE,
};

const getSavedZoomForStyle = (cacheKey: string, style: MapStyle): number | null => {
  try {
    if (typeof window === "undefined" || typeof sessionStorage === "undefined") return null;
    const perStyleKey = `map-zoom:${cacheKey}:${style}`;
    const raw = sessionStorage.getItem(perStyleKey) ?? sessionStorage.getItem(`map-zoom:${cacheKey}`);
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    const range = ZOOM_RANGE_BY_STYLE[style];
    return Math.min(range.max, Math.max(range.min, parsed));
  } catch {
    return null;
  }
};
const DEBUG_PSEUDO_MARKER_ENABLED = true;

/** 소유자별 영토 색 (userId 해시 → hue). */
const territoryOwnerColor = (ownerId: string): string => {
  let h = 0;
  for (let i = 0; i < ownerId.length; i += 1) {
    h = (h * 31 + ownerId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 70%, 45%)`;
};
const DEBUG_PSEUDO_MARKER_EVENT_KEY = "ac8f767a-efa1-445e-a3c2-7c12a53c18da";
const DEBUG_PSEUDO_MARKER2_EVENT_KEY = "BUSANCITIZEN_BUTTERFLY";
const DEBUG_PSEUDO_MARKER3_EVENT_KEY = "BUSANCITIZEN_STACK";
const DEBUG_PSEUDO_MARKER_OFFSET_METERS = 30;
const CLUSTER_DISTANCE_PX = 80;

const clusterByPixelDistance = (
  points: MapPoint[],
  getPixel: (lat: number, lon: number) => { x: number; y: number } | null
): { center: MapPoint; points: MapPoint[] }[] => {
  // 전수 비교 O(n²) 대신 공간 그리드 O(n) (위성 이펙트와 동일 방식 — 결과 동일).
  const clusters: { center: MapPoint; points: MapPoint[] }[] = [];
  const processed = new Set<number>();
  const pixelCoords = new Map<number, { x: number; y: number }>();
  const cellOf = (x: number, y: number): string =>
    `${Math.floor(x / CLUSTER_DISTANCE_PX)},${Math.floor(y / CLUSTER_DISTANCE_PX)}`;
  const grid = new Map<string, number[]>();
  const byId = new Map<number, MapPoint>();
  for (const point of points) {
    byId.set(point.id, point);
    const px = getPixel(point.lat, point.lon);
    if (!px) {
      continue;
    }
    pixelCoords.set(point.id, { x: px.x, y: px.y });
    const key = cellOf(px.x, px.y);
    const bucket = grid.get(key);
    if (bucket) {
      bucket.push(point.id);
    } else {
      grid.set(key, [point.id]);
    }
  }
  for (const point of points) {
    if (processed.has(point.id)) continue;
    const clusterPoints: MapPoint[] = [point];
    processed.add(point.id);
    const pointCoords = pixelCoords.get(point.id);
    if (!pointCoords) {
      clusters.push({ center: point, points: clusterPoints });
      continue;
    }
    const cellX = Math.floor(pointCoords.x / CLUSTER_DISTANCE_PX);
    const cellY = Math.floor(pointCoords.y / CLUSTER_DISTANCE_PX);
    for (let gx = cellX - 1; gx <= cellX + 1; gx += 1) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy += 1) {
        const bucket = grid.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (const otherId of bucket) {
          if (processed.has(otherId)) continue;
          const other = byId.get(otherId);
          if (!other) continue;
          const otherCoords = pixelCoords.get(otherId);
          if (!otherCoords) continue;
          const dx = pointCoords.x - otherCoords.x;
          const dy = pointCoords.y - otherCoords.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < CLUSTER_DISTANCE_PX) {
            clusterPoints.push(other);
            processed.add(otherId);
          }
        }
      }
    }
    clusters.push({ center: point, points: clusterPoints });
  }
  return clusters;
};
const POI_LABEL_OFFSET_Y = -28;
const NEARBY_PLAYERS_POLL_INTERVAL_MS = 5_000;
const NEARBY_PLAYERS_SINCE_SEC = 35;
const NEARBY_PLAYERS_LIMIT = 80;
const NEARBY_PLAYERS_BOUNDS_PAD_RATIO = 0.15;
const PLAYER_LOCATION_MIN_MOVE_METERS = 2;
const MAP_ROTATION_STATE_COMMIT_INTERVAL_MS = 50;
const MAP_ROTATION_MIN_DEG_TO_COMMIT = 0.5;
const SPRITE_DIRECTION_LON_THRESHOLD = 0.000001;
const EDGE_INDICATOR_BOTTOM_SAFE_GAP = 8;
const EDGE_INDICATOR_FALLBACK_TOOLBAR_HEIGHT = 104;
const EMPTY_POINTS: MapPoint[] = [];
const EMPTY_VISITED_SCORES: Record<string, number> = {};
const LOCATION_CACHE_KEY_PREFIX = "armission-map-location:";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseCachedLocation = (serializedLocation: string | null): GeoResult | null => {
  if (serializedLocation === null) {
    return null;
  }

  let parsedLocation: unknown;
  try {
    parsedLocation = JSON.parse(serializedLocation);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }

  if (!isRecord(parsedLocation)) {
    return null;
  }

  const { lat, lon } = parsedLocation;
  const hasTimestamp = Object.prototype.hasOwnProperty.call(parsedLocation, "timestamp");
  const timestamp = hasTimestamp ? parsedLocation.timestamp : undefined;

  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lon !== "number" ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180 ||
    (hasTimestamp && (typeof timestamp !== "number" || !Number.isFinite(timestamp)))
  ) {
    return null;
  }

  const accuracy = parsedLocation.accuracy;
  return {
    lat,
    lon,
    ...(typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}),
    ...(typeof timestamp === "number" ? { timestamp } : {}),
  };
};

const metersToLongitudeDelta = (latitude: number, meters: number): number => {
  const latitudeRadian = (latitude * Math.PI) / 180;
  const meterPerDegree = 111320 * Math.max(Math.cos(latitudeRadian), 0.00001);
  return meters / meterPerDegree;
};

const metersToLatitudeDelta = (meters: number): number => {
  return meters / 110574;
};

const normalizeHeadingDeg = (headingDeg: number): number => {
  let normalized = headingDeg % 360;
  if (normalized > 180) {
    normalized -= 360;
  }
  if (normalized <= -180) {
    normalized += 360;
  }
  return normalized;
};

type GpsAccuracyTier = "좋음" | "약함" | "나쁨";

const gpsAccuracyTier = (accuracyMeters: number): GpsAccuracyTier => {
  if (accuracyMeters <= 10) {
    return "좋음";
  }
  if (accuracyMeters <= 15) {
    return "약함";
  }
  return "나쁨";
};

const GPS_ACCURACY_TIER_TEXT_CLASS: Record<GpsAccuracyTier, string> = {
  좋음: "text-emerald-200",
  약함: "text-amber-200",
  나쁨: "text-rose-300",
};

const isRenderablePoiEventType = (eventType?: string): boolean => {
  if (typeof eventType !== "string") {
    return false;
  }

  const normalized = eventType.trim().toLowerCase();
  return normalized === "urltype" || normalized === "quiztype" || normalized === "neutraltype";
};

const getEventTypeLabel = (eventType?: string): string => {
  if (typeof eventType !== "string") {
    return "-";
  }
  const normalized = eventType.trim().toLowerCase();
  if (normalized === "urltype") {
    return "이벤트";
  }
  if (normalized === "quiztype") {
    return "퀴즈";
  }
  if (normalized === "neutraltype") {
    return "중립성";
  }
  return eventType;
};

/** 코드 생성 중립성 마커 prefix (DB Row 없이 사용). */
const NEUTRAL_EVENT_PREFIX = "neutral-";

const isNeutralEventKey = (eventKey?: string | null): boolean =>
  (eventKey ?? "").trim().startsWith(NEUTRAL_EVENT_PREFIX);

const buildNeutralPanel = (label?: string, eventKey?: string, lat?: number, lon?: number): MarkerPanel => ({
  title: "중립성",
  lines: [
    `이름: ${label?.trim() || "중립성"}`,
    "유형: 중립성",
    "상태: 점령 불가·공격 가능",
  ],
  eventKey: eventKey?.trim() || undefined,
  lat: Number.isFinite(lat) ? lat : undefined,
  lon: Number.isFinite(lon) ? lon : undefined,
});

/** 무법자 인식 범위 반경 (m). */
const WILD_ATTACK_RANGE_M = 15;

/** 중립성 인식 범위 반경 (m). */
const NEUTRAL_RANGE_RADIUS_M = 15;

/** 중립성 퀴즈 풀이 허용 반경 (m). 본체 또는 자기 부대가 이 안에 있어야 한다. */
const NEUTRAL_QUIZ_RANGE_M = 15;

const metersPerPixel = (lat: number, zoom: number): number =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

/** 영토전 도보 가능 영역 오버레이 (도로 버퍼 래스터, 겹쳐도 단일 알파). */
const WALKABLE_GRID_OPACITY = 0.5;
const WALKABLE_BORDER_OPACITY = 0.9;
const WALKABLE_GLOBE_SOURCE_ID = "walkable-roads";

/** 축성 종류별 고스트/핀 이미지. */
const CASTLE_IMAGE_BY_KIND: Record<"lord" | "noble", string> = {
  lord: "/markers/lord-castle-v2.png",
  noble: "/markers/neutral-castle-v2.png",
};

const appendDamagedLordCastleAnimation = (element: HTMLElement): void => {
  const image = document.createElement("img");
  image.src = "/markers/lord-castle-damaged-1.png";
  image.alt = "";
  image.style.width = "54px";
  image.style.height = "54px";
  image.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.55))";
  element.appendChild(image);
};

type CastlePlacement = CastleBuildDraft & {
  lat: number | null;
  lon: number | null;
  confirming: boolean;
};

/** 마우스 커서를 따라다니는 축성 고스트 (자체 리렌더로 격리). */
function CastlePlacementGhost({ src }: { src: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      setPos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
    };
  }, []);
  if (!pos) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-[1150]"
      style={{ transform: `translate(${pos.x - 27}px, ${pos.y - 27}px)` }}
    >
      <img
        src={src}
        alt=""
        style={{ width: 54, height: 54, opacity: 0.85, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.55))" }}
      />
    </div>
  );
}

/** 행정구역 GeoJSON에서 좌표를 포함하는 피처의 정규 코드를 찾는다. */
const findAdminCodeAt = (
  collection: GeoJSON.FeatureCollection | null,
  lon: number,
  lat: number
): string | null => {
  if (!collection || !Array.isArray(collection.features)) {
    return null;
  }
  const inRing = (ring: number[][], x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
  for (const feature of collection.features) {
    const geometry = feature.geometry as
      | { type?: unknown; coordinates?: unknown }
      | null;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      continue;
    }
    const polys = (
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates
    ) as number[][][][];
    let inside = false;
    for (const poly of polys) {
      if (Array.isArray(poly) && poly.length > 0 && inRing(poly[0] as number[][], lon, lat)) {
        inside = !inside;
      }
    }
    if (!inside) {
      continue;
    }
    const props = feature.properties as Record<string, unknown> | null;
    const raw = props?.["_normCode"] ?? props?.["code"];
    if (typeof raw === "string" && raw) {
      return raw;
    }
  }
  return null;
};

/** HTML 마커용 반투명 인식 범위 링 (alignCenter면 요소 중앙, 아니면 하단 중앙). */
const buildNeutralRangeRing = (diameterPx: number, alignCenter = false): HTMLDivElement => {
  const ring = document.createElement("div");
  const size = Math.max(0, diameterPx);
  ring.style.position = "absolute";
  ring.style.left = "50%";
  ring.style.top = alignCenter ? "50%" : "100%";
  ring.style.transform = "translate(-50%, -50%)";
  ring.style.width = `${size}px`;
  ring.style.height = `${size}px`;
  ring.style.borderRadius = "50%";
  ring.style.border = "2px solid rgba(251,191,36,0.9)";
  ring.style.background = "rgba(251,191,36,0.12)";
  ring.style.pointerEvents = "none";
  return ring;
};

/** 플레이어 중심 중립성 로딩 반경/갱신 간격 (m). */
const NEUTRAL_OFFICE_RADIUS_M = 20000;
const NEUTRAL_OFFICE_REFRESH_M = 500;

type NeutralOfficeRow = {
  key: string;
  name: string;
  lat: number;
  lon: number;
  dong: string;
};

let neutralOfficeCache: Promise<NeutralOfficeRow[]> | null = null;

const loadNeutralOffices = (): Promise<NeutralOfficeRow[]> => {
  if (!neutralOfficeCache) {
    neutralOfficeCache = fetch("/boundaries/kor_offices.json", { credentials: "omit" })
      .then((res) => (res.ok ? res.json() : []))
      .then((json: unknown) => {
        if (!Array.isArray(json)) {
          return [];
        }
        return (json as unknown[]).filter(
          (row): row is NeutralOfficeRow =>
            typeof row === "object" &&
            row !== null &&
            typeof (row as NeutralOfficeRow).key === "string" &&
            typeof (row as NeutralOfficeRow).name === "string" &&
            Number.isFinite((row as NeutralOfficeRow).lat) &&
            Number.isFinite((row as NeutralOfficeRow).lon)
        );
      })
      .catch(() => []);
  }
  return neutralOfficeCache;
};

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

const formatEdgeIndicatorDistance = (distanceMeters: number): string => {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return "-";
  }

  if (distanceMeters < 100) {
    return `${distanceMeters.toFixed(1)}m`;
  }

  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)}m`;
  }

  const distanceKm = distanceMeters / 1000;
  if (distanceKm < 10) {
    return `${distanceKm.toFixed(2)}km`;
  }

  if (distanceKm < 100) {
    return `${distanceKm.toFixed(1)}km`;
  }

  const roundedKm = Math.round(distanceKm);
  if (roundedKm > 999) {
    return "999km+";
  }

  return `${roundedKm}km`;
};

const buildEventPageTarget = (eventKey?: string): string | undefined => {
  const trimmedEventKey = eventKey?.trim();
  if (!trimmedEventKey) {
    return undefined;
  }

  const params = new URLSearchParams({
    eventkey: trimmedEventKey,
  });

  return `/event?${params.toString()}`;
};

const projectToEdge = (
  width: number,
  height: number,
  pointX: number,
  pointY: number,
  padding: number,
  bounds?: {
    minX?: number;
    maxX?: number;
    minY?: number;
    maxY?: number;
  }
): { left: number; top: number; angle: number } | null => {
  const centerX = width / 2;
  const centerY = height / 2;
  const deltaX = pointX - centerX;
  const deltaY = pointY - centerY;

  if (deltaX === 0 && deltaY === 0) {
    return null;
  }

  const minX = bounds?.minX ?? padding;
  const maxX = bounds?.maxX ?? width - padding;
  const minY = bounds?.minY ?? padding;
  const maxY = bounds?.maxY ?? height - padding;

  const scaleCandidates: number[] = [];
  if (deltaX > 0) {
    scaleCandidates.push((maxX - centerX) / deltaX);
  } else if (deltaX < 0) {
    scaleCandidates.push((minX - centerX) / deltaX);
  }

  if (deltaY > 0) {
    scaleCandidates.push((maxY - centerY) / deltaY);
  } else if (deltaY < 0) {
    scaleCandidates.push((minY - centerY) / deltaY);
  }

  const scale = scaleCandidates
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0)
    .sort((a, b) => a - b)[0];

  if (scale === undefined) {
    return null;
  }

  const left = Math.min(maxX, Math.max(minX, centerX + deltaX * scale));
  const top = Math.min(maxY, Math.max(minY, centerY + deltaY * scale));
  const angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI + 90;

  return { left, top, angle };
};

const getScoreAnimatedStorageKey = (sig: string): string => `score-animated:${sig}`;

const hasAnimatedScoreSig = (sig: string): boolean => {
  try {
    return window.sessionStorage.getItem(getScoreAnimatedStorageKey(sig)) !== null;
  } catch {
    return false;
  }
};

const markScoreAnimatedSig = (sig: string): void => {
  try {
    window.sessionStorage.setItem(getScoreAnimatedStorageKey(sig), "1");
  } catch {
  }
};


/** 영토전 시작 위치 스토어 (시-도/군-구/동-읍 선택). 타입은 피커 참고. */

const getTerritoryStartStorageKey = (cacheKey: string): string =>
  `territory-start:${cacheKey}`;

export const readTerritoryStart = (cacheKey: string): TerritoryStart | null => {
  try {
    const raw = window.localStorage.getItem(getTerritoryStartStorageKey(cacheKey));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      lat?: unknown;
      lon?: unknown;
      sido?: unknown;
      sigungu?: unknown;
      dong?: unknown;
    };
    if (
      typeof parsed.lat !== "number" ||
      typeof parsed.lon !== "number" ||
      typeof parsed.sido !== "string" ||
      typeof parsed.sigungu !== "string" ||
      typeof parsed.dong !== "string" ||
      !Number.isFinite(parsed.lat) ||
      !Number.isFinite(parsed.lon) ||
      Math.abs(parsed.lat) > 90 ||
      Math.abs(parsed.lon) > 180
    ) {
      return null;
    }
    return {
      lat: parsed.lat,
      lon: parsed.lon,
      sido: parsed.sido,
      sigungu: parsed.sigungu,
      dong: parsed.dong,
    };
  } catch {
    return null;
  }
};

export const writeTerritoryStart = (cacheKey: string, start: TerritoryStart): void => {
  try {
    window.localStorage.setItem(getTerritoryStartStorageKey(cacheKey), JSON.stringify(start));
  } catch {
  }
};

type AnimatedScoreCounterProps = {
  value: number;
  startFrom: number;
  shouldAnimate: boolean;
  onAnimationComplete: () => void;
  duration?: number;
};

function AnimatedScoreCounter({
  value,
  startFrom,
  shouldAnimate,
  onAnimationComplete,
  duration = 3000,
}: AnimatedScoreCounterProps) {
  const [displayValue, setDisplayValue] = useState(shouldAnimate ? startFrom : value);
  const animatingRef = useRef(false);
  const prevShouldAnimateRef = useRef(false);
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!shouldAnimate) {
      setDisplayValue(value);
      prevShouldAnimateRef.current = false;
      return;
    }

    if (prevShouldAnimateRef.current) {
      return;
    }

    const startValue = startFrom;
    const endValue = value;
    const delta = Math.max(0, endValue - startValue);
    const effectiveDuration = delta <= 0 ? 0 : Math.min(Math.max(900, delta * 450), duration);

    const timeoutId = setTimeout(() => {
      if (animatingRef.current) {
        return;
      }

      prevShouldAnimateRef.current = true;
      animatingRef.current = true;
      console.log("[ScoreAnim] counter start", { startFrom, value, duration, delta, effectiveDuration });

      if (effectiveDuration <= 0) {
        setDisplayValue(endValue);
        animatingRef.current = false;
        onAnimationComplete();
        return;
      }

      const startTime = Date.now();

      const animate = () => {
        const now = Date.now();
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / effectiveDuration, 1);

        const current = startValue + Math.floor(delta * progress);

        setDisplayValue(current);

        if (progress < 1) {
          rafIdRef.current = requestAnimationFrame(animate);
        } else {
          setDisplayValue(endValue);
          animatingRef.current = false;
          onAnimationComplete();
        }
      };

      rafIdRef.current = requestAnimationFrame(animate);
    }, 100);

    const fallbackTimeoutId = setTimeout(() => {
      if (!animatingRef.current) {
        return;
      }
      console.log("[ScoreAnim] counter fallback finish", { startFrom, value });
      cancelAnimationFrame(rafIdRef.current);
      setDisplayValue(value);
      animatingRef.current = false;
      onAnimationComplete();
    }, 100 + effectiveDuration + 4000);

    return () => {
      clearTimeout(timeoutId);
      clearTimeout(fallbackTimeoutId);
      cancelAnimationFrame(rafIdRef.current);
      prevShouldAnimateRef.current = false;
    };
  }, [value, startFrom, shouldAnimate, duration, onAnimationComplete]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const digits = Math.max(0, displayValue).toString().split("");

  return (
    <div className="flex items-center gap-0.5 h-5">
      {digits.map((digit, idx) => (
        <div
          key={idx}
          className="relative h-5 w-3 overflow-hidden"
        >
          <div
            className="flex flex-col"
            style={{
              transform: `translateY(-${parseInt(digit) * 20}px)`,
              transition: "transform 150ms ease-out",
            }}
          >
            {[0,1,2,3,4,5,6,7,8,9].map((n) => (
              <span
                key={n}
                className="h-5 flex items-center justify-center text-sm font-extrabold leading-none tabular-nums text-amber-100"
              >
                {n}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CurrentLocationMap({
  locationCacheKey,
  className,
  points = EMPTY_POINTS,
  playerNickname,
  playerScore: initialPlayerScore,
  rankingItems = [],
  rankingNickname,
  initialShowRanking = false,
  debugEventTypes,
  initialSettings = DEFAULT_MAP_USER_SETTINGS,
  visitedEventKeys = [],
  visitedScores = EMPTY_VISITED_SCORES,
  showEventRevisitedDialog = false,
  attackDeniedReason = null,
  territoryEnabled = false,
  missionKey,
}: CurrentLocationMapProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const locationStorageKey = `${LOCATION_CACHE_KEY_PREFIX}${locationCacheKey}`;
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<LocationPermissionState>(null);
  const [location, setLocation] = useState<GeoResult | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [markerPanel, setMarkerPanel] = useState<MarkerPanel | null>(null);
  const [showPanelEventKey, setShowPanelEventKey] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(() => {
    if (initialSettings.mapStyle === "globe") return GLOBE_DEFAULT_ZOOM;
    if (initialSettings.mapStyle === "cesium") return 15;
    return DEFAULT_ZOOM_LEVEL;
  });
  const pendingScoreAnimation: { addedScore: number } | null = (() => {
    if (searchParams.get("scoreUpdated") !== "true") {
      return null;
    }
    const parsed = parseInt(searchParams.get("addedScore") ?? "", 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const sig = `true:${searchParams.get("addedScore") ?? ""}:${searchParams.get("scoreNonce") ?? ""}`;
    if (hasAnimatedScoreSig(sig)) {
      return null;
    }
    return { addedScore: parsed };
  })();
  const [playerScore, setPlayerScore] = useState<number>(initialPlayerScore ?? 0);
  const [animateScore, setAnimateScore] = useState(pendingScoreAnimation !== null);
  const [previousScore, setPreviousScore] = useState<number>(() =>
    pendingScoreAnimation
      ? Math.max(0, (initialPlayerScore ?? 0) - pendingScoreAnimation.addedScore)
      : 0
  );
  const [isHeadingUpMode, setIsHeadingUpMode] = useState(false);
  const [mapRotationDeg, setMapRotationDeg] = useState(0);
  const [compassIconDataUrl, setCompassIconDataUrl] = useState<string | null>(null);
  const [edgeIndicatorIconDataUrl, setEdgeIndicatorIconDataUrl] = useState<string | null>(null);
  // 영토전 시작 위치 (GPS 미사용 모드). 없으면 선택 모달이 뜬다.
  const [territoryStart, setTerritoryStart] = useState<TerritoryStart | null>(null);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  useEffect(() => {
    try {
      setTerritoryStart(readTerritoryStart(locationCacheKey));
    } catch {
      setTerritoryStart(null);
    }
    setStartPickerOpen(false);
  }, [locationCacheKey]);
  // 영주(플레이어) 이동 주문 (부대와 동일한 이동 지시 방식, 클라이언트 권위).
  // 주문 종료(도착/중지) 후에는 그 자리 정착 지점에서 머문다. 정착지와 진행 중
  // 주문은 세션 스토리지에 저장해 새로고침 후에도 이어받는다.
  const LORD_BASE_STORAGE_KEY = "lord-move-base";
  const LORD_ORDER_STORAGE_KEY = "lord-move-order";
  const readStoredLordBase = (): { lat: number; lon: number } | null => {
    try {
      const raw = window.sessionStorage.getItem(LORD_BASE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { lat?: unknown; lon?: unknown };
      if (typeof parsed.lat !== "number" || typeof parsed.lon !== "number") return null;
      if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lon)) return null;
      return { lat: parsed.lat, lon: parsed.lon };
    } catch {
      return null;
    }
  };
  const readStoredLordOrder = (): UnitMoveTarget | null => {
    try {
      const raw = window.sessionStorage.getItem(LORD_ORDER_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<UnitMoveTarget>;
      if (
        typeof parsed.fromLat !== "number" || typeof parsed.fromLon !== "number" ||
        typeof parsed.lat !== "number" || typeof parsed.lon !== "number" ||
        typeof parsed.startedAt !== "number" || typeof parsed.endsAt !== "number"
      ) {
        return null;
      }
      if (Date.now() >= parsed.endsAt) return null;
      return {
        fromLat: parsed.fromLat, fromLon: parsed.fromLon,
        lat: parsed.lat, lon: parsed.lon,
        startedAt: parsed.startedAt, endsAt: parsed.endsAt,
        via: null,
        path: Array.isArray(parsed.path) ? parsed.path : null,
      };
    } catch {
      return null;
    }
  };
  const [playerMoveTarget, setPlayerMoveTarget] = useState<UnitMoveTarget | null>(null);
  const [playerManualBase, setPlayerManualBase] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    try {
      const savedOrder = readStoredLordOrder();
      if (savedOrder) {
        setPlayerMoveTarget(savedOrder);
      } else {
        const savedBase = readStoredLordBase();
        if (savedBase) {
          setPlayerManualBase(savedBase);
        }
      }
    } catch {
      // 무시
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [playerMoveTick, setPlayerMoveTick] = useState(0);
  useEffect(() => {
    if (!playerMoveTarget) {
      return;
    }
    const settle = (): void => {
      try {
        window.sessionStorage.setItem(LORD_BASE_STORAGE_KEY, JSON.stringify({ lat: playerMoveTarget.lat, lon: playerMoveTarget.lon }));
        window.sessionStorage.removeItem(LORD_ORDER_STORAGE_KEY);
      } catch {
        // 무시
      }
      setPlayerManualBase({ lat: playerMoveTarget.lat, lon: playerMoveTarget.lon });
      setPlayerMoveTarget(null);
    };
    if (Date.now() >= playerMoveTarget.endsAt) {
      settle();
      return;
    }
    const id = window.setInterval(() => {
      if (Date.now() >= playerMoveTarget.endsAt) {
        window.clearInterval(id);
        settle();
        return;
      }
      setPlayerMoveTick((t) => t + 1);
    }, 500);
    return () => window.clearInterval(id);
  }, [playerMoveTarget]);
  // 플레이어 위치 단일 진실 공급원.
  // - 영주 이동 주문이 있으면 주문 경로를 따라 이동 (부대와 동일한 보간).
  // - 영토전이면 저장된 시작 위치 (GPS 미사용).
  // - 그 외 GPS. 직접 GPS(location)를 게임 로직에 쓰지 않는다.
  const playerLocation = useMemo(() => {
    if (playerMoveTarget) {
      const pos = positionAtMoveTarget(playerMoveTarget, Date.now());
      if (Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
        return { lat: pos.lat, lon: pos.lon };
      }
    }
    if (playerManualBase && Number.isFinite(playerManualBase.lat) && Number.isFinite(playerManualBase.lon)) {
      return { lat: playerManualBase.lat, lon: playerManualBase.lon };
    }
    if (territoryEnabled) {
      if (
        territoryStart &&
        Number.isFinite(territoryStart.lat) &&
        Number.isFinite(territoryStart.lon)
      ) {
        return { lat: territoryStart.lat, lon: territoryStart.lon };
      }
      return null;
    }
    if (location && Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
      return { lat: location.lat, lon: location.lon };
    }
    return null;
  }, [playerMoveTarget, playerManualBase, territoryEnabled, territoryStart, location, playerMoveTick]);
  const [proximityMarkerInfo, setProximityMarkerInfo] = useState<MarkerPanel | null>(null);
  // ?vdebug=1 뷰포트 진단 오버레이 (아이폰 UI 잘림 원인 특정용).
  const [viewportDebugLines, setViewportDebugLines] = useState<string[]>([]);
  useEffect(() => {
    if (!isViewportDebugEnabled()) {
      return;
    }
    const measure = (): void => {
      try {
        const vv = window.visualViewport;
        const de = document.documentElement;
        const lines = [
          `inner ${window.innerWidth}x${window.innerHeight}`,
          `visual ${Math.round(vv?.width ?? -1)}x${Math.round(vv?.height ?? -1)} scale=${(vv?.scale ?? -1).toFixed(2)} left=${Math.round(vv?.offsetLeft ?? 0)} top=${Math.round(vv?.offsetTop ?? 0)}`,
          `de client ${de.clientWidth} scroll ${de.scrollWidth}x${de.scrollHeight}`,
          `body scroll ${document.body.scrollWidth}`,
        ];
        const over: Array<{ tag: string; cls: string; right: number; bottom: number }> = [];
        const all = document.querySelectorAll("*");
        for (let i = 0; i < all.length; i += 1) {
          const el = all[i] as HTMLElement;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) {
            continue;
          }
          if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
            over.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className && typeof el.className === "string" ? el.className : "").split(" ").slice(0, 3).join("."),
              right: Math.round(r.right),
              bottom: Math.round(r.bottom),
            });
            if (over.length >= 200) {
              break;
            }
          }
        }
        over.sort((a, b) => Math.max(b.right - window.innerWidth, b.bottom - window.innerHeight) - Math.max(a.right - window.innerWidth, a.bottom - window.innerHeight));
        for (const o of over.slice(0, 6)) {
          lines.push(`OVER ${o.tag}.${o.cls} r=${o.right} b=${o.bottom}`);
        }
        setViewportDebugLines(lines);
      } catch {
        // 진단 실패 무시
      }
    };
    measure();
    const t = window.setInterval(measure, 2000);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);
  const [clusterUnits, setClusterUnits] = useState<ClusterUnit[]>([]);
  const [territoryCastleKey, setTerritoryCastleKey] = useState<string | null>(null);

  // 영토 색칠용 성 소유 현황 (동 → 소유자). 30초 폴링.
  interface TerritoryOwnedCastle {
    castleKey: string;
    kind: string;
    name: string;
    owner: string | null;
    ownerNickname: string;
    dong: string;
    mine: boolean;
  }
  const [territoryCastles, setTerritoryCastles] = useState<TerritoryOwnedCastle[]>([]);
  useEffect(() => {
    if (!territoryEnabled) {
      setTerritoryCastles([]);
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/castles/list", { credentials: "include" });
        const data = (await res.json()) as {
          ok?: unknown;
          castles?: unknown;
        };
        if (cancelled || data?.ok !== true || !Array.isArray(data.castles)) {
          return;
        }
        const next: TerritoryOwnedCastle[] = [];
        for (const row of data.castles as Record<string, unknown>[]) {
          if (
            typeof row.castleKey !== "string" ||
            typeof row.dong !== "string" ||
            (row.owner !== null && typeof row.owner !== "string")
          ) {
            continue;
          }
          next.push({
            castleKey: row.castleKey,
            kind: typeof row.kind === "string" ? row.kind : "",
            name: typeof row.name === "string" ? row.name : row.castleKey,
            owner: (row.owner as string | null) ?? null,
            ownerNickname: typeof row.ownerNickname === "string" ? row.ownerNickname : "",
            dong: row.dong,
            mine: row.mine === true,
          });
        }
        if (!cancelled) {
          setTerritoryCastles(next);
        }
      } catch {
        // 조회 실패 시 기존 색 유지
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [territoryEnabled]);

  // 동 → 소유자 (영주성 우선). 범례용 소유자 집계.
  const ownedDongMap = useMemo(() => {
    const map = new Map<string, { ownerId: string; nickname: string }>();
    for (const castle of territoryCastles) {
      if (!castle.owner || !castle.dong) {
        continue;
      }
      const prev = map.get(castle.dong);
      if (!prev || castle.kind === "lord") {
        map.set(castle.dong, { ownerId: castle.owner, nickname: castle.ownerNickname });
      }
    }
    return map;
  }, [territoryCastles]);
  // 내가 주인인 성 키 (성 메뉴 "나의 성" 목록용).
  const ownedCastleKeys = useMemo(
    () => territoryCastles.filter((c) => c.mine).map((c) => c.castleKey),
    [territoryCastles],
  );
  // 성 키 → 이름 (성 메뉴 표시용).
  const castleNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of territoryCastles) {
      if (c.name) {
        map[c.castleKey] = c.name;
      }
    }
    return map;
  }, [territoryCastles]);
  const territoryLegend = useMemo(() => {
    const byOwner = new Map<string, { nickname: string; dongs: Set<string> }>();
    ownedDongMap.forEach(({ ownerId, nickname }, dong) => {
      let entry = byOwner.get(ownerId);
      if (!entry) {
        entry = { nickname, dongs: new Set<string>() };
        byOwner.set(ownerId, entry);
      }
      entry.dongs.add(dong);
    });
    return [...byOwner.entries()]
      .map(([ownerId, entry]) => ({ ownerId, nickname: entry.nickname, count: entry.dongs.size }))
      .sort((a, b) => b.count - a.count);
  }, [ownedDongMap]);
  const [castlePlacement, setCastlePlacement] = useState<CastlePlacement | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);
  const [placementNotice, setPlacementNotice] = useState<{ id: number; message: string } | null>(null);
  const [placementReason, setPlacementReason] = useState<string | null>(null);
  const [myTerritory, setMyTerritory] = useState<{ klass: string; contribution: number } | null>(null);
  const [dongCastleCounts, setDongCastleCounts] = useState<{ lord: number; noble: number } | null>(null);
  const [walkableTick, setWalkableTick] = useState(0);
  const walkableBuiltSigRef = useRef<string | null>(null);
  const [walkableLoading, setWalkableLoading] = useState(false);
  const walkableLoadingRef = useRef(false);
  const walkableLoadStartRef = useRef(0);
  // 대기 중인 동 수 (스피너 표시용).
  const [walkablePending, setWalkablePending] = useState<{ done: number; total: number } | null>(null);
  const walkablePendingRef = useRef("");
  const setWalkablePendingOnce = (done: number, total: number): void => {
    const sig = `${done}/${total}`;
    if (walkablePendingRef.current !== sig) {
      walkablePendingRef.current = sig;
      setWalkablePending({ done, total });
    }
  };
  // 오버레이 동 집합은 GPS 좌표가 아니라 '동' 단위로만 바뀐다.
  // 같은 동 안에 있으면 GPS가 흔들려도 재계산하지 않고,
  // 플레이어가 다른 동으로 넘어가거나 사용자가 다른 동을 클릭했을 때만 갱신한다.
  const overlayIdsRef = useRef<string[] | null>(null);
  const overlayDongKeyRef = useRef("");
  const getStableOverlayIds = (base: { lat: number; lon: number }): string[] => {
    const baseDongIds = getWalkableDongIdsAt(base.lat, base.lon).slice().sort();
    const forceKey = `${moveTargetCenter?.lat ?? ""},${moveTargetCenter?.lon ?? ""}|${selectedAdminCode ?? ""}`;
    let overlayIds = overlayIdsRef.current;
    if (baseDongIds.length === 0 && overlayIds) {
      // 데이터 공백 지대에서는 이전 집합을 유지한다 (후보 찜찜 방지).
      return overlayIds;
    }
    const key = `${baseDongIds.join(",")}|${forceKey}`;
    if (!overlayIds || overlayDongKeyRef.current !== key) {
      overlayIds = getWalkableOverlayDongIds(base);
      overlayIdsRef.current = overlayIds;
      overlayDongKeyRef.current = key;
      wlog("overlay recalc", `dongs:${baseDongIds.join(",") || "(none)"}`, `total:${overlayIds.length}`);
    }
    return overlayIds;
  };
  const setWalkableLoadingOnce = (value: boolean): void => {
    if (walkableLoadingRef.current !== value) {
      walkableLoadingRef.current = value;
      setWalkableLoading(value);
    }
    if (!value) {
      walkableLoadStartRef.current = 0;
    }
  };
  /** 로딩이 25초를 넘기면 스피너를 강제로 내린다 (데이터 교착 시 UI 고착 방지). */
  const markWalkableWaiting = (): void => {
    const now = Date.now();
    if (walkableLoadStartRef.current === 0) {
      walkableLoadStartRef.current = now;
    }
    if (now - walkableLoadStartRef.current > 25000) {
      setWalkableLoadingOnce(false);
    } else {
      setWalkableLoadingOnce(true);
    }
  };
  const placementRef = useRef<CastlePlacement | null>(null);
  const adminGeoJsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const adminLevelRef = useRef<AdminLevel>("dong");
  const [adminGeoTick, setAdminGeoTick] = useState(0);
  useEffect(() => {
    placementRef.current = castlePlacement;
  }, [castlePlacement]);

  /** 위치 지정 모드에서 지도 클릭 좌표로 확정 단계 진입. */
  const placeCastleAt = useCallback((lat: number, lon: number): boolean => {
    const current = placementRef.current;
    if (!current || current.confirming) {
      return false;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return false;
    }
    setCastlePlacement({ ...current, lat, lon, confirming: true });
    return true;
  }, []);

  const cancelCastlePlacement = useCallback((): void => {
    setPlacementBusy(false);
    setPlacementReason(null);
    setCastlePlacement(null);
  }, []);

  // 내 계급/공헌 (축성 사전 검증용).
  useEffect(() => {
    if (!territoryEnabled) {
      return;
    }
    let cancelled = false;
    void fetch("/api/territory/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") {
          return;
        }
        const payload = data as { class?: unknown; contribution?: unknown };
        if (typeof payload.class === "string") {
          setMyTerritory({
            klass: payload.class,
            contribution:
              typeof payload.contribution === "number" ? payload.contribution : 0,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [territoryEnabled]);

  // 확정 좌표의 동 + 이번 시즌 성 현황.
  const placementDong = useMemo((): string | null => {
    if (!castlePlacement || castlePlacement.lat === null || castlePlacement.lon === null) {
      return null;
    }
    if (adminLevelRef.current === "dong" && adminGeoJsonRef.current) {
      const found = findAdminCodeAt(adminGeoJsonRef.current, castlePlacement.lon, castlePlacement.lat);
      if (found) {
        return found;
      }
    }
    return castlePlacement.dong || null;
  }, [castlePlacement, adminGeoTick]);

  useEffect(() => {
    setDongCastleCounts(null);
    if (!territoryEnabled || !placementDong || !castlePlacement?.confirming) {
      return;
    }
    let cancelled = false;
    void fetch(`/api/castles/dong-info?dongCode=${encodeURIComponent(placementDong)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") {
          return;
        }
        const payload = data as { lordCount?: unknown; nobleCount?: unknown };
        if (typeof payload.lordCount === "number" && typeof payload.nobleCount === "number") {
          setDongCastleCounts({ lord: payload.lordCount, noble: payload.nobleCount });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [territoryEnabled, placementDong, castlePlacement?.confirming]);

  const CLASS_ORDER_LOCAL: Record<string, number> = {
    slave: 0,
    commoner: 1,
    knight: 2,
    noble: 3,
    lord: 4,
  };

  // 계급/공헌 실패 요소 사전 판정. null이면 통과(서버 최종 검증).
  const placementBlockReason = useMemo((): string | null => {
    if (!castlePlacement || !myTerritory) {
      return null;
    }
    const order = CLASS_ORDER_LOCAL[myTerritory.klass] ?? -1;
    if (castlePlacement.kind === "noble") {
      if (myTerritory.klass !== "noble" && myTerritory.klass !== "lord") {
        return "귀족 이상만 귀족성을 축성할 수 있습니다.";
      }
      return null;
    }
    if (order < 1) {
      return "평민 이상만 영주성을 창시할 수 있습니다.";
    }
    if (
      dongCastleCounts &&
      dongCastleCounts.lord === 0 &&
      myTerritory.contribution < 1000
    ) {
      return `동 최초 영주성 창시에는 공헌 1000이 필요합니다. (현재 공헌 ${myTerritory.contribution})`;
    }
    return null;
  }, [castlePlacement, myTerritory, dongCastleCounts]);

  const confirmCastlePlacement = useCallback(async (): Promise<void> => {
    const current = placementRef.current;
    if (
      !current ||
      !current.confirming ||
      current.lat === null ||
      current.lon === null ||
      placementBusy
    ) {
      return;
    }
    // 실패 시 위치 재지정 모드로 복귀한다.
    const backToPlacement = (message: string): void => {
      setPlacementBusy(false);
      setPlacementNotice({ id: Date.now(), message });
      setCastlePlacement({ ...current, lat: null, lon: null, confirming: false });
    };
    // 확정 좌표와 현재 게임 위치가 같은 동 영역에 있어야 한다 (동 수준 경계 기준).
    // 게임 위치 = 조이스틱 기점 > 영토전 시작 위치 > GPS 순 (GPS-free 모드에서는 GPS 미사용).
    const baseLat = playerLocation?.lat;
    const baseLon = playerLocation?.lon;
    if (typeof baseLat !== "number" || typeof baseLon !== "number") {
      backToPlacement("현재 위치를 확인할 수 없습니다. 위치를 켜주세요.");
      return;
    }
    setPlacementBusy(true);
    const snappedLocation = await snapToNearestWalkableLocation(current.lat, current.lon).catch(() => null);
    if (!snappedLocation) {
      backToPlacement("이동가능영역 좌표를 찾지 못했습니다. 위치를 다시 지정해주세요.");
      return;
    }
    const base = { lat: baseLat, lon: baseLon };
    let dong = current.dong;
    if (adminLevelRef.current === "dong" && adminGeoJsonRef.current) {
      const baseDong = findAdminCodeAt(adminGeoJsonRef.current, base.lon, base.lat);
      const pickedDong = findAdminCodeAt(
        adminGeoJsonRef.current,
        snappedLocation.lon,
        snappedLocation.lat,
      );
      if (!baseDong) {
        backToPlacement("현재 위치의 동을 확인할 수 없습니다.");
        return;
      }
      if (!pickedDong) {
        backToPlacement("동 영역 안에서 위치를 정하세요.");
        return;
      }
      if (baseDong !== pickedDong) {
        backToPlacement("현재 위치의 동 영역 안에서만 세울 수 있습니다.");
        return;
      }
      dong = baseDong;
    }
    if (!dong) {
      backToPlacement("동을 확인할 수 없습니다. 지도에서 구역을 선택하세요.");
      return;
    }
    setPlacementBusy(true);
    const codeMessage: Record<string, string> = {
      class_ineligible: "계급 조건을 만족하지 않습니다.",
      founder_ineligible: "동 최초 영주성 창시에는 평민 이상 + 공헌 1000이 필요합니다.",
      funds: "영향력이 부족합니다.",
      limit: "축성 상한을 초과했습니다.",
      distance: "성과의 간격 조건을 만족하지 않습니다.",
      no_lord: "영주성이 없어 귀족성을 지을 수 없습니다.",
      accuracy: "GPS 정확도가 낮습니다. 실외로 이동하세요.",
      stale_location: "최근 GPS 기록이 없습니다. 위치를 켜고 잠시 걸어주세요.",
      pool_invalid: "선택한 이벤트를 확인할 수 없습니다.",
      pool_required: "이벤트를 선택하세요.",
      pool_url: "문제풀 주소가 올바르지 않습니다.",
      pool_fetch: "문제풀을 내려받지 못했습니다. 다시 시도하세요.",
      pool_too_large: "문제풀 용량이 너무 큽니다.",
      pool_too_small: "문제풀 문항이 부족합니다 (유효 20문항 이상 필요).",
      pool_columns: "문제풀 형식이 올바르지 않습니다 (answer/difficulty 열 필요).",
      game_castle_season2: "게임성은 다음 시즌에 지원됩니다.",
      invalid: "입력값이 올바르지 않습니다.",
      invalid_coordinates: "좌표가 올바르지 않습니다.",
      login: "로그인이 필요합니다.",
      territory_disabled: "지원하지 않는 미션입니다.",
      build_failed: "축성에 실패했습니다. 다시 시도하세요.",
      failed: "축성에 실패했습니다. 다시 시도하세요.",
    };
    void fetch("/api/castles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dongCode: dong,
        kind: current.kind,
        name: current.name,
        lat: snappedLocation.lat,
        lon: snappedLocation.lon,
        accuracy: location?.accuracy ?? 100,
        poolId: current.poolId,
        hp: current.hp,
      }),
    })
      .then((res) => res.json().catch(() => null))
      .then((data: unknown) => {
        const payload =
          typeof data === "object" && data !== null
            ? (data as { ok?: unknown; pending?: unknown; code?: unknown })
            : null;
        if (payload?.ok === true) {
          setCastlePlacement(null);
          // 새로 지은 성을 지도에 반영한다.
          window.location.reload();
        } else {
          const code = typeof payload?.code === "string" ? payload.code : "";
          backToPlacement(codeMessage[code] ?? "축성에 실패했습니다. 다시 시도하세요.");
        }
      })
      .catch(() => {
        backToPlacement("축성에 실패했습니다. 다시 시도하세요.");
      })
      .finally(() => {
        setPlacementBusy(false);
      });
  }, [location?.lat, location?.lon, location?.accuracy, playerLocation?.lat, playerLocation?.lon, placementBusy]);
  const [lordSelected, setLordSelected] = useState(false);
  const [unitMarks, setUnitMarks] = useState<
    { id: string; name: string; lat: number; lon: number; mine: boolean; moving: boolean; selected: boolean; quizTitle?: string; moveTarget: UnitMoveTargetMark | null }[]
  >([]);
  const unitMarksRef = useRef<typeof unitMarks>([]);
  useEffect(() => {
    unitMarksRef.current = unitMarks;
  }, [unitMarks]);
  const otherUnitMoveAnimRef = useRef(new Map<string, OtherUnitMoveAnim>());
  const otherUnitMoveLoopRef = useRef<number | null>(null);
  const [unitMarkerSelection, setUnitMarkerSelection] = useState<{ id: string; nonce: number } | null>(null);

  const [territoryTargetMarkerUrl, setTerritoryTargetMarkerUrl] = useState<string | null>(null);
  const unitMarkerSelectionNonceRef = useRef(0);
  const handleUnitMarkerClick = useCallback((unitId: string): void => {
    unitMarkerSelectionNonceRef.current += 1;
    setUnitMarkerSelection({ id: unitId, nonce: unitMarkerSelectionNonceRef.current });
  }, []);
  const clearUnitMarkerSelection = useCallback((): void => {
    setUnitMarkerSelection(null);
  }, []);
interface UnitMoveTargetMark {
  fromLat: number;
  fromLon: number;
  lat: number;
  lon: number;
  startedAt: number;
  endsAt: number;
  path?: Array<{ lat: number; lon: number }> | null;
  /** 무법자: 현재 다리 목적지가 놓인 경로 구간의 끝 정점 인덱스 (서버 진행 인덱스). */
  pathIdx?: number | null;
}

interface OtherUnitMoveAnim {
  key: string;
  path: Array<{ lat: number; lon: number }>;
  startedAt: number;
  endsAt: number;
  fromLat: number;
  fromLon: number;
  destLat: number;
  destLon: number;
  done: boolean;
  lastLon: number;
  img: HTMLImageElement | null;
}
  const unitLayerRef = useRef<LayerGroup | null>(null);
  const unitMarkerMapRef = useRef<Map<string, Marker>>(new Map());
  // 위성 마커 전체 재빌드 중복 실행 방지용 서명.
  const markerBuildSigRef = useRef<string | null>(null);
  // 비동기 청크 빌드 실행 id (구 실행 취소용).
  const markerBuildRunRef = useRef(0);
  const unitFacingRef = useRef<Map<string, { lon: number; left: boolean }>>(new Map());
  const [unitMovePath, setUnitMovePath] = useState<Array<{ lat: number; lon: number }> | null>(null);
  // 무법자 이동경로 (클릭 시 빨간 점선).
  const [wildRoutePath, setWildRoutePath] = useState<Array<{ lat: number; lon: number }> | null>(null);
  const [wildRouteWildId, setWildRouteWildId] = useState<number | null>(null);
  // 저장 경로에서 표시용 점 목록 추출.
  const wildPathPoints = (t: UnitMoveTargetMark | null | undefined): Array<{ lat: number; lon: number }> | null => {
    const stored = t?.path;
    if (Array.isArray(stored) && stored.length >= 2) {
      const pts: Array<{ lat: number; lon: number }> = [];
      for (const pt of stored) {
        if (
          typeof pt === "object" &&
          pt !== null &&
          Number.isFinite((pt as { lat?: unknown }).lat) &&
          Number.isFinite((pt as { lon?: unknown }).lon)
        ) {
          pts.push({
            lat: (pt as { lat: number }).lat,
            lon: (pt as { lon: number }).lon,
          });
        }
      }
      return pts.length >= 2 ? pts : null;
    }
    if (
      t &&
      Number.isFinite(t.fromLat) &&
      Number.isFinite(t.fromLon) &&
      Number.isFinite(t.lat) &&
      Number.isFinite(t.lon)
    ) {
      return [
        { lat: t.fromLat, lon: t.fromLon },
        { lat: t.lat, lon: t.lon },
      ];
    }
    return null;
  };
  const wildRouteLayerRef = useRef<LayerGroup | null>(null);
  const unitMovePathLayerRef = useRef<LayerGroup | null>(null);
  // 경로 화살표 재배치용 imperative redraw (줌·이동 시 setState 없이 갱신해 전체 리렌더 방지).
  const redrawPathsRef = useRef<() => void>(() => {});
  /** 이동경로 폴리선 + 진행방향 꺽쇄. 화면에 보이는 구간 길이 기준: 화면 세로 1/2 이상이면 2개, 미만이면 1개. */
  const drawDirectedPath = (
    layer: LayerGroup,
    L: typeof import("leaflet"),
    map: LeafletMap,
    pts: Array<{ lat: number; lon: number }>,
    color: string,
  ): void => {
    layer.clearLayers();
    if (pts.length < 2) {
      return;
    }
    L.polyline(
      pts.map((p) => [p.lat, p.lon]),
      { color: "#ffffff", weight: 7, opacity: 0.9, interactive: false },
    ).addTo(layer);
    L.polyline(
      pts.map((p) => [p.lat, p.lon]),
      { color, weight: 3, opacity: 0.95, dashArray: "6 8", interactive: false },
    ).addTo(layer);
    try {
      const size = map.getSize();
      // 화면 밖으로 긴 경로는 보이는 구간에만 화살표를 둔다 (Cohen-Sutherland 클리핑).
      const pad = 24;
      const rect = { minX: -pad, minY: -pad, maxX: size.x + pad, maxY: size.y + pad };
      const codeOf = (x: number, y: number): number =>
        (x < rect.minX ? 1 : 0) | (x > rect.maxX ? 2 : 0) | (y < rect.minY ? 4 : 0) | (y > rect.maxY ? 8 : 0);
      const cpts = pts.map((p) => map.latLngToContainerPoint([p.lat, p.lon]));
      const pieces: Array<{ ax: number; ay: number; bx: number; by: number; len: number }> = [];
      for (let i = 1; i < cpts.length; i += 1) {
        const a = cpts[i - 1];
        const b = cpts[i];
        if (!a || !b) {
          continue;
        }
        let ax = a.x;
        let ay = a.y;
        let bx = b.x;
        let by = b.y;
        let ca = codeOf(ax, ay);
        let cb = codeOf(bx, by);
        let visible = true;
        for (let guard = 0; guard < 8; guard += 1) {
          if ((ca | cb) === 0) {
            break;
          }
          if ((ca & cb) !== 0) {
            visible = false;
            break;
          }
          const c = ca !== 0 ? ca : cb;
          let x = 0;
          let y = 0;
          if ((c & 8) !== 0) {
            x = ax + ((bx - ax) * (rect.maxY - ay)) / (by - ay);
            y = rect.maxY;
          } else if ((c & 4) !== 0) {
            x = ax + ((bx - ax) * (rect.minY - ay)) / (by - ay);
            y = rect.minY;
          } else if ((c & 2) !== 0) {
            y = ay + ((by - ay) * (rect.maxX - ax)) / (bx - ax);
            x = rect.maxX;
          } else {
            y = ay + ((by - ay) * (rect.minX - ax)) / (bx - ax);
            x = rect.minX;
          }
          if (c === ca) {
            ax = x;
            ay = y;
            ca = codeOf(ax, ay);
          } else {
            bx = x;
            by = y;
            cb = codeOf(bx, by);
          }
        }
        if (!visible) {
          continue;
        }
        const len = Math.hypot(bx - ax, by - ay);
        if (len > 0) {
          pieces.push({ ax, ay, bx, by, len });
        }
      }
      const total = pieces.reduce((s, p) => s + p.len, 0);
      if (total <= 0) {
        return;
      }
      const fracs = total >= size.y / 2 ? [1 / 3, 2 / 3] : [1 / 2];
      for (const f of fracs) {
        const target = total * f;
        let acc = 0;
        let piece = pieces[pieces.length - 1];
        for (const p of pieces) {
          if (acc + p.len >= target) {
            piece = p;
            break;
          }
          acc += p.len;
        }
        if (!piece) {
          continue;
        }
        const t = Math.max(0, Math.min(1, (target - acc) / piece.len));
        const ll = map.containerPointToLatLng([
          piece.ax + (piece.bx - piece.ax) * t,
          piece.ay + (piece.by - piece.ay) * t,
        ]);
        const ang = (Math.atan2(piece.by - piece.ay, piece.bx - piece.ax) * 180) / Math.PI;
        L.marker([ll.lat, ll.lng], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "",
            html: `<svg width="22" height="22" viewBox="0 0 22 22" style="transform:rotate(${ang.toFixed(1)}deg);display:block;"><path d="M6 3 L15 11 L6 19" stroke="#ffffff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 3 L15 11 L6 19" stroke="${color}" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        }).addTo(layer);
      }
    } catch {
      // 화살표 실패해도 폴리선은 유지한다.
    }
  };
  // 렌더마다 최신 경로로 갱신 (줌·이동 핸들러가 setState 없이 호출).
  redrawPathsRef.current = () => {
    const mm = mapInstanceRef.current;
    const LL = leafletRef.current;
    if (!mm || !LL) {
      return;
    }
    if (unitMovePathLayerRef.current) {
      drawDirectedPath(unitMovePathLayerRef.current, LL, mm, unitMovePath ?? [], "#22c55e");
    }
    if (wildRouteLayerRef.current) {
      if (mm.getZoom() < 15) {
        wildRouteLayerRef.current.clearLayers();
      } else {
        drawDirectedPath(wildRouteLayerRef.current, LL, mm, wildRoutePath ?? [], "#ef4444");
      }
    }
  };
  const [unitMoveDestination, setUnitMoveDestination] = useState<{ lat: number; lon: number } | null>(null);
  const unitMoveDestinationLayerRef = useRef<LayerGroup | null>(null);
  const [moveTargetCenter, setMoveTargetCenter] = useState<{ lat: number; lon: number } | null>(null);

  const [edgeIndicators, setEdgeIndicators] = useState<EdgeIndicator[]>([]);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showEventRevisited, setShowEventRevisited] = useState(showEventRevisitedDialog);
  const [attackDenied, setAttackDenied] = useState<string | null>(attackDeniedReason);
  const [showRankingPanel, setShowRankingPanel] = useState(initialShowRanking);

  useEffect(() => {
    if (territoryEnabled) {
      setShowRankingPanel(false);
    }
  }, [territoryEnabled]);
  const [selectedCharacter, setSelectedCharacter] = useState<PlayerCharacter>(initialSettings.selectedCharacter);
  const [mapStyle, setMapStyle] = useState<MapStyle>(initialSettings.mapStyle);
  const [showAdminBoundaries, setShowAdminBoundaries] = useState(false);
  // 영토전 모드에서는 행정구역 표시를 무조건 켠다.
  useEffect(() => {
    if (territoryEnabled) {
      setShowAdminBoundaries(true);
    }
  }, [territoryEnabled]);
  const [adminCountry, setAdminCountry] = useState<string>("KOR");
  const [adminAutoCountry, setAdminAutoCountry] = useState(true);
  const [adminViewport, setAdminViewport] = useState<{ lat: number; lon: number } | null>(null);
  const [adminLevel, setAdminLevel] = useState<AdminLevel>("dong");
  // 전국 단순화본 (줌 아웃·원거리 동). 고해상도 타일이 있는 동은 adminGeoJson에서 교체된다.
  const [adminBaseGeoJson, setAdminBaseGeoJson] = useState<GeoJSON.FeatureCollection | null>(null);
  // 고해상도 동 타일 (tileId → 정규화된 피처). 삽입 순서 = 최근 사용 순.
  const [dongHdTiles, setDongHdTiles] = useState<Map<string, GeoJSON.Feature[]>>(() => new Map());
  const dongHdTilesRef = useRef<Map<string, GeoJSON.Feature[]>>(dongHdTiles);
  dongHdTilesRef.current = dongHdTiles;
  const useDongHd = adminCountry === "KOR" && adminLevel === "dong";
  const adminGeoJson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!adminBaseGeoJson || !useDongHd || dongHdTiles.size === 0) {
      return adminBaseGeoJson;
    }
    const replacements = new Map<string, GeoJSON.Feature[]>();
    dongHdTiles.forEach((features) => {
      for (const feature of features) {
        const code = (feature.properties as Record<string, unknown> | null)?.["_normCode"];
        if (typeof code !== "string" || code === "") {
          continue;
        }
        const list = replacements.get(code);
        if (list) {
          list.push(feature);
        } else {
          replacements.set(code, [feature]);
        }
      }
    });
    const features: GeoJSON.Feature[] = [];
    for (const feature of adminBaseGeoJson.features) {
      const code = (feature.properties as Record<string, unknown> | null)?.["_normCode"];
      const hd = typeof code === "string" ? replacements.get(code) : undefined;
      if (hd) {
        features.push(...hd);
        replacements.delete(code as string);
      } else {
        features.push(feature);
      }
    }
    return { type: "FeatureCollection", features };
  }, [adminBaseGeoJson, useDongHd, dongHdTiles]);
  const [adminLoading, setAdminLoading] = useState(false);
  // 플레이어가 위치한 동 코드 (중립 부대 스폰·조회 기준 — 선택 동과 무관하게 고정).
  const playerDongCode = useMemo(() => {
    if (!playerLocation || !adminGeoJson || !Array.isArray(adminGeoJson.features)) {
      return null;
    }
    const lat = playerLocation.lat;
    const lon = playerLocation.lon;
    const inRing = (ring: number[][], x: number, y: number): boolean => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };
    let best: string | null = null;
    for (const feature of adminGeoJson.features) {
      const geometry = feature.geometry as { type?: unknown; coordinates?: unknown } | null;
      if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
        continue;
      }
      const polys = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
      let inside = false;
      for (const poly of polys) {
        if (Array.isArray(poly) && poly.length > 0 && inRing(poly[0] as number[][], lon, lat)) {
          inside = !inside;
        }
      }
      if (!inside) {
        continue;
      }
      const props = feature.properties as Record<string, unknown> | null;
      const raw = props?.["_normCode"] ?? props?.["code"];
      if (typeof raw === "string" && raw && (!best || raw.length > best.length)) {
        best = raw;
      }
    }
    return best;
  }, [
    // 100m 그리드로 반올림해 이동 시에만 재계산한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    playerLocation ? Math.round(playerLocation.lat * 1000) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    playerLocation ? Math.round(playerLocation.lon * 1000) : null,
    adminGeoJson,
  ]);
  const [selectedAdminCode, setSelectedAdminCode] = useState<string | null>(null);
  const [selectedAdminName, setSelectedAdminName] = useState<string | null>(null);
  const [hoveredAdminCode, setHoveredAdminCode] = useState<string | null>(null);

  // 화면에 보이는 동들의 중립 부대 시드 (동 코드 + 대표 좌표, 12개 상한).
  // 중립성과 동일 조건: 플레이어 20km 이내 동 또는 선택 동만.
  const [wildSeeds, setWildSeeds] = useState<Array<{ dong: string; lat: number; lon: number }>>([]);
  useEffect(() => {
    if (!territoryEnabled || !isMapReady || !adminGeoJson || !Array.isArray(adminGeoJson.features) || !playerLocation) {
      return;
    }
    const playerSeedLat = playerLocation.lat;
    const playerSeedLon = playerLocation.lon;
    const compute = (): void => {
      const map = mapInstanceRef.current;
      if (!map) {
        return;
      }
      let bounds: { getNorth: () => number; getSouth: () => number; getWest: () => number; getEast: () => number } | null = null;
      let centerLat = 0;
      let centerLon = 0;
      try {
        bounds = map.getBounds();
        const center = map.getCenter();
        centerLat = center.lat;
        centerLon = center.lng;
      } catch {
        return;
      }
      if (!bounds) {
        return;
      }
      const north = bounds.getNorth();
      const south = bounds.getSouth();
      const west = bounds.getWest();
      const east = bounds.getEast();
      const seen = new Set<string>();
      const list: Array<{ dong: string; lat: number; lon: number; d: number }> = [];
      for (const feature of adminGeoJson.features) {
        const props = feature.properties as Record<string, unknown> | null;
        const raw = props?.["_normCode"] ?? props?.["code"];
        if (typeof raw !== "string" || !raw || seen.has(raw)) {
          continue;
        }
        const geometry = feature.geometry as { type?: unknown; coordinates?: unknown } | null;
        if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
          continue;
        }
        const polys = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        for (const poly of polys) {
          if (!Array.isArray(poly)) {
            continue;
          }
          for (const ring of poly) {
            if (!Array.isArray(ring)) {
              continue;
            }
            for (const pt of ring as number[][]) {
              const x = pt[0];
              const y = pt[1];
              if (!Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
              }
              if (x < minLon) {
                minLon = x;
              }
              if (x > maxLon) {
                maxLon = x;
              }
              if (y < minLat) {
                minLat = y;
              }
              if (y > maxLat) {
                maxLat = y;
              }
            }
          }
        }
        if (!Number.isFinite(minLon)) {
          continue;
        }
        // 중립성 반경(20km) 밖이고 선택 동도 아니면 제외한다.
        const seedLat = (minLat + maxLat) / 2;
        const seedLon = (minLon + maxLon) / 2;
        if (raw !== selectedAdminCode && calculateDistance(playerSeedLat, playerSeedLon, seedLat, seedLon) > 20000) {
          continue;
        }
        if (maxLon < west || minLon > east || maxLat < south || minLat > north) {
          continue;
        }
        seen.add(raw);
        const cLat = (minLat + maxLat) / 2;
        const cLon = (minLon + maxLon) / 2;
        const d = Math.abs(cLat - centerLat) + Math.abs(cLon - centerLon);
        list.push({ dong: raw, lat: cLat, lon: cLon, d });
      }
      list.sort((a, b) => a.d - b.d);
      const next = list.slice(0, 12).map(({ dong, lat, lon }) => ({ dong, lat, lon }));
      setWildSeeds((prev) => {
        if (prev.length === next.length && prev.every((v, i) => v.dong === next[i].dong)) {
          return prev;
        }
        return next;
      });
    };
    compute();
    const map = mapInstanceRef.current;
    try {
      map?.on("moveend", compute);
    } catch {}
    const timer = window.setInterval(compute, 15_000);
    return () => {
      window.clearInterval(timer);
      try {
        map?.off("moveend", compute);
      } catch {}
    };
  }, [territoryEnabled, isMapReady, adminGeoJson, playerLocation, selectedAdminCode]);

  useEffect(() => {
    adminGeoJsonRef.current = adminGeoJson;
    adminLevelRef.current = adminLevel;
    setAdminGeoTick((tick) => tick + 1);
  }, [adminGeoJson, adminLevel]);

  useEffect(() => {
    try {
      const perStyleKey = `map-zoom:${locationCacheKey}:${mapStyle}`;
      const existing = sessionStorage.getItem(perStyleKey);
      if (!hasRestoredZoomRef.current && existing !== null && existing !== String(zoomLevel)) {
        return;
      }
      sessionStorage.setItem(perStyleKey, String(zoomLevel));
      sessionStorage.setItem(`map-zoom:${locationCacheKey}`, String(zoomLevel));
    } catch {}
  }, [zoomLevel, locationCacheKey, mapStyle]);
  useEffect(() => {
    if (!showAdminBoundaries) {
      setAdminBaseGeoJson(null);
      setSelectedAdminCode(null);
      setSelectedAdminName(null);
      return;
    }
    let cancelled = false;
    setAdminLoading(true);
    fetchBoundary(adminCountry, adminLevel)
      .then((fc) => {
        if (cancelled) {
          return;
        }
        for (const feat of fc.features) {
          const rawProps: unknown = (feat as unknown as { properties: unknown }).properties;
          const norm = normalizeProperties(rawProps, adminCountry, adminLevel);
          (feat as unknown as { properties: Record<string, unknown> }).properties = {
            ...((rawProps as Record<string, unknown> | null) ?? {}),
            _normName: norm.name,
            _normCode: norm.code,
            _displayName: getDisplayName(norm),
          };
        }
        setAdminBaseGeoJson(fc as unknown as GeoJSON.FeatureCollection);
        setAdminLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setAdminLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showAdminBoundaries, adminCountry, adminLevel]);
  useEffect(() => {
    adminSelectedRef.current = selectedAdminCode;
  }, [selectedAdminCode]);

  // 선택 이름은 클릭 시점 저장값에 의존하지 않고 경계 데이터에서 직접 찾는다.
  // (이름이 비어 들어오는 경로가 있어도 패널에 동 이름이 표시되도록)
  const selectedAdminDisplayName: string | null = (() => {
    if (selectedAdminName) {
      return selectedAdminName;
    }
    if (!selectedAdminCode || !adminGeoJson) {
      return selectedAdminCode;
    }
    const features = (adminGeoJson as unknown as { features?: unknown }).features;
    if (!Array.isArray(features)) {
      return selectedAdminCode;
    }
    for (const feat of features) {
      const props = (feat as { properties?: unknown } | null)?.properties as Record<
        string,
        unknown
      > | null;
      if (!props) {
        continue;
      }
      const code = props["_normCode"] ?? props["code"];
      if (code !== selectedAdminCode) {
        continue;
      }
      const name = props["_displayName"] ?? props["_normName"];
      return typeof name === "string" && name !== "" ? name : selectedAdminCode;
    }
    return selectedAdminCode;
  })();

  // 고해상도 동 경계 타일 로딩: 플레이어 주변은 항상, 화면 영역은 DONG_HD_MIN_ZOOM 이상에서.
  useEffect(() => {
    if (!showAdminBoundaries || !useDongHd) {
      return;
    }
    const boxes: Array<{ west: number; south: number; east: number; north: number }> = [];
    if (playerLocation && Number.isFinite(playerLocation.lat) && Number.isFinite(playerLocation.lon)) {
      boxes.push({
        west: playerLocation.lon - 0.005,
        east: playerLocation.lon + 0.005,
        south: playerLocation.lat - 0.005,
        north: playerLocation.lat + 0.005,
      });
    }
    if (adminViewport && zoomLevel >= DONG_HD_MIN_ZOOM) {
      // 회전 지도를 고려해 화면 긴 변 기준 정사각형 + 20% 여유.
      const screenPx = Math.max(window.innerWidth || 0, window.innerHeight || 0, 800);
      const halfLon = ((0.5 * screenPx * 360) / (256 * 2 ** zoomLevel)) * 1.2;
      const halfLat = halfLon * Math.cos((adminViewport.lat * Math.PI) / 180);
      boxes.push({
        west: adminViewport.lon - halfLon,
        east: adminViewport.lon + halfLon,
        south: adminViewport.lat - halfLat,
        north: adminViewport.lat + halfLat,
      });
    }
    if (boxes.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const wanted = await findDongHdTiles(boxes);
      const missing = wanted.filter((id) => !dongHdTilesRef.current.has(id));
      if (cancelled || missing.length === 0) {
        return;
      }
      const loaded = await Promise.all(
        missing.map(async (id) => {
          const features = await fetchDongHdFeatures([id]);
          for (const feat of features) {
            const rawProps: unknown = feat.properties;
            const norm = normalizeProperties(rawProps, "KOR", "dong");
            feat.properties = {
              ...((rawProps as Record<string, unknown> | null) ?? {}),
              _normName: norm.name,
              _normCode: norm.code,
              _displayName: getDisplayName(norm),
            };
          }
          return [id, features] as const;
        })
      );
      if (cancelled) {
        return;
      }
      setDongHdTiles((prev) => {
        const next = new Map(prev);
        // 이번 요청 타일을 최근 사용으로 갱신.
        for (const id of wanted) {
          const existing = next.get(id);
          if (existing) {
            next.delete(id);
            next.set(id, existing);
          }
        }
        for (const [id, features] of loaded) {
          if (features.length > 0) {
            next.set(id, features);
          }
        }
        // 오래 안 쓴 타일부터 정리해 렌더 대상 꼭짓점 수를 제한한다 (현재 요청 타일은 유지).
        const keep = new Set(wanted);
        for (const id of next.keys()) {
          if (next.size <= DONG_HD_TILE_LIMIT) {
            break;
          }
          if (!keep.has(id)) {
            next.delete(id);
          }
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // 플레이어 좌표는 약 100m 단위로만 반영한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showAdminBoundaries,
    useDongHd,
    adminViewport,
    zoomLevel,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    playerLocation ? Math.round(playerLocation.lat * 1000) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    playerLocation ? Math.round(playerLocation.lon * 1000) : null,
  ]);

  const updateAdminViewport = useCallback((lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    setAdminViewport((prev) => {
      if (prev && Math.abs(prev.lat - lat) < 0.01 && Math.abs(prev.lon - lon) < 0.01) {
        return prev;
      }
      return { lat, lon };
    });
  }, []);

  useEffect(() => {
    if (showAdminBoundaries && !adminViewport && playerLocation) {
      updateAdminViewport(playerLocation.lat, playerLocation.lon);
    }
  }, [showAdminBoundaries, adminViewport, playerLocation, updateAdminViewport]);

  useEffect(() => {
    if (!showAdminBoundaries || !adminAutoCountry || !adminViewport) {
      return;
    }
    const detected = detectCountryByLatLon(adminViewport.lat, adminViewport.lon);
    if (detected && detected !== adminCountry) {
      setAdminCountry(detected);
      setSelectedAdminCode(null);
      setSelectedAdminName(null);
    }
  }, [adminViewport, showAdminBoundaries, adminAutoCountry, adminCountry]);

  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-admin-focus-fix", "true");
    style.textContent = [
      ".leaflet-interactive:focus{outline:none!important;box-shadow:none!important}",
      ".maplibregl-canvas:focus,.maplibregl-canvas-container:focus{outline:none!important;box-shadow:none!important}",
      ".cesium-widget canvas:focus{outline:none!important;box-shadow:none!important}",
      ".cesium-selection-wrapper,.cesium-selection-wrapper-visible{display:none!important}",
      ".leaflet-container:focus{outline:none!important}",
    ].join("\n");
    document.head.appendChild(style);
    return () => {
      try {
        document.head.removeChild(style);
      } catch {}
    };
  }, []);

  const [walkingFrameFiles, setWalkingFrameFiles] = useState<string[]>([]);
  const [fallenAngelFrameFiles, setFallenAngelFrameFiles] = useState<string[]>([]);
  const [walkingFrameObjectUrls, setWalkingFrameObjectUrls] = useState<string[]>([]);
  const [fallenAngelFrameObjectUrls, setFallenAngelFrameObjectUrls] = useState<string[]>([]);
  const [walkingFramesFailed, setWalkingFramesFailed] = useState(false);
  const [fallenAngelFramesFailed, setFallenAngelFramesFailed] = useState(false);
  const [isWalkingFramesLoading, setIsWalkingFramesLoading] = useState(true);
  const [isFallenAngelFramesLoading, setIsFallenAngelFramesLoading] = useState(true);
  const hasAnimatedRef = useRef(false);
  const hasSyncedSettingsRef = useRef(false);
  const hasRestoredZoomRef = useRef(false);
  const mapRotationDegRef = useRef(0);
  const updateEdgeIndicatorsRef = useRef<(() => void) | null>(null);
  const lastMapRotationCommitTimeRef = useRef<number | null>(null);
  useEffect(() => {
    let isCancelled = false;

    const fetchFrameFiles = async (character: "walking" | "fallenAngel"): Promise<string[]> => {
      try {
        const response = await fetch(`/api/walking-frames?character=${character}`, {
          credentials: "include",
        });

        if (!response.ok) {
          return [];
        }

        const json = (await response.json()) as { frames?: unknown };
        return Array.isArray(json.frames)
          ? json.frames.filter((value): value is string => typeof value === "string")
          : [];
      } catch {
        return [];
      }
    };

    const loadSpriteFrames = async () => {
      const [walkingFrames, fallenAngelFrames] = await Promise.all([
        fetchFrameFiles("walking"),
        fetchFrameFiles("fallenAngel"),
      ]);

      if (isCancelled) {
        return;
      }

      setWalkingFrameFiles(walkingFrames);
      setFallenAngelFrameFiles(fallenAngelFrames);
      setWalkingFramesFailed(walkingFrames.length === 0);
      setFallenAngelFramesFailed(fallenAngelFrames.length === 0);
      setIsWalkingFramesLoading(false);
      setIsFallenAngelFramesLoading(false);
    };

    void loadSpriteFrames();

    return () => {
      isCancelled = true;
    };
  }, []);

  const walkingFrameRequestUrls = useMemo(() => {
    return walkingFrameFiles.map((fileName) => {
      return `/api/walking-frames?character=walking&file=${encodeURIComponent(fileName)}`;
    });
  }, [walkingFrameFiles]);

  const fallenAngelFrameRequestUrls = useMemo(() => {
    return fallenAngelFrameFiles.map((fileName) => {
      return `/api/walking-frames?character=fallenAngel&file=${encodeURIComponent(fileName)}`;
    });
  }, [fallenAngelFrameFiles]);

  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();
    const createdObjectUrls: string[] = [];

    const preloadWalkingFrames = async () => {
      if (walkingFrameRequestUrls.length === 0) {
        setWalkingFrameObjectUrls([]);
        return;
      }

      try {
        const fetchedObjectUrls = await Promise.all(
          walkingFrameRequestUrls.map(async (frameUrl) => {
            const response = await fetch(frameUrl, {
              credentials: "include",
              signal: controller.signal,
            });

            if (!response.ok) {
              return null;
            }

            const imageBlob = await response.blob();
            const objectUrl = URL.createObjectURL(imageBlob);
            createdObjectUrls.push(objectUrl);
            return objectUrl;
          }),
        );
        const nextObjectUrls = fetchedObjectUrls.filter(
          (objectUrl): objectUrl is string => objectUrl !== null,
        );

        if (!isCancelled) {
          setWalkingFrameObjectUrls(nextObjectUrls);
          setWalkingFramesFailed(nextObjectUrls.length === 0);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (!isCancelled) {
          setWalkingFrameObjectUrls([]);
          setWalkingFramesFailed(true);
        }
      }
    };

    void preloadWalkingFrames();

    return () => {
      isCancelled = true;
      controller.abort();

      for (const objectUrl of createdObjectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [walkingFrameRequestUrls]);

  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();
    const createdObjectUrls: string[] = [];

    const preloadFallenAngelFrames = async () => {
      if (fallenAngelFrameRequestUrls.length === 0) {
        setFallenAngelFrameObjectUrls([]);
        return;
      }

      try {
        const fetchedObjectUrls = await Promise.all(
          fallenAngelFrameRequestUrls.map(async (frameUrl) => {
            const response = await fetch(frameUrl, {
              credentials: "include",
              signal: controller.signal,
            });

            if (!response.ok) {
              return null;
            }

            const imageBlob = await response.blob();
            const objectUrl = URL.createObjectURL(imageBlob);
            createdObjectUrls.push(objectUrl);
            return objectUrl;
          }),
        );
        const nextObjectUrls = fetchedObjectUrls.filter(
          (objectUrl): objectUrl is string => objectUrl !== null,
        );

        if (!isCancelled) {
          setFallenAngelFrameObjectUrls(nextObjectUrls);
          setFallenAngelFramesFailed(nextObjectUrls.length === 0);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (!isCancelled) {
          setFallenAngelFrameObjectUrls([]);
          setFallenAngelFramesFailed(true);
        }
      }
    };

    void preloadFallenAngelFrames();

    return () => {
      isCancelled = true;
      controller.abort();

      for (const objectUrl of createdObjectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [fallenAngelFrameRequestUrls]);

  const walkingFrameUrls = useMemo(() => {
    return walkingFrameObjectUrls;
  }, [walkingFrameObjectUrls]);

  const fallenAngelFrameUrls = useMemo(() => {
    return fallenAngelFrameObjectUrls;
  }, [fallenAngelFrameObjectUrls]);

  const activePlayerCharacter = useMemo<PlayerCharacter | null>(() => {
    if (selectedCharacter === "walking") {
      if (walkingFrameUrls.length > 0) {
        return "walking";
      }
      return walkingFramesFailed ? "fallenAngel" : null;
    }

    if (selectedCharacter === "fallenAngel") {
      if (fallenAngelFrameUrls.length > 0) {
        return "fallenAngel";
      }
      return fallenAngelFramesFailed ? "fallenAngel" : null;
    }

    return selectedCharacter;
  }, [selectedCharacter, walkingFrameUrls, fallenAngelFrameUrls, walkingFramesFailed, fallenAngelFramesFailed]);

  const [neutralPoints, setNeutralPoints] = useState<MapPoint[]>([]);
  const [walkablePointLocations, setWalkablePointLocations] = useState<Map<string, { lat: number; lon: number }>>(
    () => new Map(),
  );
  const correctingCastleKeysRef = useRef(new Set<string>());
  const satelliteFollowPositionRef = useRef<{ map: LeafletMap; lat: number; lon: number } | null>(null);
  const [selectedNeutralPoints, setSelectedNeutralPoints] = useState<MapPoint[]>([]);
  const neutralCenterRef = useRef<{ lat: number; lon: number } | null>(null);

  // 성 종류표 (지도 마커 아이콘 구분용: 영주성/귀족성).
  const [castleKindMap, setCastleKindMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!territoryEnabled) {
      return;
    }
    let cancelled = false;
    void fetch("/api/castles/list")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") {
          return;
        }
        const castles = (data as { castles?: unknown }).castles;
        if (!Array.isArray(castles)) {
          return;
        }
        const next = new Map<string, string>();
        for (const row of castles as Record<string, unknown>[]) {
          if (typeof row.castleKey === "string" && typeof row.kind === "string") {
            next.set(row.castleKey.trim(), row.kind);
          }
        }
        setCastleKindMap(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [territoryEnabled]);

  const castleKindOf = (eventKey?: string | null): string | null => {
    const key = (eventKey ?? "").trim();
    if (!key.startsWith("castle-")) {
      return null;
    }
    return castleKindMap.get(key) ?? null;
  };

  useEffect(() => {
    if (!territoryEnabled || castleKindMap.size === 0) return;
    const castles = points.filter(
      (point) => point.eventKey?.startsWith("castle-") && castleKindMap.has(point.eventKey),
    );
    if (castles.length === 0) return;
    let cancelled = false;
    const corrections: {
      castleKey: string;
      fromLat: number;
      fromLon: number;
      toLat: number;
      toLon: number;
    }[] = [];
    void Promise.all(castles.map(async (point) => {
      const key = point.eventKey;
      if (!key || correctingCastleKeysRef.current.has(key)) return;
      correctingCastleKeysRef.current.add(key);
      const snapped = await snapToNearestWalkableLocation(point.lat, point.lon);
      if (!snapped || snapped.distanceM < 0.5) {
        correctingCastleKeysRef.current.delete(key);
        return;
      }
      corrections.push({
        castleKey: key,
        fromLat: point.lat,
        fromLon: point.lon,
        toLat: snapped.lat,
        toLon: snapped.lon,
      });
    })).then(() => {
      if (cancelled || corrections.length === 0) return;
      setWalkablePointLocations((current) => {
        const next = new Map(current);
        corrections.forEach((correction) => {
          next.set(correction.castleKey, { lat: correction.toLat, lon: correction.toLon });
        });
        return next;
      });
      void Promise.all(
        Array.from({ length: Math.ceil(corrections.length / 100) }, (_, batchIndex) =>
          fetch("/api/castles/correct-locations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ corrections: corrections.slice(batchIndex * 100, (batchIndex + 1) * 100) }),
          }),
        ),
      ).then((responses) => {
        if (responses.some((response) => !response.ok)) {
          corrections.forEach((correction) => correctingCastleKeysRef.current.delete(correction.castleKey));
        }
      }).catch(() => {
        corrections.forEach((correction) => correctingCastleKeysRef.current.delete(correction.castleKey));
      });
    }).catch(() => {
      castles.forEach((point) => {
        if (point.eventKey) correctingCastleKeysRef.current.delete(point.eventKey);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [territoryEnabled, points, castleKindMap]);

  // 영토전 중립성: 플레이어 20km 내 사무소 로딩 (500m 이상 이동 시 갱신).
  // 기준은 플레이어 위치 (조이스틱 기점 포함) — 직접 GPS 금지.
  useEffect(() => {
    if (!territoryEnabled || !playerLocation) {
      return;
    }
    const center = neutralCenterRef.current;
    if (
      center &&
      calculateDistance(center.lat, center.lon, playerLocation.lat, playerLocation.lon) <
        NEUTRAL_OFFICE_REFRESH_M
    ) {
      return;
    }
    let cancelled = false;
    void loadNeutralOffices().then((offices) => {
      if (cancelled) {
        return;
      }
      const nearby: MapPoint[] = [];
      offices.forEach((office, index) => {
        if (
          calculateDistance(playerLocation.lat, playerLocation.lon, office.lat, office.lon) <=
          NEUTRAL_OFFICE_RADIUS_M
        ) {
          nearby.push({
            id: -(index + 1),
            lat: office.lat,
            lon: office.lon,
            label: office.name,
            eventType: "NeutralType",
            eventKey: office.key,
          });
        }
      });
      if (!cancelled) {
        neutralCenterRef.current = { lat: playerLocation.lat, lon: playerLocation.lon };
        setNeutralPoints(nearby);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [territoryEnabled, playerLocation]);

  // 선택 지역의 중립성은 플레이어와의 거리와 관계없이 표시한다.
  useEffect(() => {
    if (!territoryEnabled || !selectedAdminCode || !adminGeoJson) {
      setSelectedNeutralPoints([]);
      return;
    }
    const selectedRegion: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: adminGeoJson.features.filter((feature) => {
        const properties = feature.properties as Record<string, unknown> | null;
        return (properties?.["_normCode"] ?? properties?.["code"]) === selectedAdminCode;
      }),
    };
    let cancelled = false;
    setSelectedNeutralPoints([]);
    void loadNeutralOffices().then((offices) => {
      if (cancelled) return;
      const selected: MapPoint[] = [];
      offices.forEach((office, index) => {
        if (
          office.key !== `neutral-${selectedAdminCode}` &&
          findAdminCodeAt(selectedRegion, office.lon, office.lat) !== selectedAdminCode
        ) return;
        selected.push({
          id: -(index + 1),
          lat: office.lat,
          lon: office.lon,
          label: office.name,
          eventType: "NeutralType",
          eventKey: office.key,
        });
      });
      setSelectedNeutralPoints(selected);
    });
    return () => {
      cancelled = true;
    };
  }, [territoryEnabled, selectedAdminCode, adminGeoJson]);

  const renderablePoiPoints = useMemo(() => {
    const base = points.filter((point) => isRenderablePoiEventType(point.eventType));
    if (!territoryEnabled) {
      return base;
    }
    const neutralById = new Map(
      [...neutralPoints, ...selectedNeutralPoints].map((point) => [point.id, point]),
    );
    return base.concat([...neutralById.values()]).map((point) => {
      const corrected = point.eventKey ? walkablePointLocations.get(point.eventKey) : undefined;
      return corrected ? { ...point, ...corrected } : point;
    });
  }, [points, territoryEnabled, neutralPoints, selectedNeutralPoints, walkablePointLocations]);

  /** 마커 표시용: 줌 15 미만에서는 중립성·성을 숨긴다 (이동가능영역과 동일 조건).
   *  근접 판정·개수·패널 로직은 renderablePoiPoints를 그대로 쓴다. */
  const markerPoiPoints = useMemo(
    () =>
      zoomLevel < 15
        ? renderablePoiPoints.filter(
            (point) =>
              !isNeutralEventKey(point.eventKey) &&
              !(point.eventKey ?? "").trim().startsWith("castle-"),
          )
        : renderablePoiPoints,
    [renderablePoiPoints, zoomLevel],
  );

  const visitedEventKeySet = useMemo(() => {
    return new Set(
      visitedEventKeys.map((eventKey) => eventKey.trim()).filter((eventKey) => eventKey.length > 0)
    );
  }, [visitedEventKeys]);

  const neutralDamageExpiresAtRef = useRef(new Map<string, number>());
  const neutralDamageScoreSignatureRef = useRef<string | null>(null);
  const pendingNeutralDamageCompletionRef = useRef<{ eventKey: string; signature: string } | null>(null);
  const completedEventKey = searchParams.get("completedEventKey")?.trim() ?? "";
  const neutralDamageScoreSignature = searchParams.get("scoreNonce") ??
    `${searchParams.get("addedScore") ?? ""}:${completedEventKey}`;
  useEffect(() => {
    if (searchParams.get("scoreUpdated") === "true" && completedEventKey.startsWith(NEUTRAL_EVENT_PREFIX)) {
      pendingNeutralDamageCompletionRef.current = {
        eventKey: completedEventKey,
        signature: neutralDamageScoreSignature,
      };
    }
    const pending = pendingNeutralDamageCompletionRef.current;
    if (!pending) return;
    if (neutralDamageScoreSignatureRef.current === pending.signature) return;
    neutralDamageExpiresAtRef.current.set(
      pending.eventKey,
      Date.now() + NEUTRAL_DAMAGE_ANIMATION_MS,
    );
    neutralDamageScoreSignatureRef.current = pending.signature;
    pendingNeutralDamageCompletionRef.current = null;
  }, [searchParams, completedEventKey, neutralDamageScoreSignature, visitedEventKeySet]);

  const getNeutralDamageExpiry = useCallback((eventKey?: string | null): number | null => {
    const key = eventKey?.trim() ?? "";
    const expiresAt = neutralDamageExpiresAtRef.current.get(key);
    if (!expiresAt || expiresAt <= Date.now()) {
      return null;
    }
    return expiresAt;
  }, []);

  const isVisitedEventKey = useCallback((eventKey?: string): boolean => {
    const trimmed = eventKey?.trim() ?? "";
    return trimmed.length > 0 && visitedEventKeySet.has(trimmed);
  }, [visitedEventKeySet]);

  const getVisitedScore = useCallback((eventKey?: string): number | null => {
    const trimmed = eventKey?.trim() ?? "";
    if (!trimmed) {
      return null;
    }
    const score = visitedScores[trimmed];
    return typeof score === "number" && Number.isFinite(score) ? score : null;
  }, [visitedScores]);

  const totalMarkerCount = renderablePoiPoints.filter(
    (point) => !isNeutralEventKey(point.eventKey)
  ).length;
  const unvisitedMarkerCount = useMemo(() => {
    return renderablePoiPoints.filter(
      (point) => !isNeutralEventKey(point.eventKey) && !isVisitedEventKey(point.eventKey)
    ).length;
  }, [renderablePoiPoints, isVisitedEventKey]);

  const myRank = useMemo(() => {
    const nickname = rankingNickname ?? playerNickname ?? "";
    if (!nickname) {
      return null;
    }
    const sorted = [...rankingItems].sort((a, b) => b.score - a.score);
    const index = sorted.findIndex((item) => item.nickname === nickname);
    return index >= 0 ? index + 1 : null;
  }, [rankingItems, rankingNickname, playerNickname]);

  const celebrateVisitedMarkers = useCallback(() => {
    // 500ms 스로틀 + 마커 레지스트리가 전부 비었으면 DOM 스캔 생략
    // (리로드 직후 마커 생성 폭주 중 매번 querySelector를 돌지 않게).
    const nowThrottle = Date.now();
    if (nowThrottle - celebrateLastAttemptRef.current < 500) {
      return;
    }
    celebrateLastAttemptRef.current = nowThrottle;
    if (
      poiMarkerElementsRef.current.size === 0 &&
      globePoiElementsRef.current.size === 0 &&
      cesiumPoiElementsRef.current.size === 0 &&
      !pseudoMarkerRef.current &&
      !pseudoMarker2Ref.current &&
      !pseudoMarker3Ref.current
    ) {
      return;
    }
    const celebrated = readCelebratedTimes();
    let dirty = false;
    celebrated.forEach((_, key) => {
      if (!visitedEventKeySet.has(key)) {
        celebrated.delete(key);
        dirty = true;
      }
    });
    const animateElement = (root: HTMLElement | null): boolean => {
      if (!root) {
        return false;
      }
      root.classList.remove("morph-pending");
      const target = root.querySelector(".three-poi-marker-visited-wrap");
      console.log("[Celebrate] animate try (element)", {
        hasRoot: Boolean(root),
        hasTarget: Boolean(target),
      });
      if (!target) {
        return false;
      }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return true;
      }

      const redMarker = target.querySelector(".three-poi-marker-visited-red");
      const greenMarker = target.querySelector(".three-poi-marker-visited");
      const ripple = target.querySelector(".three-poi-marker-visited-ripple");
      const glow = target.querySelector(".three-poi-marker-visited-glow");
      const delay = 0;
      const duration = 1800;
      target.animate(
        [
          { transform: "scale(0) rotateY(-90deg)", filter: "brightness(2)" },
          { transform: "scale(1.5) rotateY(0deg)", filter: "brightness(1.6)", offset: 0.3 },
          { transform: "scale(0.9) rotateY(0deg)", filter: "brightness(1)", offset: 0.55 },
          { transform: "scale(1.12) rotateY(0deg)", offset: 0.75 },
          { transform: "scale(1) rotateY(0deg)" },
        ],
        { delay, duration, easing: "cubic-bezier(0.2, 1.4, 0.3, 1)", iterations: 2 }
      );
      redMarker?.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { delay, duration: 1200, easing: "ease-out", fill: "both" }
      );
      greenMarker?.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { delay, duration: 1200, easing: "ease-out", fill: "both" }
      );
      ripple?.animate(
        [
          { opacity: 0, transform: "scale(0.7)" },
          { opacity: 0.8, offset: 0.18 },
          { opacity: 0, transform: "scale(5)" },
        ],
        { delay, duration, easing: "ease-out", iterations: 2 }
      );
      glow?.animate(
        [
          { opacity: 0, transform: "scale(0.75)" },
          { opacity: 0.9, transform: "scale(1.35)", offset: 0.3 },
          { opacity: 0.45, transform: "scale(1)", offset: 0.65 },
          { opacity: 0.75, transform: "scale(1.2)" },
        ],
        { delay, duration, easing: "ease-in-out", iterations: 2 }
      );
      return true;
    };
    const animateMarkerElement = (marker: Marker | null | undefined): boolean => {
      const root = marker?.getElement();
      return animateElement(root as unknown as HTMLElement | null);
    };
    const animatedKeys: string[] = [];
    const now = Date.now();
    console.log("[Celebrate] attempt", {
      uncelebrated: [...visitedEventKeySet].filter((key) => {
        const recordedAt = celebrated.get(key);
        return recordedAt === undefined || now - recordedAt <= CELEBRATE_REPLAY_GRACE_MS;
      }),
      registry: [...poiMarkerElementsRef.current.keys()],
      globeRegistry: [...globePoiElementsRef.current.keys()],
      cesiumRegistry: [...cesiumPoiElementsRef.current.keys()],
    });
    visitedEventKeySet.forEach((key) => {
      const recordedAt = celebrated.get(key);
      if (recordedAt !== undefined && now - recordedAt > CELEBRATE_REPLAY_GRACE_MS) {
        return;
      }
      const singleMarker = poiMarkerElementsRef.current.get(key);
      if (singleMarker && animateMarkerElement(singleMarker)) {
        animatedKeys.push(key);
        return;
      }
      const debugMarker =
        key === DEBUG_PSEUDO_MARKER_EVENT_KEY
          ? pseudoMarkerRef.current
          : key === DEBUG_PSEUDO_MARKER2_EVENT_KEY
            ? pseudoMarker2Ref.current
            : key === DEBUG_PSEUDO_MARKER3_EVENT_KEY
              ? pseudoMarker3Ref.current
              : null;
      if (animateMarkerElement(debugMarker)) {
        animatedKeys.push(key);
        return;
      }
      const globeElement = globePoiElementsRef.current.get(key);
      if (globeElement && animateElement(globeElement)) {
        animatedKeys.push(key);
        return;
      }
      const cesiumElement = cesiumPoiElementsRef.current.get(key);
      if (cesiumElement && animateElement(cesiumElement)) {
        animatedKeys.push(key);
        return;
      }
    });
    if (animatedKeys.length > 0) {
      animatedKeys.forEach((key) => celebrated.set(key, Date.now()));
      dirty = true;
    }
    if (dirty) {
      writeCelebratedTimes(celebrated);
    }
  }, [visitedEventKeySet]);

  useEffect(() => {
    if (!hasSyncedSettingsRef.current) {
      hasSyncedSettingsRef.current = true;
      return;
    }

    const controller = new AbortController();

    const saveSettings = async () => {
      try {
        await fetch("/api/map-settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            selectedCharacter,
            mapStyle,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        console.error("[map-settings] failed to save", error);
      }
    };

    void saveSettings();

    return () => {
      controller.abort();
    };
  }, [selectedCharacter, mapStyle]);

  const animationCompleteRef = useRef(false);
  const hasRefreshedForScoreRef = useRef(false);
  const scoreAnimSigRef = useRef<string | null>(null);
  const scoreAnimRef = useRef<{ addedScore: number } | null>(null);
  const scoreCelebrationPendingRef = useRef(false);
  // Celebrate DOM 스캔 폭주 방지 (마커 생성 중 매 렌더마다 호출됨).
  const celebrateLastAttemptRef = useRef(0);

  {
    const scoreUpdatedParam = searchParams.get("scoreUpdated");
    const sig = scoreUpdatedParam === "true"
      ? `true:${searchParams.get("addedScore") ?? ""}:${searchParams.get("scoreNonce") ?? ""}`
      : null;
    if (sig !== scoreAnimSigRef.current) {
      console.log("[ScoreAnim] sig changed", {
        previous: scoreAnimSigRef.current,
        next: sig,
        alreadyAnimated: sig ? hasAnimatedScoreSig(sig) : false,
      });
      scoreAnimSigRef.current = sig;
      const parsed = parseInt(searchParams.get("addedScore") ?? "", 10);
      scoreAnimRef.current = sig && !hasAnimatedScoreSig(sig)
        ? { addedScore: Number.isFinite(parsed) ? parsed : 0 }
        : null;
      hasAnimatedRef.current = false;
      hasRefreshedForScoreRef.current = false;
    }
  }

  useEffect(() => {
    if (searchParams.get("scoreUpdated") === "true") {
      router.replace("/map");
    }

    const captured = scoreAnimRef.current;
    console.log("[ScoreAnim] effect", {
      hasParams: searchParams.get("scoreUpdated") === "true",
      hasCaptured: Boolean(captured),
      alreadyAnimated: hasAnimatedRef.current,
      addedScore: captured?.addedScore ?? null,
      currentScore: initialPlayerScore ?? 0,
      playerScore,
      animateScore,
    });
    if (!captured || hasAnimatedRef.current) {
      return;
    }

    const currentScore = initialPlayerScore ?? 0;
    const addedScore = captured.addedScore;

    if (currentScore < addedScore) {
      if (!hasRefreshedForScoreRef.current) {
        hasRefreshedForScoreRef.current = true;
        console.log("[ScoreAnim] refreshing for fresh total", { currentScore, addedScore });
        router.refresh();
        return;
      }
      hasAnimatedRef.current = true;
      if (scoreAnimSigRef.current) {
        markScoreAnimatedSig(scoreAnimSigRef.current);
      }
      animationCompleteRef.current = true;
      setPlayerScore(currentScore);
      celebrateVisitedMarkers();
      return;
    }

    hasAnimatedRef.current = true;
    if (scoreAnimSigRef.current) {
      markScoreAnimatedSig(scoreAnimSigRef.current);
    }
    animationCompleteRef.current = false;

    const prevScore = Math.max(0, currentScore - addedScore);
    setPreviousScore(prevScore);
    setPlayerScore(currentScore);
    setAnimateScore(true);
    scoreCelebrationPendingRef.current = true;
    console.log("[ScoreAnim] starting animation", {
      previousScore: prevScore,
      currentScore,
      addedScore,
      visited: [...visitedEventKeySet],
    });
  }, [searchParams, initialPlayerScore, router, celebrateVisitedMarkers, visitedEventKeySet]);
  
  useEffect(() => {
    if (scoreAnimRef.current) {
      return;
    }

    const propScore = initialPlayerScore ?? 0;
    if (playerScore !== propScore) {
      console.log("[ScoreSync] syncing score from prop", {
        playerScore,
        propScore,
      });
      setPlayerScore(propScore);
    }
  }, [initialPlayerScore, playerScore]);

  const viewHeadingDegRef = useRef(0);
  const commitMapRotation = useCallback((nextRotationDeg: number, timestamp: number) => {
    mapRotationDegRef.current = nextRotationDeg;

    const lastCommitTime = lastMapRotationCommitTimeRef.current;
    if (
      lastCommitTime !== null &&
      timestamp - lastCommitTime < MAP_ROTATION_STATE_COMMIT_INTERVAL_MS
    ) {
      return;
    }

    lastMapRotationCommitTimeRef.current = timestamp;
    setMapRotationDeg((previous) => {
      if (Math.abs(previous - nextRotationDeg) < MAP_ROTATION_MIN_DEG_TO_COMMIT) {
        return previous;
      }

      return nextRotationDeg;
    });
  }, []);

  const isHeadingUpModeRef = useRef(false);

  useEffect(() => {
    viewHeadingDegRef.current = normalizeHeadingDeg(-mapRotationDeg);
  }, [mapRotationDeg]);

  useEffect(() => {
    if (!isHeadingUpMode) {
      return;
    }
    const handleOrientation = (event: DeviceOrientationEvent): void => {
      const withCompass = event as DeviceOrientationEvent & { webkitCompassHeading?: unknown };
      let heading: number | null = null;
      if (
        typeof withCompass.webkitCompassHeading === "number" &&
        Number.isFinite(withCompass.webkitCompassHeading)
      ) {
        heading = withCompass.webkitCompassHeading;
      } else if (
        event.absolute === true &&
        typeof event.alpha === "number" &&
        Number.isFinite(event.alpha)
      ) {
        heading = (360 - event.alpha) % 360;
      }
      if (heading === null) {
        return;
      }
      commitMapRotation(-normalizeHeadingDeg(heading), performance.now());
    };
    window.addEventListener("deviceorientation", handleOrientation);
    return () => window.removeEventListener("deviceorientation", handleOrientation);
  }, [isHeadingUpMode, commitMapRotation]);

  const enableHeadingUpMode = useCallback(() => {
    setIsHeadingUpMode(true);
    const orientationEvent = window.DeviceOrientationEvent as unknown as
      | { requestPermission?: () => Promise<string> }
      | undefined;
    if (typeof orientationEvent?.requestPermission === "function") {
      void orientationEvent.requestPermission().catch(() => undefined);
    }
  }, []);


  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<RotatableLeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const circleRef = useRef<Circle | null>(null);
  const walkableLayerRef = useRef<{ remove: () => void } | null>(null);
  // 기반 타일 레이어 (팬 방향 프리페치용).
  const baseTileLayersRef = useRef<Array<{ getTileUrl: (coords: { x: number; y: number; z: number }) => string }>>([]);
  const walkableTilesRef = useRef<GridFull[]>([]);
  const walkableGlobeIdsRef = useRef<string[]>([]);
  const cesiumWalkableEntitiesRef = useRef<CesiumTypes.Entity[]>([]);
  const pseudoMarkerRef = useRef<Marker | null>(null);
  const pseudoMarker2Ref = useRef<Marker | null>(null);
  const pseudoMarker3Ref = useRef<Marker | null>(null);
  const debugMarkerPositionsRef = useRef<[[number, number], [number, number], [number, number]] | null>(null);
  const pointsLayerRef = useRef<LayerGroup | null>(null);
  const nearbyPlayersLayerRef = useRef<LayerGroup | null>(null);
  const nearbyPlayerMarkerMapRef = useRef<Map<string, NearbyPlayerMarkerEntry>>(new Map());
  const bottomToolbarRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const leafletRotateLoadedRef = useRef(false);
  const adminSelectedRef = useRef<string | null>(null);
  const adminLeafletLayerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const adminCanvasRendererRef = useRef<import("leaflet").Canvas | null>(null);
  const adminCanvasRendererMapRef = useRef<unknown>(null);
  const playerMarkerDisposeRef = useRef<(() => void) | null>(null);
  const playerMarkerCharacterRef = useRef<PlayerCharacter | null>(null);
  const playerMarkerApplyFacingRef = useRef<((facingLeft: boolean) => void) | null>(null);
  const playerMarkerLastLonRef = useRef<number | null>(null);
  const playerMarkerFacingLeftRef = useRef(false);
  const poiIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const poiVisitedIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const damagedLordCastleIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const poiNeutralIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const poiLordIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const poiNobleIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const poiMarkerElementsRef = useRef<Map<string, Marker>>(new Map());
  // 패널 선택 개체 적색 테두리용: eventKey → 단일 마커.
  const poiMarkerByKeyRef = useRef<Map<string, Marker>>(new Map());
  const hostileSelectedElsRef = useRef<Set<Element>>(new Set());
  // 탭 즉시 테두리를 붙인다 (리액트 재렌더 왕복을 기다리지 않는다 — 해제·정합은 아래 effect가 담당).
  // 클릭 시점의 마커 객체가 재빌드로 교체됐으면 ID로 마커맵에서 다시 찾는다.
  const applyHostileInstant = useCallback(
    (marker: Marker | null | undefined, markerId?: string): void => {
      let el: Element | null | undefined = marker?.getElement() ?? undefined;
      if (!el && markerId) {
        el =
          unitMarkerMapRef.current.get(markerId)?.getElement() ??
          poiMarkerByKeyRef.current.get(markerId)?.getElement() ??
          undefined;
      }
      if (!el) {
        console.debug("[hostile] instant miss", markerId ?? "(no id)");
        return;
      }
      console.debug("[hostile] instant hit", markerId ?? "(no id)");
    hostileSelectedElsRef.current.forEach((prev) => {
      try {
        prev.classList.remove("hostile-selected");
      } catch {}
    });
    hostileSelectedElsRef.current.clear();
    el.classList.add("hostile-selected");
    hostileSelectedElsRef.current.add(el);
  }, []);
  const pseudoMarkerIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const pseudoMarkerVisitedIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const pseudoMarkerSoldierIconRef = useRef<Marker["options"]["icon"] | undefined>(undefined);
  const watchIdRef = useRef<number | null>(null);
  const locationRef = useRef<GeoResult | null>(null);
  const hasCachedLocationRef = useRef(false);
  const lastLocationWriteRef = useRef<GeoResult | null>(null);
  const globeContainerRef = useRef<HTMLDivElement | null>(null);
  const globeMapRef = useRef<GlobeMapLike | null>(null);
  const globeMarkersRef = useRef<GlobeMarkerLike[]>([]);
  const globeMarkerCtorRef = useRef<GlobeMarkerConstructor | null>(null);
  const globePlayerMarkerRef = useRef<GlobeMarkerLike | null>(null);
  useEffect(() => {
    try {
      document.querySelectorAll(".three-player-marker").forEach((el) => {
        el.classList.toggle("lord-selected", lordSelected);
      });
      (globePlayerMarkerRef.current as unknown as { getElement?: () => Element | null })?.getElement?.()?.classList?.toggle?.("lord-selected", lordSelected);
    } catch {}
  }, [lordSelected, activePlayerCharacter]);
  const globePlayerDisposeRef = useRef<(() => void) | null>(null);
  const globePlayerCharacterRef = useRef<PlayerCharacter | null>(null);
  const globePlayerApplyFacingRef = useRef<((facingLeft: boolean) => void) | null>(null);
  const globePlayerLastLonRef = useRef<number | null>(null);
  const globePlayerFacingLeftRef = useRef(false);
  const globePlayerLabelRef = useRef<HTMLDivElement | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const cesiumContainerRef = useRef<HTMLDivElement | null>(null);
  const cesiumViewerRef = useRef<CesiumTypes.Viewer | null>(null);
  const cesiumPoiEntitiesRef = useRef<CesiumTypes.Entity[]>([]);
  const cesiumEntityPointMapRef = useRef<Map<string, MapPoint>>(new Map());
  const cesiumEntityClusterMapRef = useRef<Map<string, MapPoint[]>>(new Map());
  const cesiumPlayerEntityRef = useRef<CesiumTypes.Entity | null>(null);
  const cesiumPlayerLastLonRef = useRef<number | null>(null);
  const cesiumPlayerFacingLeftRef = useRef(false);
  const cesiumFlippedImageCacheRef = useRef<Map<string, string>>(new Map());
  const cesiumHtmlOverlayRef = useRef<HTMLDivElement | null>(null);
  const cesiumAdminDataSourceRef = useRef<CesiumTypes.DataSource | null>(null);
  const cesiumHtmlMarkersRef = useRef<Array<{ element: HTMLDivElement; lon: number; lat: number; anchor: "bottom" | "center" }>>([]);
  const globePoiElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const cesiumPoiElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [isCesiumReady, setIsCesiumReady] = useState(false);

  const createThreePoiMarkerDataUrl = useCallback((scheme: "unvisited" | "visited" = "unvisited"): string | null => {
    if (typeof document === "undefined") {
      return null;
    }

    const colors = scheme === "visited"
      ? { base: "#00ff00", dark: "#00b300", light: "#a0ffa0" }
      : { base: "#ff0000", dark: "#b30000", light: "#ff8080" };

    const size = 56;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    ctx.clearRect(0, 0, size, size);

    const cx = 28;
    const topY = 12;
    const tipY = 52;
    const halfW = 15;

    const leftFacet = new Path2D();
    leftFacet.moveTo(cx - halfW, topY);
    leftFacet.lineTo(cx, topY);
    leftFacet.lineTo(cx, tipY);
    leftFacet.closePath();

    const rightFacet = new Path2D();
    rightFacet.moveTo(cx, topY);
    rightFacet.lineTo(cx + halfW, topY);
    rightFacet.lineTo(cx, tipY);
    rightFacet.closePath();

    const leftGradient = ctx.createLinearGradient(0, topY, 0, tipY);
    leftGradient.addColorStop(0, colors.light);
    leftGradient.addColorStop(1, colors.base);
    ctx.fillStyle = leftGradient;
    ctx.fill(leftFacet);

    const rightGradient = ctx.createLinearGradient(0, topY, 0, tipY);
    rightGradient.addColorStop(0, colors.base);
    rightGradient.addColorStop(1, colors.dark);
    ctx.fillStyle = rightGradient;
    ctx.fill(rightFacet);

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(22.5, 17.5, 2.8, 4.2, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const body = new Path2D();
    body.moveTo(cx - halfW, topY);
    body.lineTo(cx + halfW, topY);
    body.lineTo(cx, tipY);
    body.closePath();

    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#000000";
    ctx.stroke(body);

    return canvas.toDataURL("image/png");
  }, []);

  useEffect(() => {
    if (!territoryEnabled) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      setTerritoryTargetMarkerUrl(createThreePoiMarkerDataUrl("unvisited"));
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [territoryEnabled, createThreePoiMarkerDataUrl]);

  const createThreeCompassDataUrl = useCallback((): string | null => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return null;
    }

    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    let renderer: THREE.WebGLRenderer | null = null;
    let ringGeometry: THREE.TorusGeometry | null = null;
    let coreGeometry: THREE.CylinderGeometry | null = null;
    let needleGeometry: THREE.CylinderGeometry | null = null;
    let northGeometry: THREE.ConeGeometry | null = null;
    let southGeometry: THREE.ConeGeometry | null = null;

    const scene = new THREE.Scene();

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);

      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
      camera.position.set(0, 0, 4.6);

      const group = new THREE.Group();

      ringGeometry = new THREE.TorusGeometry(1.08, 0.13, 24, 64);
      const ringMaterial = new THREE.MeshStandardMaterial({
        color: 0x7dd3fc,
        emissive: 0x0f172a,
        emissiveIntensity: 0.4,
        roughness: 0.35,
        metalness: 0.55,
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      group.add(ring);

      coreGeometry = new THREE.CylinderGeometry(0.9, 0.9, 0.08, 40);
      const coreMaterial = new THREE.MeshStandardMaterial({
        color: 0x0b1220,
        roughness: 0.5,
        metalness: 0.2,
      });
      const core = new THREE.Mesh(coreGeometry, coreMaterial);
      core.position.z = -0.02;
      group.add(core);

      needleGeometry = new THREE.CylinderGeometry(0.08, 0.08, 1.55, 20);
      const needleMaterial = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.25,
        metalness: 0.65,
      });
      const needle = new THREE.Mesh(needleGeometry, needleMaterial);
      needle.position.z = 0.06;
      group.add(needle);

      northGeometry = new THREE.ConeGeometry(0.32, 0.7, 28);
      const northMaterial = new THREE.MeshStandardMaterial({
        color: 0xf43f5e,
        emissive: 0x7f1d1d,
        emissiveIntensity: 0.35,
        roughness: 0.22,
        metalness: 0.42,
      });
      const north = new THREE.Mesh(northGeometry, northMaterial);
      north.position.set(0, 0.77, 0.09);
      group.add(north);

      southGeometry = new THREE.ConeGeometry(0.24, 0.52, 28);
      const southMaterial = new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        emissive: 0x1e3a8a,
        emissiveIntensity: 0.28,
        roughness: 0.25,
        metalness: 0.4,
      });
      const south = new THREE.Mesh(southGeometry, southMaterial);
      south.rotation.z = Math.PI;
      south.position.set(0, -0.66, 0.09);
      group.add(south);

      scene.add(group);

      const ambient = new THREE.AmbientLight(0xffffff, 0.7);
      const key = new THREE.DirectionalLight(0xffffff, 0.95);
      key.position.set(2.4, 2.2, 2.6);
      const rim = new THREE.DirectionalLight(0x38bdf8, 0.55);
      rim.position.set(-2.1, 1.3, 1.8);
      scene.add(ambient, key, rim);

      renderer.render(scene, camera);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    } finally {
      ringGeometry?.dispose();
      coreGeometry?.dispose();
      needleGeometry?.dispose();
      northGeometry?.dispose();
      southGeometry?.dispose();
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.material) {
          return;
        }
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => {
            material.dispose();
          });
        } else {
          mesh.material.dispose();
        }
      });
      renderer?.dispose();
      scene.clear();
    }
  }, []);

  const createThreeEdgeIndicatorDataUrl = useCallback((): string | null => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return null;
    }

    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const traceArrowPath = (expand: number) => {
      const tipY = -34 - expand;
      const headBaseY = -8 + expand * 0.2;
      const shaftBottomY = 18 + expand * 0.4;
      const headHalf = 36 + expand * 2.1;
      const shaftHalf = 8.8 + expand * 0.62;

      ctx.beginPath();
      ctx.moveTo(0, tipY);
      ctx.lineTo(headHalf, headBaseY);
      ctx.lineTo(shaftHalf, headBaseY);
      ctx.lineTo(shaftHalf, shaftBottomY);
      ctx.lineTo(-shaftHalf, shaftBottomY);
      ctx.lineTo(-shaftHalf, headBaseY);
      ctx.lineTo(-headHalf, headBaseY);
      ctx.closePath();
    };

    const traceTetraPath = (expand: number) => {
      const topY = 14 - expand * 0.3;
      const sideY = 24 + expand * 0.2;
      const bottomY = 34 + expand;
      const sideX = 13 + expand * 0.82;

      ctx.beginPath();
      ctx.moveTo(0, topY);
      ctx.lineTo(sideX, sideY);
      ctx.lineTo(0, bottomY);
      ctx.lineTo(-sideX, sideY);
      ctx.closePath();
    };

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);

    traceArrowPath(2.8);
    ctx.fillStyle = "rgba(15, 23, 42, 0.72)";
    ctx.fill();

    traceArrowPath(0);
    const arrowGradient = ctx.createLinearGradient(0, -34, 0, 18);
    arrowGradient.addColorStop(0, "#ffffff");
    arrowGradient.addColorStop(1, "#e2e8f0");
    ctx.fillStyle = arrowGradient;
    ctx.fill();

    traceTetraPath(2.1);
    ctx.fillStyle = "rgba(15, 23, 42, 0.66)";
    ctx.fill();

    traceTetraPath(0);
    const tetraGradient = ctx.createLinearGradient(0, 14, 0, 34);
    tetraGradient.addColorStop(0, "#f8fafc");
    tetraGradient.addColorStop(1, "#cbd5e1");
    ctx.fillStyle = tetraGradient;
    ctx.fill();

    ctx.restore();
    return canvas.toDataURL("image/png");
  }, []);

  const createWalkingPlayerMarkerElement = useCallback((): PlayerMarkerVisual => {
    const size = 66;
    const root = document.createElement("div");
    root.style.width = `${size}px`;
    root.style.height = `${size}px`;
    root.style.pointerEvents = "auto";
    root.style.cursor = "pointer";

    const image = document.createElement("img");
    image.style.width = "100%";
    image.style.height = "100%";
    image.style.objectFit = "contain";
    image.style.display = "block";
    image.style.filter = "drop-shadow(0 6px 10px rgba(2, 6, 23, 0.35))";
    image.style.transformOrigin = "center";
    image.style.transform = "scaleX(1)";
    image.alt = "오크 캐릭터";
    root.appendChild(image);

    if (walkingFrameUrls.length === 0) {
      return {
        element: root,
        dispose: () => {},
        iconSize: [66, 66],
        iconAnchor: [33, 65],
        applyFacingDirection: (facingLeft: boolean) => {
          image.style.transform = facingLeft ? "scaleX(-1)" : "scaleX(1)";
        },
      };
    }

    let frameIndex = 0;
    image.src = walkingFrameUrls[frameIndex];

    const timerId = window.setInterval(() => {
      frameIndex = (frameIndex + 1) % walkingFrameUrls.length;
      image.src = walkingFrameUrls[frameIndex];
    }, 90);

    return {
      element: root,
      dispose: () => {
        window.clearInterval(timerId);
      },
      iconSize: [66, 66],
      iconAnchor: [33, 65],
      applyFacingDirection: (facingLeft: boolean) => {
        image.style.transform = facingLeft ? "scaleX(-1)" : "scaleX(1)";
      },
    };
  }, [walkingFrameUrls]);

  const createFallenAngelPlayerMarkerElement = useCallback((): PlayerMarkerVisual => {
    const size = 66;
    const root = document.createElement("div");
    root.style.width = `${size}px`;
    root.style.height = `${size}px`;
    root.style.pointerEvents = "auto";
    root.style.cursor = "pointer";

    const image = document.createElement("img");
    image.style.width = "100%";
    image.style.height = "100%";
    image.style.objectFit = "contain";
    image.style.display = "block";
    image.style.filter = "drop-shadow(0 6px 10px rgba(2, 6, 23, 0.35))";
    image.style.transformOrigin = "center";
    image.style.transform = "scaleX(1)";
    image.alt = "타락천사 캐릭터";
    root.appendChild(image);

    if (fallenAngelFrameUrls.length === 0) {
      return {
        element: root,
        dispose: () => {},
        iconSize: [66, 66],
        iconAnchor: [33, 65],
        applyFacingDirection: (facingLeft: boolean) => {
          image.style.transform = facingLeft ? "scaleX(-1)" : "scaleX(1)";
        },
      };
    }

    let frameIndex = 0;
    image.src = fallenAngelFrameUrls[frameIndex];

    const timerId = window.setInterval(() => {
      frameIndex = (frameIndex + 1) % fallenAngelFrameUrls.length;
      image.src = fallenAngelFrameUrls[frameIndex];
    }, 90);

    return {
      element: root,
      dispose: () => {
        window.clearInterval(timerId);
      },
      iconSize: [66, 66],
      iconAnchor: [33, 65],
      applyFacingDirection: (facingLeft: boolean) => {
        image.style.transform = facingLeft ? "scaleX(-1)" : "scaleX(1)";
      },
    };
  }, [fallenAngelFrameUrls]);

  const createPlayerMarkerElement = useCallback(
    (character: PlayerCharacter): PlayerMarkerVisual => {
      if (character === "walking") {
        return createWalkingPlayerMarkerElement();
      }

      if (character === "fallenAngel") {
        return createFallenAngelPlayerMarkerElement();
      }

      return createFallenAngelPlayerMarkerElement();
    },
    [createFallenAngelPlayerMarkerElement, createWalkingPlayerMarkerElement]
  );

  const showMarkerPanel = useCallback((panel: MarkerPanel) => {
    setShowPanelEventKey(false);
    setMarkerPanel(panel);
  }, []);

  const closeMarkerPanel = useCallback(() => {
    const panel = markerPanelRef.current;
    // 자동 인식으로 뜬 무법자 패널을 닫으면 범위 밖으로 나갈 때까지 재오픈하지 않는다.
    if (panel?.isProximity && panel.wildId !== undefined) {
      dismissedWildRef.current.add(panel.wildId);
    }
    setShowPanelEventKey(false);
    setMarkerPanel(null);
    setWildRoutePath(null);
    setWildRouteWildId(null);
  }, []);

  // 무법자 다이얼로그가 열린 동안 해당 개체를 서버에서 멈춘다 (닫으면 재개).
  // 클라이언트 종료 등으로 재개 신호가 못 와도 TTL 만료 후 자동 재개된다.
  useEffect(() => {
    const wildId = markerPanel?.wildId;
    if (!territoryEnabled || wildId === undefined || !Number.isFinite(wildId)) {
      return;
    }
    let stopped = false;
    const hold = (on: boolean): void => {
      void fetch("/api/neutral-units/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: wildId, hold: on }),
      }).catch(() => undefined);
    };
    hold(true);
    const timerId = window.setInterval(() => {
      if (!stopped) {
        hold(true);
      }
    }, 60_000);
    return () => {
      stopped = true;
      window.clearInterval(timerId);
      hold(false);
    };
  }, [territoryEnabled, markerPanel?.wildId]);

  // 패널이 열린 비소유 개체(무법자·중립성·적성) 마커에 적색 테두리를 표시한다.
  // 소유 개체(아군 부대·아성)는 기존 선택 표시를 그대로 둔다.
  useEffect(() => {
    const prev = hostileSelectedElsRef.current;
    prev.forEach((el) => {
      try {
        el.classList.remove("hostile-selected");
      } catch {}
    });
    prev.clear();
    if (!territoryEnabled) {
      return;
    }
    const targets: Marker[] = [];
    const wildId = markerPanel?.wildId;
    if (wildId !== undefined) {
      const m = unitMarkerMapRef.current.get(`neutral-${wildId}`);
      if (m) {
        targets.push(m);
      }
    }
    const panelKey = markerPanel?.eventKey;
    if (panelKey && isNeutralEventKey(panelKey)) {
      const m = poiMarkerByKeyRef.current.get(panelKey);
      if (m) {
        targets.push(m);
      }
    }
    if (territoryCastleKey && !ownedCastleKeys.includes(territoryCastleKey)) {
      const m = poiMarkerByKeyRef.current.get(territoryCastleKey);
      if (m) {
        targets.push(m);
      }
    }
    for (const m of targets) {
      const el = m.getElement() as HTMLElement | null;
      if (el) {
        el.classList.add("hostile-selected");
        prev.add(el);
      }
    }
  }, [territoryEnabled, markerPanel, territoryCastleKey, ownedCastleKeys, unitMarks]);


  const playerLabel = useMemo(() => {
    const trimmed = playerNickname?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }

    return "PLAYER";
  }, [playerNickname]);

  const applyZoomLevel = useCallback(
    (targetZoom: number) => {
      const range = ZOOM_RANGE_BY_STYLE[mapStyle];
      const clampedZoom = Math.min(range.max, Math.max(range.min, Math.round(targetZoom)));
      if (mapStyle === "satellite") {
        const map = mapInstanceRef.current;
        if (!map) {
          return;
        }
        map.setZoom(clampedZoom);
        setZoomLevel(clampedZoom);
        return;
      }
      if (mapStyle === "globe") {
        const map = globeMapRef.current;
        if (!map) {
          return;
        }
        try {
          const anyMap = map as unknown as {
            setZoom?: (zoom: number) => void;
            easeTo?: (options: { zoom?: number }) => void;
          };
          if (typeof anyMap.setZoom === "function") {
            anyMap.setZoom(clampedZoom);
          } else if (typeof anyMap.easeTo === "function") {
            anyMap.easeTo({ zoom: clampedZoom });
          }
        } catch {}
        setZoomLevel(clampedZoom);
        return;
      }
      if (mapStyle === "cesium") {
        const viewer = cesiumViewerRef.current;
        if (!viewer || viewer.isDestroyed()) {
          return;
        }
        try {
          const center = playerLocation;
          if (!center) {
            return;
          }
          const height = 1000 * Math.pow(2, 19 - clampedZoom);
          const CesiumWindow = window as unknown as { Cesium?: typeof import("cesium") };
          const Cesium = CesiumWindow.Cesium;
          if (!Cesium) {
            return;
          }
          const heading = viewer.camera.heading;
          const pitch = viewer.camera.pitch;
          const roll = viewer.camera.roll;
          viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat, height),
            orientation: { heading, pitch, roll },
          });
          setZoomLevel(clampedZoom);
        } catch {}
      }
    },
    [mapStyle, location, playerLocation]
  );

  useEffect(() => {
    const isReady =
      (mapStyle === "satellite" && isMapReady) ||
      (mapStyle === "globe" && isGlobeReady) ||
      (mapStyle === "cesium" && isCesiumReady);
    if (!isReady) {
      return;
    }
    let didAttempt = false;
    try {
      const perStyleKey = `map-zoom:${locationCacheKey}:${mapStyle}`;
      const saved = sessionStorage.getItem(perStyleKey) ?? sessionStorage.getItem(`map-zoom:${locationCacheKey}`);
      didAttempt = true;
      if (!saved) {
        return;
      }
      const parsed = parseInt(saved, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }
      const range = ZOOM_RANGE_BY_STYLE[mapStyle];
      const clamped = Math.min(range.max, Math.max(range.min, parsed));
      if (clamped === zoomLevel) {
        return;
      }
      const t = window.setTimeout(() => applyZoomLevel(clamped), 120);
      return () => window.clearTimeout(t);
    } catch {}
    finally {
      if (didAttempt) {
        hasRestoredZoomRef.current = true;
      }
    }
  }, [mapStyle, isMapReady, isGlobeReady, isCesiumReady, locationCacheKey, zoomLevel, applyZoomLevel]);






  const handleZoomIn = useCallback(() => {
    if (mapStyle === "satellite") {
      const map = mapInstanceRef.current;
      if (!map) {
        return;
      }
      applyZoomLevel(map.getZoom() + 1);
      return;
    }
    applyZoomLevel(zoomLevel + 1);
  }, [applyZoomLevel, mapStyle, zoomLevel]);

  const handleZoomOut = useCallback(() => {
    if (mapStyle === "satellite") {
      const map = mapInstanceRef.current;
      if (!map) {
        return;
      }
      applyZoomLevel(map.getZoom() - 1);
      return;
    }
    applyZoomLevel(zoomLevel - 1);
  }, [applyZoomLevel, mapStyle, zoomLevel]);

  const handleZoomSliderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      applyZoomLevel(Number(event.target.value));
    },
    [applyZoomLevel]
  );

  const requestLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus(hasCachedLocationRef.current ? "success" : "error");
      setPermissionState("unsupported");
      setErrorMessage("이 브라우저는 위치 서비스를 지원하지 않습니다.");
      return;
    }

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    setStatus(hasCachedLocationRef.current ? "success" : "loading");
    setErrorMessage(null);
    setPermissionState(null);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const nextLocation: GeoResult = {
          lat: latitude,
          lon: longitude,
          accuracy: accuracy === undefined ? undefined : Number(accuracy),
          timestamp: pos.timestamp,
        };

        locationRef.current = nextLocation;
        setLocation(nextLocation);
        try {
          window.sessionStorage.setItem(locationStorageKey, JSON.stringify(nextLocation));
          hasCachedLocationRef.current = true;
        } catch (error) {
          if (!(error instanceof DOMException)) {
            throw error;
          }
        }
        setPermissionState("granted");
        setStatus("success");
        if (isHeadingUpModeRef.current) {
          const course = pos.coords.heading;
          const speed = pos.coords.speed;
          if (
            typeof course === "number" &&
            Number.isFinite(course) &&
            course >= 0 &&
            typeof speed === "number" &&
            speed > 0.5
          ) {
            commitMapRotation(-normalizeHeadingDeg(course), performance.now());
          }
        }
      },
      (err: GeolocationPositionError) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPermissionState("denied");
          setErrorMessage(
            "위치 권한이 거부되었습니다. 아래 버튼으로 다시 요청하거나 브라우저 설정에서 위치를 허용해주세요."
          );
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setErrorMessage("현재 위치를 확인할 수 없습니다. GPS 신호를 확인한 뒤 다시 시도해주세요.");
        } else if (err.code === err.TIMEOUT) {
          setErrorMessage("위치 확인 시간이 초과되었습니다. 다시 시도해주세요.");
        } else {
          setErrorMessage(err.message || "위치를 불러오지 못했습니다. 다시 시도해주세요.");
        }
        if (err.code === err.PERMISSION_DENIED || !hasCachedLocationRef.current) {
          setStatus("error");
        }

        const permissions = (navigator as Navigator & { permissions?: Permissions }).permissions;
        if (permissions?.query) {
          void permissions
            .query({ name: "geolocation" as PermissionName })
            .then((result: PermissionStatus) => {
              setPermissionState(result.state as "granted" | "prompt" | "denied");
            })
            .catch(() => undefined);
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 1000,
      }
    );
  }, [locationStorageKey, commitMapRotation]);

  const ensureNearbyPlayerLayer = useCallback(() => {
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L) {
      return null;
    }

    if (!nearbyPlayersLayerRef.current) {
      nearbyPlayersLayerRef.current = L.layerGroup().addTo(map);
    }

    return nearbyPlayersLayerRef.current;
  }, []);

  const parseNearbyPlayerCharacter = useCallback((value: unknown): PlayerCharacter => {
    if (value === "walking" || value === "fallenAngel") {
      return value;
    }

    return "fallenAngel";
  }, []);

  const createNearbyPlayerMarkerVisual = useCallback((character: PlayerCharacter) => {
    const L = leafletRef.current;
    if (!L) {
      return null;
    }

    const markerVisual = createPlayerMarkerElement(character);
    const icon = L.divIcon({
      className: "map-nearby-player-marker",
      html: `<div class="map-rotation-upright">${markerVisual.element.outerHTML}</div>`,
      iconSize: markerVisual.iconSize,
      iconAnchor: markerVisual.iconAnchor,
    });

    return {
      icon,
      dispose: markerVisual.dispose,
    };
  }, [createPlayerMarkerElement]);

  useLayoutEffect(() => {
    // 영토전 모드에서는 GPS를 아예 사용하지 않는다 (watch 미시작·캐시 복원 생략).
    if (territoryEnabled) {
      if (watchIdRef.current !== null) {
        try {
          navigator.geolocation.clearWatch(watchIdRef.current);
        } catch {}
        watchIdRef.current = null;
      }
      return;
    }
    let cachedLocation: GeoResult | null = null;
    try {
      cachedLocation = parseCachedLocation(window.sessionStorage.getItem(locationStorageKey));
    } catch (error) {
      if (!(error instanceof DOMException)) {
        throw error;
      }
    }

    if (cachedLocation) {
      locationRef.current = cachedLocation;
      hasCachedLocationRef.current = true;
      setLocation(cachedLocation);
      setStatus("success");
    }

    // 영토전 GPS-free 모드에서는 실시간 GPS 감시를 시작하지 않는다
    // (브라우저 권한 요청 방지. 시작 위치·조이스틱 기준으로 동작).
    if (territoryEnabled) {
      return;
    }

    const id = window.setTimeout(() => {
      requestLocation();
    }, 0);
    return () => {
      window.clearTimeout(id);
    };
  }, [locationStorageKey, requestLocation, territoryEnabled]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      if (playerMarkerDisposeRef.current) {
        playerMarkerDisposeRef.current();
        playerMarkerDisposeRef.current = null;
      }
      playerMarkerCharacterRef.current = null;
      playerMarkerApplyFacingRef.current = null;
      playerMarkerLastLonRef.current = null;
      playerMarkerFacingLeftRef.current = false;
      if (pseudoMarkerRef.current) {
        pseudoMarkerRef.current.remove();
        pseudoMarkerRef.current = null;
      }
      if (pseudoMarker2Ref.current) {
         pseudoMarker2Ref.current.remove();
         pseudoMarker2Ref.current = null;
       }
       if (pseudoMarker3Ref.current) {
         pseudoMarker3Ref.current.remove();
         pseudoMarker3Ref.current = null;
       }
      if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }
      if (nearbyPlayersLayerRef.current) {
        nearbyPlayersLayerRef.current.remove();
        nearbyPlayersLayerRef.current = null;
      }
      nearbyPlayerMarkerMapRef.current.forEach((entry) => {
        entry.marker.remove();
        entry.dispose();
      });
      nearbyPlayerMarkerMapRef.current.clear();
      lastLocationWriteRef.current = null;
      pointsLayerRef.current = null;
      markerRef.current = null;
      pseudoMarkerIconRef.current = undefined;
      pseudoMarkerVisitedIconRef.current = undefined;
      pseudoMarkerSoldierIconRef.current = undefined;
      setIsMapReady(false);
    };
  }, []);

  useEffect(() => {
    if (mapStyle !== "satellite") {
      return;
    }
    const container = mapContainerRef.current;
    // 영토전 GPS-free: 시작 위치(플레이어 위치) 기준으로 초기화한다.
    const baseLoc = playerLocation ?? location;
    if (!baseLoc || !container) {
      return;
    }

    let isCancelled = false;

    void (async () => {
      if (!leafletRef.current) {
        leafletRef.current = await import("leaflet");
      }

      if (!leafletRotateLoadedRef.current) {
        const windowWithLeaflet = window as Window & { L?: unknown };
        windowWithLeaflet.L = leafletRef.current;
        await import("leaflet-rotate");
        leafletRotateLoadedRef.current = true;
      }

      const L = leafletRef.current;
      if (isCancelled) {
        return;
      }

      if (!mapInstanceRef.current) {
        const mapOptions: RotatableMapOptions = {
          zoomControl: false,
          attributionControl: false,
          minZoom: MIN_ZOOM_LEVEL,
          maxZoom: MAX_ZOOM_LEVEL,
          rotate: true,
          bearing: 0,
        };

        mapInstanceRef.current = L.map(container, mapOptions) as RotatableLeafletMap;
      }

      const map = mapInstanceRef.current;
      if (!map) {
        return;
      }

      map.invalidateSize();

      if (!isMapReady) {
        const satelliteTileLayer = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: MAX_ZOOM_LEVEL,
            // 버퍼는 2링으로 줄인다 (4링은 타일 수백 장을 한 번에 물어
            // 디코드·대역폭을 막고 회색 셀을 늘렸다).
            keepBuffer: 2,
          }
        );

        const labelTileLayer = L.tileLayer(
          "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: MAX_ZOOM_LEVEL,
            opacity: 1,
            keepBuffer: 2,
          }
        );

        const handleTileError = () => {
          setTileError("지도 타일을 불러오지 못했습니다.");
        };

        satelliteTileLayer.on("tileerror", handleTileError);
        labelTileLayer.on("tileerror", handleTileError);

        satelliteTileLayer.addTo(map);
        labelTileLayer.addTo(map);
        baseTileLayersRef.current = [
          satelliteTileLayer as unknown as { getTileUrl: (coords: { x: number; y: number; z: number }) => string },
          labelTileLayer as unknown as { getTileUrl: (coords: { x: number; y: number; z: number }) => string },
        ];
      }

      if (!isMapReady) {
        // console.log("[CurrentLocationMap] map initialized");
        setIsMapReady(true);
      }

      const nextZoomLevel = (() => {
        const saved = getSavedZoomForStyle(locationCacheKey, "satellite");
        if (saved !== null) return saved;
        return markerRef.current ? map.getZoom() : DEFAULT_ZOOM_LEVEL;
      })();
      
      let centerLat = baseLoc.lat;
      let centerLon = baseLoc.lon;
      
      const previousFollow = satelliteFollowPositionRef.current;
      const isNewMap = previousFollow?.map !== map;
      const playerMoved = previousFollow?.lat !== centerLat || previousFollow?.lon !== centerLon;
      // 영주 이동 중에는 자동 추적을 멈춘다 (드래그와 경합 방지).
      // 진행률은 부대 메뉴에서 확인하고, 지도는 사용자가 자유롭게 본다.
      const lordMovingNow = playerMoveTarget !== null && Date.now() < playerMoveTarget.endsAt;
      // POI 목록 변경은 현재 뷰를 유지하고, 플레이어 이동은 지역 선택 여부와 무관하게 따라간다.
      if ((isNewMap || playerMoved) && !lordMovingNow) {
        map.setView([centerLat, centerLon], nextZoomLevel);
        setZoomLevel(nextZoomLevel);
      }
      satelliteFollowPositionRef.current = { map, lat: centerLat, lon: centerLon };

      // 정밀도 원은 GPS fix가 있을 때만 (영토전 GPS-free에서는 생략).
      if (!territoryEnabled && location && location.accuracy && location.accuracy > 0) {
        if (!circleRef.current) {
          circleRef.current = L.circle([baseLoc.lat, baseLoc.lon], {
            radius: location.accuracy,
            color: "#38bdf8",
            fillColor: "#38bdf8",
            fillOpacity: 0.1,
            weight: 2,
            stroke: true,
          }).addTo(map);
        } else {
          circleRef.current.setLatLng([baseLoc.lat, baseLoc.lon]);
          circleRef.current.setRadius(location.accuracy);
        }
      } else if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }

      let markerLat = baseLoc.lat;
      let markerLon = baseLoc.lon;

      const syncPlayerMarkerFacingDirection = (nextLon: number) => {
        const previousLon = playerMarkerLastLonRef.current;

        if (previousLon !== null) {
          const deltaLon = nextLon - previousLon;
          if (Math.abs(deltaLon) > SPRITE_DIRECTION_LON_THRESHOLD) {
            playerMarkerFacingLeftRef.current = deltaLon < 0;
          }
        }

        playerMarkerLastLonRef.current = nextLon;
        playerMarkerApplyFacingRef.current?.(playerMarkerFacingLeftRef.current);
      };

      if (!markerRef.current && activePlayerCharacter !== null) {
        const playerMarker = createPlayerMarkerElement(activePlayerCharacter);
        playerMarkerDisposeRef.current = playerMarker.dispose;
        playerMarkerCharacterRef.current = activePlayerCharacter;
        playerMarkerApplyFacingRef.current = playerMarker.applyFacingDirection;

        const icon = L.divIcon({
          className: "three-player-marker",
          html: playerMarker.element,
          iconSize: playerMarker.iconSize,
          iconAnchor: playerMarker.iconAnchor,
        });

        markerRef.current = L.marker([markerLat, markerLon], {
          icon,
          interactive: true,
        }).addTo(map);
        markerRef.current.on("click", () => handleUnitMarkerClick(LORD_UNIT_ID));

        syncPlayerMarkerFacingDirection(markerLon);
      } else if (markerRef.current) {
        if (activePlayerCharacter !== null && playerMarkerCharacterRef.current !== activePlayerCharacter) {
          playerMarkerDisposeRef.current?.();

          const playerMarker = createPlayerMarkerElement(activePlayerCharacter);
          playerMarkerDisposeRef.current = playerMarker.dispose;
          playerMarkerCharacterRef.current = activePlayerCharacter;
          playerMarkerApplyFacingRef.current = playerMarker.applyFacingDirection;

          const icon = L.divIcon({
            className: "three-player-marker",
            html: playerMarker.element,
            iconSize: playerMarker.iconSize,
            iconAnchor: playerMarker.iconAnchor,
          });

          markerRef.current.setIcon(icon);
        }

        syncPlayerMarkerFacingDirection(markerLon);
        markerRef.current.setLatLng([markerLat, markerLon]);
      }

      if (markerRef.current) {
        if (!markerRef.current.getTooltip()) {
          markerRef.current.bindTooltip(playerLabel, {
            permanent: true,
            direction: "top",
            offset: [0, -45],
            className: "map-player-label",
          });
        } else {
          markerRef.current.setTooltipContent(playerLabel);
        }

        markerRef.current.off("click");
      }

    if (DEBUG_PSEUDO_MARKER_ENABLED && !territoryEnabled) {
        const debugBase = playerLocation ?? location;
        if (!debugBase) {
          return;
        }
        let playerLat = debugBase.lat;
        let playerLon = debugBase.lon;

        if (!debugMarkerPositionsRef.current) {
          const debugMarkerTargets: [[number, number], [number, number], [number, number]] = [
            [debugBase.lat, debugBase.lon + metersToLongitudeDelta(debugBase.lat, DEBUG_PSEUDO_MARKER_OFFSET_METERS)],
            [debugBase.lat - metersToLatitudeDelta(DEBUG_PSEUDO_MARKER_OFFSET_METERS), debugBase.lon],
            [debugBase.lat, debugBase.lon - metersToLongitudeDelta(debugBase.lat, DEBUG_PSEUDO_MARKER_OFFSET_METERS)],
          ];
          const positions = territoryEnabled
            ? await Promise.all(debugMarkerTargets.map(async ([lat, lon]) => {
                const snapped = await snapToNearestWalkableLocation(lat, lon);
                return snapped ? [snapped.lat, snapped.lon] as [number, number] : [lat, lon] as [number, number];
              })) as [[number, number], [number, number], [number, number]]
            : debugMarkerTargets;
          if (isCancelled) return;
          debugMarkerPositionsRef.current = positions;
        }
        const [pseudoPosition, pseudo2Position, pseudo3Position] = debugMarkerPositionsRef.current;

        // console.log("[CurrentLocationMap] pseudo marker check", {
        //   hasPoiIconRef: Boolean(poiIconRef.current),
        //   hasPseudoIconRef: Boolean(pseudoMarkerIconRef.current),
        //   locationLat: location.lat,
        //   locationLon: location.lon,
        // });

        if (!pseudoMarkerIconRef.current) {
          // console.log("[CurrentLocationMap] creating pseudo marker icon on-demand");
          const pseudoIconDataUrl = createThreePoiMarkerDataUrl();
          if (pseudoIconDataUrl && leafletRef.current) {
            pseudoMarkerIconRef.current = leafletRef.current.divIcon({
              className: "three-poi-marker-shell",
              html: `<div class="map-rotation-upright"><div class="three-poi-marker-spin"><img src="${pseudoIconDataUrl}" alt="" class="three-poi-marker" /></div></div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 29],
            });
            // console.log("[CurrentLocationMap] pseudo marker icon created");
          }
        }

        if (!pseudoMarkerVisitedIconRef.current) {
          const pseudoVisitedIconDataUrl = createThreePoiMarkerDataUrl("visited");
          const pseudoUnvisitedIconDataUrl = createThreePoiMarkerDataUrl("unvisited");
          if (pseudoVisitedIconDataUrl && leafletRef.current) {
            pseudoMarkerVisitedIconRef.current = leafletRef.current.divIcon({
              className: "three-poi-marker-visited-shell",
              html: `<div class="map-rotation-upright"><div class="three-poi-marker-visited-wrap"><span class="three-poi-marker-visited-glow" aria-hidden="true"></span><span class="three-poi-marker-visited-ripple" aria-hidden="true"></span>${pseudoUnvisitedIconDataUrl ? `<img src="${pseudoUnvisitedIconDataUrl}" alt="" class="three-poi-marker-visited-red" />` : ""}<img src="${pseudoVisitedIconDataUrl}" alt="" class="three-poi-marker-visited" /></div></div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 29],
            });
          }
        }

        if (territoryEnabled && !pseudoMarkerSoldierIconRef.current && leafletRef.current) {
          pseudoMarkerSoldierIconRef.current = leafletRef.current.divIcon({
              className: "three-poi-marker-shell",
              html: `<div class="map-rotation-upright">${territorySoldierAnimationMarkup()}</div>`,
              iconSize: [52, 52],
              iconAnchor: [26, 51],
          });
        }
        const pseudoTerritorySoldierIcon = territoryEnabled
          ? pseudoMarkerSoldierIconRef.current
          : null;

        const resolvePseudoMarkerIcon = (eventKey: string) => {
          const normalIcon = pseudoMarkerIconRef.current;
          const visitedIcon = pseudoMarkerVisitedIconRef.current;
          if (isVisitedEventKey(eventKey) && visitedIcon) {
            return visitedIcon;
          }
          if (pseudoTerritorySoldierIcon) {
            return pseudoTerritorySoldierIcon;
          }
          return normalIcon;
        };
        
        if (!pseudoMarkerIconRef.current) {
          // console.warn("[CurrentLocationMap] skip pseudo marker: icon not ready");
        } else {
          if (!pseudoMarkerRef.current) {
            pseudoMarkerRef.current = L.marker(pseudoPosition, {
              icon: pseudoMarkerIconRef.current,
            }).addTo(map);
          }

          const pseudoMarkerIcon = resolvePseudoMarkerIcon(DEBUG_PSEUDO_MARKER_EVENT_KEY);
          if (pseudoMarkerIcon && pseudoMarkerRef.current?.getIcon() !== pseudoMarkerIcon) {
            pseudoMarkerRef.current.setIcon(pseudoMarkerIcon);
          }

          const pseudoAnchor = pseudoMarkerRef.current.getLatLng();
          const pseudo1Distance = calculateDistance(playerLat, playerLon, pseudoAnchor.lat, pseudoAnchor.lng);
          
          if (!pseudoMarkerRef.current.getTooltip()) {
            pseudoMarkerRef.current.bindTooltip(`디버그 마커 (${pseudo1Distance.toFixed(1)}m)`, {
              permanent: true,
              direction: "top",
              offset: [0, POI_LABEL_OFFSET_Y],
              className: "map-poi-label",
            });
          } else {
            pseudoMarkerRef.current.setTooltipContent(`디버그 마커 (${pseudo1Distance.toFixed(1)}m)`);
          }

        pseudoMarkerRef.current.off("click");
        pseudoMarkerRef.current.on("click", () => {
          showMarkerPanel({
            title: "디버그 이벤트 마커",
            lines: [
              `이벤트 종류: ${getEventTypeLabel(debugEventTypes?.[DEBUG_PSEUDO_MARKER_EVENT_KEY] ?? undefined)}`,
            ],
            eventKey: DEBUG_PSEUDO_MARKER_EVENT_KEY,
          });
        });
        }

        if (!pseudoMarker3Ref.current) {
          pseudoMarker3Ref.current = L.marker(pseudo3Position, {
            icon: pseudoMarkerIconRef.current,
          }).addTo(map);
        }

        const pseudoMarker3Icon = resolvePseudoMarkerIcon(DEBUG_PSEUDO_MARKER3_EVENT_KEY);
        if (pseudoMarker3Icon && pseudoMarker3Ref.current?.getIcon() !== pseudoMarker3Icon) {
          pseudoMarker3Ref.current.setIcon(pseudoMarker3Icon);
        }

        if (!pseudoMarker2Ref.current) {
          pseudoMarker2Ref.current = L.marker(pseudo2Position, {
            icon: pseudoMarkerIconRef.current,
          }).addTo(map);
        }

        const pseudoMarker2Icon = resolvePseudoMarkerIcon(DEBUG_PSEUDO_MARKER2_EVENT_KEY);
        if (pseudoMarker2Icon && pseudoMarker2Ref.current?.getIcon() !== pseudoMarker2Icon) {
          pseudoMarker2Ref.current.setIcon(pseudoMarker2Icon);
        }

        const pseudo2Anchor = pseudoMarker2Ref.current.getLatLng();
        const pseudo2Distance = calculateDistance(playerLat, playerLon, pseudo2Anchor.lat, pseudo2Anchor.lng);

        if (!pseudoMarker2Ref.current.getTooltip()) {
          pseudoMarker2Ref.current.bindTooltip(`디버그 마커2 (${pseudo2Distance.toFixed(1)}m)`, {
            permanent: true,
            direction: "top",
            offset: [0, POI_LABEL_OFFSET_Y],
            className: "map-poi-label",
          });
        } else {
          pseudoMarker2Ref.current.setTooltipContent(`디버그 마커2 (${pseudo2Distance.toFixed(1)}m)`);
        }

        pseudoMarker2Ref.current.off("click");
        pseudoMarker2Ref.current.on("click", () => {
          showMarkerPanel({
            title: "디버그 이벤트 마커2",
            lines: [
              `이벤트 종류: ${getEventTypeLabel(debugEventTypes?.[DEBUG_PSEUDO_MARKER2_EVENT_KEY] ?? undefined)}`,
            ],
            eventKey: DEBUG_PSEUDO_MARKER2_EVENT_KEY,
          });
        });

        const pseudo3Anchor = pseudoMarker3Ref.current.getLatLng();
        const pseudo3Distance = calculateDistance(playerLat, playerLon, pseudo3Anchor.lat, pseudo3Anchor.lng);

        if (!pseudoMarker3Ref.current.getTooltip()) {
          pseudoMarker3Ref.current.bindTooltip(`디버그 마커3 (${pseudo3Distance.toFixed(1)}m)`, {
            permanent: true,
            direction: "top",
            offset: [0, POI_LABEL_OFFSET_Y],
            className: "map-poi-label",
          });
        } else {
          pseudoMarker3Ref.current.setTooltipContent(`디버그 마커3 (${pseudo3Distance.toFixed(1)}m)`);
        }

        pseudoMarker3Ref.current.off("click");
        pseudoMarker3Ref.current.on("click", () => {
          showMarkerPanel({
            title: "디버그 이벤트 마커3",
            lines: [
              `이벤트 종류: ${getEventTypeLabel(debugEventTypes?.[DEBUG_PSEUDO_MARKER3_EVENT_KEY] ?? undefined)}`,
            ],
            eventKey: DEBUG_PSEUDO_MARKER3_EVENT_KEY,
          });
        });

        registerTerritorySoldierAnimation(pseudoMarkerRef.current?.getElement() ?? null);
        registerTerritorySoldierAnimation(pseudoMarker2Ref.current?.getElement() ?? null);
        registerTerritorySoldierAnimation(pseudoMarker3Ref.current?.getElement() ?? null);

        if (!scoreCelebrationPendingRef.current) {
          celebrateVisitedMarkers();
        }
      } else {
        if (pseudoMarkerRef.current) {
          pseudoMarkerRef.current.remove();
          pseudoMarkerRef.current = null;
        }
        if (pseudoMarker2Ref.current) {
          pseudoMarker2Ref.current.remove();
          pseudoMarker2Ref.current = null;
        }
        if (pseudoMarker3Ref.current) {
          pseudoMarker3Ref.current.remove();
          pseudoMarker3Ref.current = null;
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [
    activePlayerCharacter,
    selectedCharacter,
    createPlayerMarkerElement,
    createThreePoiMarkerDataUrl,
    celebrateVisitedMarkers,
    debugEventTypes,
    isMapReady,
    isVisitedEventKey,
    location,
    mapRotationDeg,
    isHeadingUpMode,
    playerLabel,
    renderablePoiPoints,
    showMarkerPanel,
    mapStyle,
    territoryEnabled,
    playerLocation,
    playerMoveTarget,
  ]);

  useEffect(() => {
    if (mapStyle !== "globe") {
      globeMapRef.current?.remove();
      globeMapRef.current = null;
      for (const marker of globeMarkersRef.current) {
        marker.remove();
      }
      globeMarkersRef.current = [];
      globePoiElementsRef.current.clear();
      globePoiElementsRef.current.clear();
      globePlayerMarkerRef.current?.remove();
      globePlayerMarkerRef.current = null;
      globePlayerDisposeRef.current?.();
      globePlayerDisposeRef.current = null;
      globePlayerCharacterRef.current = null;
      globePlayerApplyFacingRef.current = null;
      globePlayerLastLonRef.current = null;
      globePlayerFacingLeftRef.current = false;
      globePlayerLabelRef.current = null;
      setIsGlobeReady(false);
      return;
    }
    const container = globeContainerRef.current;
    const center = playerLocation;
    if (!container || !center) {
      return;
    }

    let isCancelled = false;

    void (async () => {
      let maplibre: unknown;
      try {
        maplibre = await import(MAPLIBRE_MODULE_ID);
      } catch {
        console.warn("[globe] maplibre-gl is not installed, falling back to satellite mode");
        if (!isCancelled) {
          setMapStyle("satellite");
        }
        return;
      }
      if (isCancelled) {
        return;
      }
      const globeLib = maplibre as {
        Map: GlobeMapConstructor;
        Marker: GlobeMarkerConstructor;
      };
      try {
        const maybeConfig = (maplibre as unknown as { config?: { WORKER_URL?: string } })?.config;
        if (maybeConfig) {
          maybeConfig.WORKER_URL = "/maplibre-gl-worker.js";
        }
        const maybeLibConfig = (globeLib as unknown as { config?: { WORKER_URL?: string } })?.config;
        if (maybeLibConfig) {
          maybeLibConfig.WORKER_URL = "/maplibre-gl-worker.js";
        }
      } catch {
        // ignore
      }
      try {
        if (typeof document !== "undefined" && !document.querySelector('link[href="/maplibre-gl.css"]')) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = "/maplibre-gl.css";
          document.head.appendChild(link);
        }
      } catch {
        // ignore
      }
      if (globeMapRef.current) {
        globeMapRef.current.setCenter([center.lon, center.lat]);
        return;
      }
      const map = new globeLib.Map({
        container,
        style: {
          version: 8,
          id: GLOBE_STYLE_ID,
          // Cluster count + POI label symbol layers need a glyphs URL; the
          // satellite raster style would otherwise render no text.
          glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
          sources: {
            "esri-satellite": {
              type: "raster",
              tiles: GLOBE_SATELLITE_TILES,
              tileSize: 256,
              maxzoom: 19,
            },
          },
          layers: [{ id: "satellite", type: "raster", source: "esri-satellite" }],
        },
        center: [center.lon, center.lat],
        zoom: getSavedZoomForStyle(locationCacheKey, "globe") ?? GLOBE_DEFAULT_ZOOM,
        minZoom: GLOBE_ZOOM_RANGE.min,
        maxZoom: GLOBE_ZOOM_RANGE.max,
        projection: { type: "globe" },
      });
      map.on("load", () => {
        if (!isCancelled) {
          map.resize();
        }
      });
      globeMapRef.current = map;
      if (!isCancelled) {
        setIsGlobeReady(true);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [mapStyle, location, playerLocation]);

  useEffect(() => {
    if (mapStyle !== "globe" || !isGlobeReady || !globeMapRef.current) {
      return;
    }
    const map = globeMapRef.current;
    let isCancelled = false;

    for (const marker of globeMarkersRef.current) {
      marker.remove();
    }
    globeMarkersRef.current = [];

    const unvisitedDataUrl = createThreePoiMarkerDataUrl("unvisited");
    const visitedDataUrl = createThreePoiMarkerDataUrl("visited");

    // Supercluster + HTML markers: globe parity with satellite's 80px pixel
    // clustering but reusing 3D pin / visited / label visuals and bottom-anchored II.
    const pointById = new Map<number, MapPoint>(
      markerPoiPoints.map((point) => [point.id, point])
    );

    const features = markerPoiPoints.map((point) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [point.lon, point.lat] as [number, number],
      },
      properties: {
        id: point.id,
        label: point.label ?? "",
        eventKey: point.eventKey ?? "",
        eventType: point.eventType ?? "",
        visited: isVisitedEventKey(point.eventKey),
      },
    }));

    const supercluster = new Supercluster({
      radius: CLUSTER_DISTANCE_PX,
      maxZoom: MAX_ZOOM_LEVEL,
      minPoints: 2,
    });
    if (features.length > 0) {
      supercluster.load(features as unknown as Parameters<typeof supercluster.load>[0]);
    }

    const clearGlobeMarkers = (): void => {
      for (const marker of globeMarkersRef.current) {
        marker.remove();
      }
      globeMarkersRef.current = [];
      globePoiElementsRef.current.clear();
    };

    const openSinglePoiPanel = (point: MapPoint): void => {
      if (placeCastleAt(point.lat, point.lon)) {
        return;
      }
      const visited = isVisitedEventKey(point.eventKey);
      const score = getVisitedScore(point.eventKey);
      if (isNeutralEventKey(point.eventKey)) {
        showMarkerPanel(buildNeutralPanel(point.label, point.eventKey, point.lat, point.lon));
        return;
      }
      if (point.eventKey) {
        const isQuizType = point.eventType?.toLowerCase() === "quiztype";
        const confirmTarget = visited ? undefined : buildEventPageTarget(point.eventKey);
        showMarkerPanel({
          title: isQuizType ? "퀴즈 마커" : "이벤트 마커",
          lines: [
            `이름: ${point.label ?? "-"}`,
            `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
            ...(visited ? ["상태: 방문 완료"] : []),
            ...(score !== null ? [`획득 점수: ${score}점`] : []),
          ],
          eventKey: point.eventKey,
          confirmTarget,
          confirmLabel: confirmTarget ? "실행" : undefined,
        });
      } else {
        showMarkerPanel({
          title: "GPS 마커",
          lines: [
            `이름: ${point.label ?? "-"}`,
            `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
          ],
        });
      }
    };

    let MarkerCtor: GlobeMarkerConstructor | null = null;
    let scheduleRender: (() => void) | null = null;

    const renderGlobeClusters = (): void => {
      if (isCancelled || !MarkerCtor) {
        return;
      }
      clearGlobeMarkers();
      if (features.length === 0) {
        return;
      }
      const getPixel = (lat: number, lon: number): { x: number; y: number } | null => {
        try {
          const anyMap = map as unknown as { project: (lngLat: [number, number]) => { x: number; y: number } };
          const p = anyMap.project([lon, lat]);
          if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
          return { x: p.x, y: p.y };
        } catch {
          return null;
        }
      };
      const clusters = clusterByPixelDistance(markerPoiPoints, getPixel);

      for (const cluster of clusters) {
        const count = cluster.points.length;
        const center = cluster.center;
        const lng = center.lon;
        const lat = center.lat;
        if (count > 1) {
          const pointsInCluster = cluster.points;
          const allVisited = pointsInCluster.every((point) => isVisitedEventKey(point.eventKey));

          const element = document.createElement("div");
          element.style.width = "56px";
          element.style.height = "56px";
          element.style.cursor = "pointer";
          element.innerHTML = `<div class="cluster-marker${allVisited ? " cluster-marker-visited" : ""}"><span>${count}</span></div>`;
          element.addEventListener("click", () => {
            if (placeCastleAt(center.lat, center.lon)) {
              return;
            }
            if (pointsInCluster.length > 0) {
              const lines = pointsInCluster.flatMap((point) => {
                const memberScore = getVisitedScore(point.eventKey);
                return [
                  `이름: ${point.label ?? "-"}`,
                  `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
                  ...(memberScore !== null ? [`획득 점수: ${memberScore}점`] : []),
                  "---",
                ];
              });
              const clusterEventKeys = pointsInCluster
                .map((point) => point.eventKey?.trim() ?? "")
                .filter((key) => key.length > 0);
              showMarkerPanel({
                title: `마커 ${count}개`,
                lines,
                eventKey: clusterEventKeys.length > 0 ? clusterEventKeys.join("\n") : undefined,
              });
            }
          });

          const marker = new MarkerCtor!({ element, anchor: "center" })
            .setLngLat([lng, lat])
            .addTo(map as unknown as GlobeMapLike);
          registerTerritorySoldierAnimation(element);
          globeMarkersRef.current.push(marker);
        } else {
          const point = cluster.points[0];
          const visited = isVisitedEventKey(point.eventKey);
          const isNeutralPoi = isNeutralEventKey(point.eventKey);
          const neutralDamageExpiresAt = isNeutralPoi
            ? getNeutralDamageExpiry(point.eventKey)
            : null;
          const isCastlePoi = castleKindOf(point.eventKey) === "lord" || castleKindOf(point.eventKey) === "noble";
          const isCenterPoi = isNeutralPoi || isCastlePoi;
          const element = document.createElement("div");
          element.style.width = isCenterPoi ? "54px" : "30px";
          element.style.height = isCenterPoi ? "54px" : "30px";
          element.style.overflow = "visible";
          element.style.cursor = "pointer";
          if (neutralDamageExpiresAt !== null) {
            appendNeutralDamageAnimation(element, neutralDamageExpiresAt);
          } else if (visited && territoryEnabled && castleKindOf(point.eventKey) === "lord") {
            appendDamagedLordCastleAnimation(element);
          } else if (visited) {
            const visitedDataUrl = createThreePoiMarkerDataUrl("visited");
            const unvisitedDataUrl = createThreePoiMarkerDataUrl("unvisited");
            const wrap = document.createElement("div");
            wrap.className = "three-poi-marker-visited-wrap";
            const glow = document.createElement("span");
            glow.className = "three-poi-marker-visited-glow";
            glow.setAttribute("aria-hidden", "true");
            wrap.appendChild(glow);
            const ripple = document.createElement("span");
            ripple.className = "three-poi-marker-visited-ripple";
            ripple.setAttribute("aria-hidden", "true");
            wrap.appendChild(ripple);
            if (visitedDataUrl && unvisitedDataUrl) {
              const redImg = document.createElement("img");
              redImg.src = unvisitedDataUrl;
              redImg.alt = "";
              redImg.className = "three-poi-marker-visited-red";
              wrap.appendChild(redImg);
              const visitedImg = document.createElement("img");
              visitedImg.src = visitedDataUrl;
              visitedImg.alt = "";
              visitedImg.className = "three-poi-marker-visited";
              wrap.appendChild(visitedImg);
            } else if (visitedDataUrl) {
              const visitedImg = document.createElement("img");
              visitedImg.src = visitedDataUrl;
              visitedImg.alt = "";
              visitedImg.className = "three-poi-marker-visited";
              wrap.appendChild(visitedImg);
            } else {
              const redFallback = document.createElement("div");
              redFallback.className = "three-poi-marker-fallback three-poi-marker-visited-red";
              redFallback.setAttribute("aria-hidden", "true");
              wrap.appendChild(redFallback);
              const visitedFallback = document.createElement("div");
              visitedFallback.className =
                "three-poi-marker-fallback three-poi-marker-visited-fallback three-poi-marker-visited";
              visitedFallback.setAttribute("aria-hidden", "true");
              wrap.appendChild(visitedFallback);
            }
            element.appendChild(wrap);
          } else {
            const unvisitedDataUrl = createThreePoiMarkerDataUrl("unvisited");
            if (isNeutralEventKey(point.eventKey)) {
              const castleImg = document.createElement("img");
              castleImg.src = "/markers/neutral-castle-v2-short.png";
              castleImg.alt = "";
              castleImg.style.width = "54px";
              castleImg.style.height = "54px";
              castleImg.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.55))";
              element.appendChild(castleImg);
            } else if (castleKindOf(point.eventKey) === "lord" || castleKindOf(point.eventKey) === "noble") {
              const kind = castleKindOf(point.eventKey);
              const kindImg = document.createElement("img");
              kindImg.src = kind === "lord" ? "/markers/lord-castle-v2.png" : "/markers/neutral-castle-v2.png";
              kindImg.alt = "";
              kindImg.style.width = "54px";
              kindImg.style.height = "54px";
              kindImg.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.55))";
              element.style.width = "54px";
              element.style.height = "54px";
              element.appendChild(kindImg);
            } else if (territoryEnabled) {
              appendTerritorySoldierAnimation(element);
            } else if (unvisitedDataUrl) {
              const spin = document.createElement("div");
              spin.className = "three-poi-marker-spin";
              const image = document.createElement("img");
              image.src = unvisitedDataUrl;
              image.alt = "";
              image.className = "three-poi-marker";
              spin.appendChild(image);
              element.appendChild(spin);
            } else {
              const fallback = document.createElement("div");
              fallback.className = "three-poi-marker-fallback";
              fallback.setAttribute("aria-hidden", "true");
              element.appendChild(fallback);
            }
          }
          if (point.label) {
            const label = document.createElement("div");
            label.className = "map-poi-label";
            label.textContent = point.label;
            label.style.background = "rgba(2,6,23,0.72)";
            label.style.color = "#ffffff";
            label.style.fontSize = "11px";
            label.style.fontWeight = "700";
            label.style.borderRadius = "4px";
            label.style.padding = "4px 8px";
            label.style.whiteSpace = "nowrap";
            label.style.pointerEvents = "none";
            label.style.position = "absolute";
            label.style.bottom = "100%";
            label.style.marginBottom = "8px";
            label.style.left = "50%";
            label.style.transform = "translateX(-50%)";
            element.appendChild(label);
          }
          if (visited && territoryEnabled && castleKindOf(point.eventKey) === "lord") {
            appendDamagedLordCastleAnimation(element);
          } else if (visited) {
            const visitedKey = point.eventKey?.trim() ?? "";
            if (visitedKey) {
              globePoiElementsRef.current.set(visitedKey, element);
              cesiumPoiElementsRef.current.set(visitedKey, element);
              if (!readCelebratedTimes().has(visitedKey)) {
                element.classList.add("morph-pending");
              }
            }
          }
          element.addEventListener("click", () => openSinglePoiPanel(point));
          if (isNeutralEventKey(point.eventKey)) {
            try {
              const globeZoom =
                (map as unknown as { getZoom?: () => number }).getZoom?.() ?? 15;
              element.appendChild(
                buildNeutralRangeRing(
                  (NEUTRAL_RANGE_RADIUS_M * 2) / metersPerPixel(point.lat, globeZoom),
                  true
                )
              );
            } catch {}
          }
          const marker = new MarkerCtor!({ element, anchor: isCenterPoi ? "center" : "bottom" })
            .setLngLat([point.lon, point.lat])
            .addTo(map as unknown as GlobeMapLike);
          registerTerritorySoldierAnimation(element);
          globeMarkersRef.current.push(marker);
        }
      }
    };

    void (async () => {
      try {
        const lib = (await import(MAPLIBRE_MODULE_ID)) as { Marker: GlobeMarkerConstructor };
        if (isCancelled) {
          return;
        }
        MarkerCtor = lib.Marker;
        globeMarkerCtorRef.current = lib.Marker;
        renderGlobeClusters();
        if (!scoreCelebrationPendingRef.current) {
          celebrateVisitedMarkers();
        }
        scheduleRender = () => renderGlobeClusters();
        const globeMapWithEvents = map as unknown as {
          on: (event: string, handler: () => void) => void;
          off: (event: string, handler: () => void) => void;
        };
        globeMapWithEvents.on("moveend", scheduleRender);
        globeMapWithEvents.on("zoomend", scheduleRender);
      } catch {
        // marker load failed; keep map without POI until retry
      }
    })();

    return () => {
      isCancelled = true;
      if (scheduleRender) {
        try {
          const globeMapWithEvents = map as unknown as {
            on: (event: string, handler: () => void) => void;
            off: (event: string, handler: () => void) => void;
          };
          globeMapWithEvents.off("moveend", scheduleRender);
          globeMapWithEvents.off("zoomend", scheduleRender);
        } catch {
          // ignore
        }
      }
      clearGlobeMarkers();
    };
  }, [mapStyle, isGlobeReady, markerPoiPoints, isVisitedEventKey, getVisitedScore, getNeutralDamageExpiry, showMarkerPanel, createThreePoiMarkerDataUrl, castleKindMap, placeCastleAt]);

  useEffect(() => {
    if (mapStyle !== "globe" || !isGlobeReady || !globeMapRef.current) {
      return;
    }
    const map = globeMapRef.current;
    const center = playerLocation;
    if (!center) {
      return;
    }
    let isCancelled = false;

    const syncGlobePlayerFacingDirection = (nextLon: number) => {
      const previousLon = globePlayerLastLonRef.current;

      if (previousLon !== null) {
        const deltaLon = nextLon - previousLon;
        if (Math.abs(deltaLon) > SPRITE_DIRECTION_LON_THRESHOLD) {
          globePlayerFacingLeftRef.current = deltaLon < 0;
        }
      }

      globePlayerLastLonRef.current = nextLon;
      globePlayerApplyFacingRef.current?.(globePlayerFacingLeftRef.current);
    };

    void (async () => {
      let MarkerCtor: GlobeMarkerConstructor;
      try {
        MarkerCtor = ((await import(MAPLIBRE_MODULE_ID)) as {
          Marker: GlobeMarkerConstructor;
        }).Marker;
      } catch {
        return;
      }
      if (isCancelled) {
        return;
      }
      if (!adminSelectedRef.current) {
        map.setCenter([center.lon, center.lat]);
      }
      if (
        activePlayerCharacter !== null &&
        globePlayerCharacterRef.current !== null &&
        globePlayerCharacterRef.current !== activePlayerCharacter
      ) {
        globePlayerDisposeRef.current?.();
        globePlayerDisposeRef.current = null;
        globePlayerApplyFacingRef.current = null;
        globePlayerCharacterRef.current = null;
        globePlayerMarkerRef.current?.remove();
        globePlayerMarkerRef.current = null;
        globePlayerLabelRef.current = null;
      }
      if (globePlayerMarkerRef.current) {
        globePlayerMarkerRef.current.setLngLat([center.lon, center.lat]);
        if (globePlayerLabelRef.current && globePlayerLabelRef.current.textContent !== playerLabel) {
          globePlayerLabelRef.current.textContent = playerLabel;
        }
        syncGlobePlayerFacingDirection(center.lon);
      } else if (activePlayerCharacter !== null) {
        const playerMarker = createPlayerMarkerElement(activePlayerCharacter);
        if (isCancelled) {
          playerMarker.dispose();
          return;
        }
        globePlayerDisposeRef.current = playerMarker.dispose;
        globePlayerCharacterRef.current = activePlayerCharacter;
        globePlayerApplyFacingRef.current = playerMarker.applyFacingDirection;
        const wrapper = document.createElement("div");
        // Same positioning constraint as POI markers above; explicit size keeps
        // the bottom anchor exact for the 66px sprite.
        wrapper.style.width = `${playerMarker.iconSize[0]}px`;
        wrapper.style.height = `${playerMarker.iconSize[1]}px`;
        wrapper.style.overflow = "visible";
        wrapper.appendChild(playerMarker.element);
        const label = document.createElement("div");
        label.className = "map-player-label";
        label.textContent = playerLabel;
        label.style.background = "rgba(8,47,73,0.72)";
        label.style.color = "#e0f2fe";
        label.style.fontSize = "11px";
        label.style.fontWeight = "800";
        label.style.border = "1px solid rgba(125,211,252,0.45)";
        label.style.borderRadius = "4px";
        label.style.padding = "4px 8px";
        label.style.position = "absolute";
        label.style.bottom = "100%";
        label.style.marginBottom = "8px";
        label.style.left = "50%";
        label.style.transform = "translateX(-50%)";
        label.style.pointerEvents = "none";
        label.style.whiteSpace = "nowrap";
        wrapper.appendChild(label);
        globePlayerLabelRef.current = label;
        globePlayerMarkerRef.current = new MarkerCtor({ element: wrapper, anchor: "bottom" })
          .setLngLat([center.lon, center.lat])
          .addTo(map);
        wrapper.style.cursor = "pointer";
        wrapper.addEventListener("click", () => handleUnitMarkerClick(LORD_UNIT_ID));
        syncGlobePlayerFacingDirection(center.lon);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [mapStyle, isGlobeReady, location, playerLocation, activePlayerCharacter, createPlayerMarkerElement, playerLabel]);

  useEffect(() => {
    return () => {
      globeMapRef.current?.remove();
      globeMapRef.current = null;
      for (const marker of globeMarkersRef.current) {
        marker.remove();
      }
      globeMarkersRef.current = [];
      globePoiElementsRef.current.clear();
      globePlayerMarkerRef.current?.remove();
      globePlayerMarkerRef.current = null;
      globePlayerDisposeRef.current?.();
      globePlayerDisposeRef.current = null;
      globePlayerCharacterRef.current = null;
      globePlayerApplyFacingRef.current = null;
      globePlayerLastLonRef.current = null;
      globePlayerFacingLeftRef.current = false;
      globePlayerLabelRef.current = null;
    };
  }, []);

  const createCesiumClusterDataUrl = useCallback((count: number, allVisited: boolean): string | null => {
    if (typeof document === "undefined") {
      return null;
    }

    const size = 112;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const center = size / 2;
    const radius = 50;
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    if (allVisited) {
      gradient.addColorStop(0, "rgba(0, 230, 80, 0.95)");
      gradient.addColorStop(1, "rgba(0, 160, 55, 0.95)");
    } else {
      gradient.addColorStop(0, "rgba(239, 68, 68, 0.95)");
      gradient.addColorStop(1, "rgba(185, 28, 28, 0.95)");
    }
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(center, center, radius - 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "900 44px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count), center, center + 2);

    return canvas.toDataURL("image/png");
  }, []);


  const getCesiumPlayerImageAsync = useCallback(async (facingLeft: boolean): Promise<string | null> => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return null;
    }

    if (activePlayerCharacter === "walking" || activePlayerCharacter === "fallenAngel") {
      const frames = activePlayerCharacter === "walking" ? walkingFrameUrls : fallenAngelFrameUrls;
      if (frames.length === 0) {
        return null;
      }
      const src = frames[0];
      if (!facingLeft) {
        return src;
      }
      const cached = cesiumFlippedImageCacheRef.current.get(src);
      if (cached) {
        return cached;
      }
      try {
        const image = await new Promise<HTMLImageElement | null>((resolve) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => resolve(null);
          element.src = src;
        });
        if (!image) {
          return src;
        }
        const flipCanvas = document.createElement("canvas");
        flipCanvas.width = image.naturalWidth || 66;
        flipCanvas.height = image.naturalHeight || 66;
        const flipCtx = flipCanvas.getContext("2d");
        if (!flipCtx) {
          return src;
        }
        flipCtx.translate(flipCanvas.width, 0);
        flipCtx.scale(-1, 1);
        flipCtx.drawImage(image, 0, 0);
        const flipped = flipCanvas.toDataURL("image/png");
        cesiumFlippedImageCacheRef.current.set(src, flipped);
        return flipped;
      } catch {
        return src;
      }
    }

    return null;
  }, [activePlayerCharacter, walkingFrameUrls, fallenAngelFrameUrls]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (mapStyle !== "cesium") {
      const previousViewer = cesiumViewerRef.current;
      cesiumViewerRef.current = null;
      cesiumPlayerEntityRef.current = null;
      cesiumPoiEntitiesRef.current = [];
      cesiumEntityPointMapRef.current.clear();
      cesiumEntityClusterMapRef.current.clear();
      cesiumHtmlOverlayRef.current?.remove();
      cesiumHtmlOverlayRef.current = null;
      cesiumHtmlMarkersRef.current = [];
      cesiumPoiElementsRef.current.clear();
      cesiumPlayerLastLonRef.current = null;
      cesiumPlayerFacingLeftRef.current = false;
      if (previousViewer && !previousViewer.isDestroyed()) {
        previousViewer.destroy();
      }
      setIsCesiumReady((ready) => (ready ? false : ready));
      return;
    }
    const container = cesiumContainerRef.current;
    const center = playerLocation;
    if (!container || !center) {
      return;
    }
    if (cesiumViewerRef.current && !cesiumViewerRef.current.isDestroyed()) {
      return;
    }
    let isCancelled = false;

    void (async () => {
      try {
        if (
          !document.querySelector(`link[href="${CESIUM_CDN_BASE}/Widgets/widgets.css"]`) &&
          !document.querySelector('link[href="/cesium/Widgets/widgets.css"]')
        ) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `${CESIUM_CDN_BASE}/Widgets/widgets.css`;
          document.head.appendChild(link);
        }
      } catch {
        // Cesium CSS link injection is optional; the globe still renders without it.
      }
      try {
        (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = `${CESIUM_CDN_BASE}/`;
      } catch {
        // CESIUM_BASE_URL assignment is optional when workers resolve by default.
      }
      let Cesium: typeof import("cesium");
      try {
        Cesium = await loadCesium();
      } catch {
        return;
      }
      if (isCancelled) {
        return;
      }
      if (cesiumViewerRef.current && !cesiumViewerRef.current.isDestroyed()) {
        return;
      }
      Cesium.Ion.defaultAccessToken = "";
      let viewer: CesiumTypes.Viewer | null = null;
      try {
        viewer = new Cesium.Viewer(container, {
          animation: false,
          baseLayerPicker: false,
          timeline: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          shadows: false,
          shouldAnimate: true,
          baseLayer: false,
        });
        viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        viewer.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: GLOBE_SATELLITE_TILES[0],
            maximumLevel: MAX_ZOOM_LEVEL,
          })
        );
        viewer.scene.globe.baseColor = Cesium.Color.BLACK;
        try {
          viewer.scene.screenSpaceCameraController.minimumZoomDistance = 5;
          viewer.scene.screenSpaceCameraController.maximumZoomDistance =
            1000 * Math.pow(2, 19 - CESIUM_ZOOM_RANGE.min);
        } catch {}
        const savedZoomForCesium = getSavedZoomForStyle(locationCacheKey, "cesium");
        const initialHeight =
          savedZoomForCesium !== null ? 1000 * Math.pow(2, 19 - savedZoomForCesium) : 1500;
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat, initialHeight),
        });
      } catch {
        if (viewer && !viewer.isDestroyed()) {
          viewer.destroy();
        }
        return;
      }
      if (isCancelled) {
        if (!viewer.isDestroyed()) {
          viewer.destroy();
        }
        return;
      }
      cesiumViewerRef.current = viewer;
      // HTML overlay for POI markers with CSS animations (Y-spin)
      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.overflow = "visible";
      overlay.style.zIndex = "5";
      container.appendChild(overlay);
      cesiumHtmlOverlayRef.current = overlay;
      setIsCesiumReady(true);
      // Fix: viewer created while container was display:none has 0 size
      requestAnimationFrame(() => {
        if (!viewer.isDestroyed()) {
          try {
            viewer.resize();
            viewer.scene.requestRender();
          } catch {}
        }
      });
      const handleResize = () => {
        if (!viewer.isDestroyed()) {
          try {
            viewer.resize();
          } catch {}
        }
      };
      window.addEventListener("resize", handleResize);
      // store for cleanup via closure
      (viewer as unknown as { __resizeHandler?: () => void }).__resizeHandler = handleResize;
    })();

    return () => {
      isCancelled = true;
      const v = cesiumViewerRef.current;
      const h = (v as unknown as { __resizeHandler?: () => void })?.__resizeHandler;
      if (h) {
        window.removeEventListener("resize", h);
      }
    };
  }, [mapStyle, location, playerLocation]);

  useEffect(() => {
    if (mapStyle !== "cesium" || !isCesiumReady) {
      return;
    }
    const viewer = cesiumViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    let isCancelled = false;
    let removeMoveEnd: (() => void) | null = null;
    let removePostRender: (() => void) | null = null;

    const clearCesiumPoiEntities = (): void => {
      const currentViewer = cesiumViewerRef.current;
      for (const entity of cesiumPoiEntitiesRef.current) {
        currentViewer?.entities.remove(entity);
      }
      cesiumPoiEntitiesRef.current = [];
      cesiumEntityPointMapRef.current.clear();
      cesiumEntityClusterMapRef.current.clear();
    };

    const openSinglePoiPanel = (point: MapPoint): void => {
      if (placeCastleAt(point.lat, point.lon)) {
        return;
      }
      const visited = isVisitedEventKey(point.eventKey);
      const score = getVisitedScore(point.eventKey);
      if (isNeutralEventKey(point.eventKey)) {
        showMarkerPanel(buildNeutralPanel(point.label, point.eventKey, point.lat, point.lon));
        return;
      }
      if (point.eventKey) {
        const isQuizType = point.eventType?.toLowerCase() === "quiztype";
        const confirmTarget = visited ? undefined : buildEventPageTarget(point.eventKey);
        showMarkerPanel({
          title: isQuizType ? "퀴즈 마커" : "이벤트 마커",
          lines: [
            `이름: ${point.label ?? "-"}`,
            `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
            ...(visited ? ["상태: 방문 완료"] : []),
            ...(score !== null ? [`획득 점수: ${score}점`] : []),
          ],
          eventKey: point.eventKey,
          confirmTarget,
          confirmLabel: confirmTarget ? "실행" : undefined,
        });
      } else {
        showMarkerPanel({
          title: "GPS 마커",
          lines: [
            `이름: ${point.label ?? "-"}`,
            `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
          ],
        });
      }
    };

    const openCesiumClusterPanel = (points: MapPoint[], count: number): void => {
      if (points.length === 0) {
        return;
      }
      const centerLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
      const centerLon = points.reduce((sum, point) => sum + point.lon, 0) / points.length;
      if (placeCastleAt(centerLat, centerLon)) {
        return;
      }
      const lines = points.flatMap((point) => {
        const memberScore = getVisitedScore(point.eventKey);
        return [
          `이름: ${point.label ?? "-"}`,
          `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
          ...(memberScore !== null ? [`획득 점수: ${memberScore}점`] : []),
          "---",
        ];
      });
      const clusterEventKeys = points
        .map((point) => point.eventKey?.trim() ?? "")
        .filter((key) => key.length > 0);
      showMarkerPanel({
        title: `마커 ${count}개`,
        lines,
        eventKey: clusterEventKeys.length > 0 ? clusterEventKeys.join("\n") : undefined,
      });
    };

    const clearCesiumHtmlMarkers = (): void => {
      for (const entry of cesiumHtmlMarkersRef.current) {
        entry.element.remove();
      }
      cesiumHtmlMarkersRef.current = [];
      cesiumPoiElementsRef.current.clear();
      const overlay = cesiumHtmlOverlayRef.current;
      if (overlay) {
        // Keep overlay element itself, just clear children (already removed)
        overlay.replaceChildren();
      }
    };

    const updateCesiumHtmlPositions = (Cesium: typeof import("cesium")): void => {
      const viewer = cesiumViewerRef.current;
      const overlay = cesiumHtmlOverlayRef.current;
      if (!viewer || viewer.isDestroyed() || !overlay) {
        return;
      }
      for (const entry of cesiumHtmlMarkersRef.current) {
        try {
          const cartesian = Cesium.Cartesian3.fromDegrees(entry.lon, entry.lat, 0);
          const canvasPos = viewer.scene.cartesianToCanvasCoordinates(cartesian);
          if (!canvasPos) {
            entry.element.style.display = "none";
            continue;
          }
          // Hide if behind globe / offscreen
          const occluded = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
          // Simple visibility check via canvas bounds
          const x = canvasPos.x;
          const y = canvasPos.y;
          const rect = overlay.getBoundingClientRect();
          // canvasPos is in canvas pixels (same as overlay size)
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < -100 || y < -100 || x > rect.width + 100 || y > rect.height + 100) {
            entry.element.style.display = "none";
            continue;
          }
          entry.element.style.display = "";
          entry.element.style.left = `${x}px`;
          entry.element.style.top = `${y}px`;
        } catch {
          entry.element.style.display = "none";
        }
      }
    };

    const renderCesiumPois = (Cesium: typeof import("cesium")): void => {
      if (isCancelled) {
        return;
      }
      const currentViewer = cesiumViewerRef.current;
      const overlay = cesiumHtmlOverlayRef.current;
      if (!currentViewer || currentViewer.isDestroyed() || !overlay) {
        return;
      }
      clearCesiumHtmlMarkers();
      // Also clear any leftover Entity POIs (legacy)
      clearCesiumPoiEntities();
      if (markerPoiPoints.length === 0) {
        return;
      }

      const unvisitedDataUrl = createThreePoiMarkerDataUrl("unvisited");
      const visitedDataUrl = createThreePoiMarkerDataUrl("visited");

      const pointById = new Map<number, MapPoint>(
        markerPoiPoints.map((point) => [point.id, point])
      );

      const features = markerPoiPoints.map((point) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [point.lon, point.lat] as [number, number],
        },
        properties: {
          id: point.id,
          label: point.label ?? "",
          eventKey: point.eventKey ?? "",
          eventType: point.eventType ?? "",
          visited: isVisitedEventKey(point.eventKey),
        },
      }));

      const getPixelCesium = (lat: number, lon: number): { x: number; y: number } | null => {
        try {
          const CesiumWindow = window as unknown as { Cesium?: typeof import("cesium") };
          const Cesium = CesiumWindow.Cesium;
          const viewer = currentViewer;
          if (!Cesium || !viewer || viewer.isDestroyed()) return null;
          const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
          const canvasPos = viewer.scene.cartesianToCanvasCoordinates(cartesian);
          if (!canvasPos || typeof canvasPos.x !== "number" || typeof canvasPos.y !== "number") return null;
          return { x: canvasPos.x, y: canvasPos.y };
        } catch {
          return null;
        }
      };
      const clusters = clusterByPixelDistance(markerPoiPoints, getPixelCesium);

      for (const cluster of clusters) {
        const count = cluster.points.length;
        const center = cluster.center;
        const lng = center.lon;
        const lat = center.lat;
        if (count > 1) {
          const pointsInCluster = cluster.points;
          const allVisited = pointsInCluster.every((point) => isVisitedEventKey(point.eventKey));

          const element = document.createElement("div");
          element.style.position = "absolute";
          element.style.width = "56px";
          element.style.height = "56px";
          element.style.transform = "translate(-50%, -50%)";
          element.style.pointerEvents = "auto";
          element.style.cursor = "pointer";
          element.innerHTML = `<div class="cluster-marker${allVisited ? " cluster-marker-visited" : ""}"><span>${count}</span></div>`;
          element.addEventListener("click", () => {
            openCesiumClusterPanel(pointsInCluster, count);
          });
          overlay.appendChild(element);
          cesiumHtmlMarkersRef.current.push({ element, lon: lng, lat, anchor: "center" });
        } else {
          const point = cluster.points[0];
          const visited = isVisitedEventKey(point.eventKey);
          const isNeutralCesium = isNeutralEventKey(point.eventKey);
          const neutralDamageExpiresAt = isNeutralCesium
            ? getNeutralDamageExpiry(point.eventKey)
            : null;
          const isCastleCesium = castleKindOf(point.eventKey) === "lord" || castleKindOf(point.eventKey) === "noble";
          const isCenterCesium = isNeutralCesium || isCastleCesium;
          const element = document.createElement("div");
          element.style.position = "absolute";
          element.style.width = isCenterCesium ? "54px" : "30px";
          element.style.height = isCenterCesium ? "54px" : "30px";
          element.style.overflow = "visible";
          element.style.transform = isCenterCesium
            ? "translate(-50%, -50%)"
            : "translate(-50%, -100%)";
          element.style.pointerEvents = "auto";
          element.style.cursor = "pointer";
          if (neutralDamageExpiresAt !== null) {
            appendNeutralDamageAnimation(element, neutralDamageExpiresAt);
          } else if (visited) {
            const wrap = document.createElement("div");
            wrap.className = "three-poi-marker-visited-wrap";
            const glow = document.createElement("span");
            glow.className = "three-poi-marker-visited-glow";
            glow.setAttribute("aria-hidden", "true");
            wrap.appendChild(glow);
            const ripple = document.createElement("span");
            ripple.className = "three-poi-marker-visited-ripple";
            ripple.setAttribute("aria-hidden", "true");
            wrap.appendChild(ripple);
            const vUrl = visitedDataUrl;
            const uUrl = unvisitedDataUrl;
            if (vUrl && uUrl) {
              const redImg = document.createElement("img");
              redImg.src = uUrl;
              redImg.alt = "";
              redImg.className = "three-poi-marker-visited-red";
              wrap.appendChild(redImg);
              const visImg = document.createElement("img");
              visImg.src = vUrl;
              visImg.alt = "";
              visImg.className = "three-poi-marker-visited";
              wrap.appendChild(visImg);
            } else if (vUrl) {
              const visImg = document.createElement("img");
              visImg.src = vUrl;
              visImg.alt = "";
              visImg.className = "three-poi-marker-visited";
              wrap.appendChild(visImg);
            } else {
              const redFallback = document.createElement("div");
              redFallback.className = "three-poi-marker-fallback three-poi-marker-visited-red";
              redFallback.setAttribute("aria-hidden", "true");
              wrap.appendChild(redFallback);
              const visitedFallback = document.createElement("div");
              visitedFallback.className =
                "three-poi-marker-fallback three-poi-marker-visited-fallback three-poi-marker-visited";
              visitedFallback.setAttribute("aria-hidden", "true");
              wrap.appendChild(visitedFallback);
            }
            element.appendChild(wrap);
          } else if (isNeutralEventKey(point.eventKey)) {
            const castleImg = document.createElement("img");
            castleImg.src = "/markers/neutral-castle-v2-short.png";
            castleImg.alt = "";
            castleImg.style.width = "54px";
            castleImg.style.height = "54px";
            castleImg.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.55))";
            element.appendChild(castleImg);
          } else if (castleKindOf(point.eventKey) === "lord" || castleKindOf(point.eventKey) === "noble") {
            const kind = castleKindOf(point.eventKey);
            const kindImg = document.createElement("img");
            kindImg.src = kind === "lord" ? "/markers/lord-castle-v2.png" : "/markers/neutral-castle-v2.png";
            kindImg.alt = "";
            kindImg.style.width = "54px";
            kindImg.style.height = "54px";
            kindImg.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.55))";
            element.style.width = "54px";
            element.style.height = "54px";
            element.appendChild(kindImg);
          } else if (territoryEnabled) {
            appendTerritorySoldierAnimation(element);
          } else {
            const spin = document.createElement("div");
            spin.className = "three-poi-marker-spin";
            if (unvisitedDataUrl) {
              const image = document.createElement("img");
              image.src = unvisitedDataUrl;
              image.alt = "";
              image.className = "three-poi-marker";
              spin.appendChild(image);
            } else {
              const fallback = document.createElement("div");
              fallback.className = "three-poi-marker-fallback";
              fallback.setAttribute("aria-hidden", "true");
              spin.appendChild(fallback);
            }
            element.appendChild(spin);
          }
          if (point.label) {
            const label = document.createElement("div");
            label.className = "map-poi-label";
            label.textContent = point.label;
            label.style.background = "rgba(2,6,23,0.72)";
            label.style.color = "#ffffff";
            label.style.fontSize = "11px";
            label.style.fontWeight = "700";
            label.style.borderRadius = "4px";
            label.style.padding = "4px 8px";
            label.style.whiteSpace = "nowrap";
            label.style.pointerEvents = "none";
            label.style.position = "absolute";
            label.style.bottom = "100%";
            label.style.marginBottom = "8px";
            label.style.left = "50%";
            label.style.transform = "translateX(-50%)";
            element.appendChild(label);
          }
          if (visited) {
            const visitedKey = point.eventKey?.trim() ?? "";
            if (visitedKey) {
              globePoiElementsRef.current.set(visitedKey, element);
              cesiumPoiElementsRef.current.set(visitedKey, element);
              if (!readCelebratedTimes().has(visitedKey)) {
                element.classList.add("morph-pending");
              }
            }
          }
          element.addEventListener("click", () => openSinglePoiPanel(point));
          if (isNeutralEventKey(point.eventKey)) {
            try {
              const rangeEntity = currentViewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
                ellipse: {
                  semiMinorAxis: NEUTRAL_RANGE_RADIUS_M,
                  semiMajorAxis: NEUTRAL_RANGE_RADIUS_M,
                  material: Cesium.Color.fromCssColorString("#fbbf24").withAlpha(0.12),
                  outline: true,
                  outlineColor: Cesium.Color.fromCssColorString("#fbbf24").withAlpha(0.9),
                  outlineWidth: 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                },
              });
              cesiumPoiEntitiesRef.current.push(rangeEntity);
            } catch {}
          }
          overlay.appendChild(element);
          cesiumHtmlMarkersRef.current.push({ element, lon: lng, lat, anchor: "bottom" });
        }
      }
      updateCesiumHtmlPositions(Cesium);
    };

    void (async () => {
      let Cesium: typeof import("cesium");
      try {
        Cesium = await loadCesium();
      } catch {
        return;
      }
      if (isCancelled) {
        return;
      }
      const currentViewer = cesiumViewerRef.current;
      if (!currentViewer || currentViewer.isDestroyed()) {
        return;
      }
      renderCesiumPois(Cesium);
      if (!scoreCelebrationPendingRef.current) {
        celebrateVisitedMarkers();
      }
      removeMoveEnd = currentViewer.camera.moveEnd.addEventListener(() => {
        renderCesiumPois(Cesium);
      });
      const updatePositions = () => updateCesiumHtmlPositions(Cesium);
      currentViewer.scene.postRender.addEventListener(updatePositions);
      removePostRender = () => {
        try {
          currentViewer.scene.postRender.removeEventListener(updatePositions);
        } catch {}
      };
    })();

    return () => {
      isCancelled = true;
      if (removeMoveEnd) {
        removeMoveEnd();
        removeMoveEnd = null;
      }
      if (removePostRender) {
        removePostRender();
        removePostRender = null;
      }
      clearCesiumHtmlMarkers();
      clearCesiumPoiEntities();
    };
  }, [mapStyle, isCesiumReady, markerPoiPoints, isVisitedEventKey, getVisitedScore, getNeutralDamageExpiry, showMarkerPanel, createThreePoiMarkerDataUrl, createCesiumClusterDataUrl, castleKindMap, placeCastleAt]);

  useEffect(() => {
    if (mapStyle !== "cesium" || !isCesiumReady) {
      return;
    }
    const viewer = cesiumViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    const center = playerLocation;
    if (!center) {
      return;
    }
    if (activePlayerCharacter === null) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    let isCancelled = false;

    void (async () => {
      let Cesium: typeof import("cesium");
      try {
        Cesium = await loadCesium();
      } catch {
        return;
      }
      if (isCancelled) {
        return;
      }
      const currentViewer = cesiumViewerRef.current;
      if (!currentViewer || currentViewer.isDestroyed()) {
        return;
      }

      {
        const previousLon = cesiumPlayerLastLonRef.current;
        if (previousLon !== null) {
          const deltaLon = center.lon - previousLon;
          if (Math.abs(deltaLon) > SPRITE_DIRECTION_LON_THRESHOLD) {
            cesiumPlayerFacingLeftRef.current = deltaLon < 0;
          }
        }
        cesiumPlayerLastLonRef.current = center.lon;
      }

      const image = await getCesiumPlayerImageAsync(cesiumPlayerFacingLeftRef.current);
      if (isCancelled) {
        return;
      }
      if (!image) {
        return;
      }
      const position = Cesium.Cartesian3.fromDegrees(center.lon, center.lat);
      if (cesiumPlayerEntityRef.current && !currentViewer.entities.contains(cesiumPlayerEntityRef.current)) {
        cesiumPlayerEntityRef.current = null;
      }
      const target = cesiumPlayerEntityRef.current;
      const isLargeCharacter = activePlayerCharacter === "walking" || activePlayerCharacter === "fallenAngel";
      const billboardSize = isLargeCharacter ? 66 : 44;
      const labelOffsetY = isLargeCharacter ? -72 : -50;
      if (target) {
        target.position = new Cesium.ConstantPositionProperty(position);
        if (target.billboard) {
          target.billboard.image = new Cesium.ConstantProperty(image);
          (target.billboard as unknown as { width?: unknown; height?: unknown }).width = new Cesium.ConstantProperty(billboardSize) as unknown as any;
          (target.billboard as unknown as { width?: unknown; height?: unknown }).height = new Cesium.ConstantProperty(billboardSize) as unknown as any;
        }
        if (target.label) {
          target.label.text = new Cesium.ConstantProperty(playerLabel);
          (target.label as unknown as { pixelOffset?: unknown }).pixelOffset = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, labelOffsetY)) as unknown as any;
        }
      } else {
        const entity = currentViewer.entities.add({
          position,
          billboard: {
            image,
            width: billboardSize,
            height: billboardSize,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          },
          label: {
            text: playerLabel,
            font: "11px sans-serif",
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 2,
            outlineColor: Cesium.Color.fromBytes(8, 47, 73, 230),
            fillColor: Cesium.Color.fromBytes(224, 242, 254, 255),
            pixelOffset: new Cesium.Cartesian2(0, labelOffsetY),
            show: true,
          },
        });
        cesiumPlayerEntityRef.current = entity;
      }

      try {
        const currentHeight = currentViewer.camera.positionCartographic.height;
        const height = Number.isFinite(currentHeight) && currentHeight > 100 && currentHeight < 100000000 ? currentHeight : 1500;
        const heading = currentViewer.camera.heading;
        const pitch = currentViewer.camera.pitch;
        const roll = currentViewer.camera.roll;
        currentViewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat, height),
          orientation: {
            heading,
            pitch,
            roll,
          },
        });
      } catch {
        // Keep the current camera when the follow-view update fails.
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [mapStyle, isCesiumReady, location, playerLocation, activePlayerCharacter, playerLabel, getCesiumPlayerImageAsync]);

  useEffect(() => {
    return () => {
      const previousViewer = cesiumViewerRef.current;
      cesiumViewerRef.current = null;
      if (previousViewer && !previousViewer.isDestroyed()) {
        previousViewer.destroy();
      }
    };
  }, []);

  const proximityMarkerInfoRef = useRef<MarkerPanel | null>(null);
  const markerPanelRef = useRef<MarkerPanel | null>(null);
  // 사용자가 닫은 무법자 자동 패널 재오픈 억제 (wildId 집합).
  // 인식범위 안에 있는 동안은 자동 표시하지 않고, 범위 밖으로 나가면 해제한다.
  const dismissedWildRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    proximityMarkerInfoRef.current = proximityMarkerInfo;
  }, [proximityMarkerInfo]);

  useEffect(() => {
    markerPanelRef.current = markerPanel;
  }, [markerPanel]);

  useEffect(() => {
    const isStyleReady =
      (mapStyle === "satellite" && isMapReady) ||
      (mapStyle === "globe" && isGlobeReady) ||
      (mapStyle === "cesium" && isCesiumReady);
    if (!playerLocation || !isStyleReady) {
      return;
    }

    // 축성 위치 지정 중에는 근접 패널을 열지 않는다.
    if (placementRef.current) {
      return;
    }

    let playerLat = playerLocation.lat;
    let playerLon = playerLocation.lon;

    const PROXIMITY_THRESHOLD = 5;
    const NEUTRAL_PROXIMITY_THRESHOLD_M = 15;
    let nearestMarker: MarkerPanel | null = null;

    if (DEBUG_PSEUDO_MARKER_ENABLED) {
      const debugMarkers = [
        {
          ref: pseudoMarkerRef,
          name: "디버그 마커",
          eventKey: DEBUG_PSEUDO_MARKER_EVENT_KEY,
          eventType: debugEventTypes?.[DEBUG_PSEUDO_MARKER_EVENT_KEY] ?? "QuizType",
          offsetLon: metersToLongitudeDelta(playerLat, DEBUG_PSEUDO_MARKER_OFFSET_METERS),
          offsetLat: 0,
          id: "debug1",
        },
        {
          ref: pseudoMarker2Ref,
          name: "디버그 마커2",
          eventKey: DEBUG_PSEUDO_MARKER2_EVENT_KEY,
          eventType: debugEventTypes?.[DEBUG_PSEUDO_MARKER2_EVENT_KEY] ?? "URLType",
          offsetLon: 0,
          offsetLat: metersToLatitudeDelta(DEBUG_PSEUDO_MARKER_OFFSET_METERS),
          id: "debug2",
        },
        {
          ref: pseudoMarker3Ref,
          name: "디버그 마커3",
          eventKey: DEBUG_PSEUDO_MARKER3_EVENT_KEY,
          eventType: debugEventTypes?.[DEBUG_PSEUDO_MARKER3_EVENT_KEY] ?? "URLType",
          offsetLon: -metersToLongitudeDelta(playerLat, DEBUG_PSEUDO_MARKER_OFFSET_METERS),
          offsetLat: 0,
          id: "debug3",
        },
      ];

      for (const marker of debugMarkers) {
        if (!marker.ref.current) continue;
        
        const markerLatLng = marker.ref.current.getLatLng();
        const markerLat = markerLatLng.lat;
        const markerLon = markerLatLng.lng;
        
        const distance = calculateDistance(playerLat, playerLon, markerLat, markerLon);
        
        if (distance <= PROXIMITY_THRESHOLD) {
          const visited = isVisitedEventKey(marker.eventKey);
          const visitedScore = getVisitedScore(marker.eventKey);
          const confirmTarget = visited ? undefined : buildEventPageTarget(marker.eventKey);
          nearestMarker = {
            title: marker.name,
            lines: [
              `이벤트 종류: ${getEventTypeLabel(marker.eventType)}`,
              ...(visited ? ["상태: 방문 완료"] : []),
              ...(visitedScore !== null ? [`획득 점수: ${visitedScore}점`] : []),
            ],
            eventKey: marker.eventKey,
            confirmTarget,
            confirmLabel: confirmTarget ? "실행" : undefined,
            isProximity: true,
          };
          break;
        }
      }
    }

    if (!nearestMarker) {
      // 무법자: 플레이어 본체 또는 아군 부대가 15m 이내면 공격 패널 자동 표시.
      // 마커 좌표는 최대 15초 전이므로 다리 보간으로 현재 위치를 계산한다.
      const nowMs = Date.now();
      const livePos = (m: { lat: number; lon: number; moveTarget: UnitMoveTargetMark | null }): { lat: number; lon: number } => {
        const t = m.moveTarget;
        if (!t || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) {
          return { lat: m.lat, lon: m.lon };
        }
        try {
          const pos = positionAtMoveTarget(
            {
              fromLat: t.fromLat,
              fromLon: t.fromLon,
              lat: t.lat,
              lon: t.lon,
              startedAt: t.startedAt,
              endsAt: t.endsAt,
              via: null,
              path: t.path ?? null,
            },
            nowMs,
          );
          return { lat: pos.lat, lon: pos.lon };
        } catch {
          return { lat: m.lat, lon: m.lon };
        }
      };
      // 무법자 표시 위치: 저장 경로 중 현재 다리 구간을 따라 보간한다.
      // (구간 기준이므로 전체 경로 매핑 시의 가짜 왕복이 생기지 않는다.)
      const wildLivePos = (m: { lat: number; lon: number; moveTarget: UnitMoveTargetMark | null }): { lat: number; lon: number } => {
        const t = m.moveTarget;
        if (!t || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) {
          return { lat: m.lat, lon: m.lon };
        }
        try {
          const sub = neutralLegSubpath(t.fromLat, t.fromLon, t.lat, t.lon, t.path ?? null, t.pathIdx ?? null);
          const pos = positionAtMoveTarget(
            {
              fromLat: t.fromLat,
              fromLon: t.fromLon,
              lat: t.lat,
              lon: t.lon,
              startedAt: t.startedAt,
              endsAt: t.endsAt,
              via: null,
              path: sub,
            },
            nowMs,
          );
          return { lat: pos.lat, lon: pos.lon };
        } catch {
          return { lat: m.lat, lon: m.lon };
        }
      };
      for (const mark of unitMarks) {
        if (!mark.id.startsWith("neutral-")) {
          continue;
        }
        if (!Number.isFinite(mark.lat) || !Number.isFinite(mark.lon)) {
          continue;
        }
        const wildId = Number.parseInt(mark.id.slice("neutral-".length), 10);
        if (!Number.isFinite(wildId)) {
          continue;
        }
        if (dismissedWildRef.current.has(wildId)) {
          // 닫은 무법자는 인식범위 안에 있는 동안 자동 표시하지 않는다.
          // 범위 밖으로 나가면 억제를 해제해 다음 조우 때 다시 알린다.
          const wildPos = wildLivePos(mark);
          const stillNear =
            calculateDistance(playerLat, playerLon, wildPos.lat, wildPos.lon) <=
              WILD_ATTACK_RANGE_M ||
            unitMarks.some((m) => {
              if (!m.mine || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) {
                return false;
              }
              const p = livePos(m);
              return (
                calculateDistance(p.lat, p.lon, wildPos.lat, wildPos.lon) <= WILD_ATTACK_RANGE_M
              );
            });
          if (!stillNear) {
            dismissedWildRef.current.delete(wildId);
          }
          continue;
        }
        const wildPos = wildLivePos(mark);
        const playerNear =
          calculateDistance(playerLat, playerLon, wildPos.lat, wildPos.lon) <= WILD_ATTACK_RANGE_M;
        const unitNear =
          !playerNear &&
          unitMarks.some((m) => {
            if (!m.mine || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) {
              return false;
            }
            const p = livePos(m);
            return calculateDistance(p.lat, p.lon, wildPos.lat, wildPos.lon) <= WILD_ATTACK_RANGE_M;
          });
        if (playerNear || unitNear) {
          const proxDist = Math.max(0, Math.round(calculateDistance(playerLat, playerLon, wildPos.lat, wildPos.lon)));
          nearestMarker = {
            title: `무법자 #${wildId}`,
            lines: [`이름: 무법자 #${wildId}`, "유형: 무법자", "상태: 배회 중", `거리: 약 ${proxDist}m (플레이어)`],
            wildId,
            lat: wildPos.lat,
            lon: wildPos.lon,
            isProximity: true,
            confirmTarget: "/map",
            confirmLabel: "공격",
          };
          break;
        }
      }
    }

    if (!nearestMarker) {
      for (const point of renderablePoiPoints) {
        const distance = calculateDistance(playerLat, playerLon, point.lat, point.lon);
        // 중립성은 진입 판정을 15m로 완화한다.
        const threshold = isNeutralEventKey(point.eventKey)
          ? NEUTRAL_PROXIMITY_THRESHOLD_M
          : PROXIMITY_THRESHOLD;

        if (distance <= threshold) {
          if (isNeutralEventKey(point.eventKey)) {
            nearestMarker = {
              ...buildNeutralPanel(point.label, point.eventKey),
              isProximity: true,
              confirmTarget: "/map",
              confirmLabel: "퀴즈 풀기",
            };
            break;
          }
          const visited = isVisitedEventKey(point.eventKey);
          const visitedScore = getVisitedScore(point.eventKey);
          const confirmTarget = visited ? undefined : buildEventPageTarget(point.eventKey);
          nearestMarker = {
            title: point.label || "이벤트 마커",
            lines: [
              `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
              ...(visited ? ["상태: 방문 완료"] : []),
              ...(visitedScore !== null ? [`획득 점수: ${visitedScore}점`] : []),
            ],
            eventKey: point.eventKey?.trim() || undefined,
            confirmTarget,
            confirmLabel: confirmTarget ? "실행" : undefined,
            isProximity: true,
          };
          break;
        }
      }
    }

    const currentProximityInfo = proximityMarkerInfoRef.current;
    const currentMarkerPanel = markerPanelRef.current;
    const currentIsProximity = Boolean(currentProximityInfo?.isProximity);
    
    if (nearestMarker) {
      const shouldSyncProximityInfo =
        !currentProximityInfo ||
        currentProximityInfo.title !== nearestMarker.title ||
        currentProximityInfo.lines[0] !== nearestMarker.lines[0];

      if (shouldSyncProximityInfo) {
        setProximityMarkerInfo(nearestMarker);
      }

      if (!currentMarkerPanel || currentMarkerPanel.isProximity) {
        const shouldSyncMarkerPanel =
          !currentMarkerPanel ||
          currentMarkerPanel.title !== nearestMarker.title ||
          currentMarkerPanel.lines[0] !== nearestMarker.lines[0] ||
          currentMarkerPanel.confirmTarget !== nearestMarker.confirmTarget;

        if (shouldSyncMarkerPanel) {
          setMarkerPanel(nearestMarker);
        }
      }
    } else if (currentProximityInfo && currentIsProximity) {
      setProximityMarkerInfo(null);
      if (currentMarkerPanel?.isProximity) {
        setMarkerPanel(null);
      }
    }
  }, [location, isMapReady, isGlobeReady, isCesiumReady, mapStyle, renderablePoiPoints, unitMarks, playerLocation, isVisitedEventKey, getVisitedScore]);

  // ---- 영토전 도보 가능 영역: 현재 동 + 인접 동 + 선택 동 로드 ----
  useEffect(() => {
    if (!territoryEnabled) {
      return;
    }
    const base = playerLocation;
    if (base) {
      // 위치를 도로 인덱스 ID로 변환해 현재 동과 인접 동을 로드한다.
      ensureWalkableData(base.lat, base.lon);
      ensureWalkableLocation(base.lat, base.lon);
    }
    if (selectedAdminCode) {
      // 한국 동 경계의 shapeID는 도로 격자 ID와 동일하다.
      ensureWalkableSelectedDong(selectedAdminCode);
    }
  }, [territoryEnabled, location, playerLocation, selectedAdminCode, adminGeoJson]);

  const getWalkableOverlayDongIds = (base: { lat: number; lon: number }): string[] => {
    const ids = new Set<string>();
    getWalkableDongIdsAt(base.lat, base.lon).forEach((id) => {
      ids.add(id);
      getAdjacentDongIds(id).forEach((adjacentId) => ids.add(adjacentId));
    });
    // 부대 이동 목표 지정 중에는 역삼각형 위치(지도 중앙) 주변도 표시한다.
    if (moveTargetCenter) {
      getWalkableDongIdsAt(moveTargetCenter.lat, moveTargetCenter.lon).forEach((id) => {
        ids.add(id);
        getAdjacentDongIds(id).forEach((adjacentId) => ids.add(adjacentId));
      });
    }
    if (selectedAdminCode) {
      ids.add(selectedAdminCode);
    }
    return [...ids];
  };

  // ---- 영토전 도로 오버레이: 로드 완료 시 다시 그리기 ----
  useEffect(() => {
    if (!territoryEnabled) {
      return;
    }
    // 로드 완료 알림이 폭주하면 리렌더 폭주로 이어지므로 300ms로 합친다.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeWalkableData(() => {
      if (timer !== null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        setWalkableTick((tick) => tick + 1);
      }, 300);
    });
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [territoryEnabled]);

  // ---- 영토전 도보 가능 영역 오버레이: 위성(Leaflet, 단일 캔버스) ----
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapInstanceRef.current;
    if (mapStyle !== "satellite" || !isMapReady || !map || !L) {
      if (mapStyle !== "satellite") {
        walkableLayerRef.current = null;
        walkableTilesRef.current = [];
      }
      return;
    }
    const base = playerLocation;
    if (!territoryEnabled || !base || zoomLevel < 15 || isWalkableDisabled()) {
      if (walkableLayerRef.current) {
        try {
          walkableLayerRef.current.remove();
        } catch {}
        walkableLayerRef.current = null;
      }
      walkableTilesRef.current = [];
      walkableBuiltSigRef.current = null;
      setWalkableLoadingOnce(false);
      return;
    }
    // 스피너는 그릴 게 하나도 없을 때만 켠다. 표시 중에는 절대 건드리지 않는다
    // (매 틱 켰다 끄면 깜빡임).
    ensureWalkableIndex();
    const overlayIds = getStableOverlayIds(base);
    for (const id of overlayIds) {
      ensureWalkableRaster(id);
    }
    const { tiles, pending } = getWalkableOverlayTilesBestEffort(overlayIds);
    setWalkablePendingOnce(overlayIds.length - pending.length, overlayIds.length);
    if (tiles.length === 0) {
      // 그릴 게 하나도 없을 때만 대기 표시한다 (부분 표시 우선).
      markWalkableWaiting();
      return;
    }
    setWalkableLoadingOnce(false);
    walkableTilesRef.current = tiles;
    const sig = `satellite:${tiles.map((grid) => grid.key).sort().join(",")}`;
    const layer = walkableLayerRef.current as unknown as { refresh?: () => void } | null;
    if (sig === walkableBuiltSigRef.current) {
      // 타일 집합이 같으면 레이어가 스스로 판단해 덧붙이거나 건너뛴다.
      try {
        layer?.refresh?.();
      } catch {}
      return;
    }
    walkableBuiltSigRef.current = sig;
    // 오버레이가 완성됐을 때만 2링 동을 idle에 IDB로 미리 받아둔다 (팬하면 즉시 표시).
    // 미완성 상태에서 프리페치하면 대역폭을 두고 경쟁한다.
    if (pending.length === 0) {
      try {
        const ring2 = new Set<string>(overlayIds);
        for (const id of overlayIds) {
          for (const neighbor of getAdjacentDongIds(id)) {
            ring2.add(neighbor);
          }
        }
        prefetchWalkableRasters([...ring2]);
      } catch {}
    }
    try {
      if (layer?.refresh) {
        layer.refresh();
      } else {
        if (walkableLayerRef.current) {
          try {
            walkableLayerRef.current.remove();
          } catch {}
          walkableLayerRef.current = null;
        }
        const created = createWalkableCanvasLayer(
          L as never,
          () => walkableTilesRef.current,
          WALKABLE_GRID_OPACITY,
          WALKABLE_BORDER_OPACITY,
        ) as { addTo: (map: unknown) => void; remove: () => void };
        created.addTo(map);
        walkableLayerRef.current = created;
      }
    } catch {}
  }, [mapStyle, isMapReady, territoryEnabled, walkableTick, location, playerLocation, selectedAdminCode, adminGeoJson, moveTargetCenter, zoomLevel]);

  // ---- 영토전 도보 가능 영역 오버레이: 글로브(MapLibre, 래스터 이미지) ----
  useEffect(() => {
    if (mapStyle !== "globe" || !isGlobeReady || !globeMapRef.current) {
      return;
    }
    const map = globeMapRef.current;
    const clearWalkableSource = (): void => {
      for (const createdId of walkableGlobeIdsRef.current) {
        try {
          if (map.getLayer(`${createdId}-layer`)) {
            map.removeLayer(`${createdId}-layer`);
          }
        } catch {}
        try {
          if (map.getSource(createdId)) {
            map.removeSource(createdId);
          }
        } catch {}
      }
      walkableGlobeIdsRef.current = [];
    };
    const base = playerLocation;
    if (!territoryEnabled || !base || zoomLevel < 15 || isWalkableDisabled()) {
      clearWalkableSource();
      walkableBuiltSigRef.current = null;
      setWalkableLoadingOnce(false);
      return;
    }
    ensureWalkableIndex();
    const overlayIds = getStableOverlayIds(base);
    for (const id of overlayIds) {
      ensureWalkableRaster(id);
    }
    const { tiles, pending } = getWalkableOverlayTilesBestEffort(overlayIds);
    setWalkablePendingOnce(overlayIds.length - pending.length, overlayIds.length);
    if (tiles.length === 0) {
      markWalkableWaiting();
      return;
    }
    setWalkableLoadingOnce(false);
    const tileSig = `globe:${tiles.map((grid) => grid.key).sort().join(",")}`;
    const composite = getWalkableCompositeUrls(tiles, () => {
      setWalkableTick((tick) => tick + 1);
    });
    // 타일 집합도 같고 그릴 준비 상태도 같으면 건너뛴다 (이미지 디코드 완료 시 tick으로 재진입).
    const drawnSig = composite ? `${tileSig}|${composite.fillUrl.length}:${composite.borderUrl.length}` : `${tileSig}|pending`;
    if (drawnSig === walkableBuiltSigRef.current) {
      return;
    }
    walkableBuiltSigRef.current = drawnSig;
    try {
      clearWalkableSource();
      if (!composite) {
        return;
      }
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
        [composite.west, composite.north],
        [composite.east, composite.north],
        [composite.east, composite.south],
        [composite.west, composite.south],
      ];
      const sourceId = `${WALKABLE_GLOBE_SOURCE_ID}-fill`;
      map.addSource(sourceId, { type: "image", url: composite.fillUrl, coordinates });
      map.addLayer({
        id: `${sourceId}-layer`,
        type: "raster",
        source: sourceId,
        paint: { "raster-opacity": WALKABLE_GRID_OPACITY, "raster-fade-duration": 0 },
      });
      walkableGlobeIdsRef.current.push(sourceId);
      const borderSourceId = `${WALKABLE_GLOBE_SOURCE_ID}-border`;
      map.addSource(borderSourceId, { type: "image", url: composite.borderUrl, coordinates });
      map.addLayer({
        id: `${borderSourceId}-layer`,
        type: "raster",
        source: borderSourceId,
        paint: { "raster-opacity": WALKABLE_BORDER_OPACITY, "raster-fade-duration": 0 },
      });
      walkableGlobeIdsRef.current.push(borderSourceId);
    } catch {}
  }, [mapStyle, isGlobeReady, territoryEnabled, walkableTick, location, playerLocation, selectedAdminCode, adminGeoJson, moveTargetCenter, zoomLevel]);

  // ---- 영토전 도보 가능 영역 오버레이: 3D(Cesium, 래스터 이미지) ----
  useEffect(() => {
    if (mapStyle !== "cesium" || !isCesiumReady || !cesiumViewerRef.current) {
      return;
    }
    const viewer = cesiumViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    const clearWalkableEntities = (): void => {
      for (const entity of cesiumWalkableEntitiesRef.current) {
        try {
          viewer.entities.remove(entity);
        } catch {}
      }
      cesiumWalkableEntitiesRef.current = [];
    };
    const base = playerLocation;
    if (!territoryEnabled || !base || zoomLevel < 15 || isWalkableDisabled()) {
      clearWalkableEntities();
      walkableBuiltSigRef.current = null;
      setWalkableLoadingOnce(false);
      return;
    }
    ensureWalkableIndex();
    const overlayIds = getStableOverlayIds(base);
    for (const id of overlayIds) {
      ensureWalkableRaster(id);
    }
    const { tiles, pending } = getWalkableOverlayTilesBestEffort(overlayIds);
    setWalkablePendingOnce(overlayIds.length - pending.length, overlayIds.length);
    if (tiles.length === 0) {
      markWalkableWaiting();
      return;
    }
    setWalkableLoadingOnce(false);
    const tileSig = `cesium:${tiles.map((grid) => grid.key).sort().join(",")}`;
    const composite = getWalkableCompositeUrls(tiles, () => {
      setWalkableTick((tick) => tick + 1);
    });
    const drawnSig = composite ? `${tileSig}|${composite.fillUrl.length}:${composite.borderUrl.length}` : `${tileSig}|pending`;
    if (drawnSig === walkableBuiltSigRef.current && cesiumWalkableEntitiesRef.current.length > 0) {
      return;
    }
    walkableBuiltSigRef.current = drawnSig;
    let cancelled = false;
    void (async () => {
      let Cesium: typeof import("cesium");
      try {
        Cesium = await loadCesium();
      } catch {
        return;
      }
      if (cancelled || cesiumViewerRef.current !== viewer || viewer.isDestroyed()) {
        return;
      }
      try {
        clearWalkableEntities();
        if (!composite) {
          return;
        }
        cesiumWalkableEntitiesRef.current.push(
          viewer.entities.add({
            rectangle: {
              coordinates: Cesium.Rectangle.fromDegrees(composite.west, composite.south, composite.east, composite.north),
              material: new Cesium.ImageMaterialProperty({
                image: composite.fillUrl,
                transparent: true,
                color: Cesium.Color.WHITE.withAlpha(WALKABLE_GRID_OPACITY),
              }),
            },
          }),
        );
        cesiumWalkableEntitiesRef.current.push(
          viewer.entities.add({
            rectangle: {
              coordinates: Cesium.Rectangle.fromDegrees(composite.west, composite.south, composite.east, composite.north),
              material: new Cesium.ImageMaterialProperty({
                image: composite.borderUrl,
                transparent: true,
                color: Cesium.Color.WHITE.withAlpha(WALKABLE_BORDER_OPACITY),
              }),
            },
          }),
        );
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [mapStyle, isCesiumReady, territoryEnabled, walkableTick, location, playerLocation, selectedAdminCode, adminGeoJson, moveTargetCenter, zoomLevel]);

  // 기반 타일 링 프리페치: 이동이 끝난 idle에 다음 팬 방향 1링을 미리 받아둔다.
  // (Leaflet keepBuffer는 2링으로 줄였고, 그 바깥 1링을 여기서 데워 회색 셀을 줄인다.)
  useEffect(() => {
    if (mapStyle !== "satellite" || !isMapReady || !mapInstanceRef.current) {
      return;
    }
    const map = mapInstanceRef.current;
    let cancelled = false;
    let idleHandle: number | null = null;
    const prefetchRing = (): void => {
      idleHandle = null;
      if (cancelled || typeof document === "undefined" || document.hidden) {
        return;
      }
      try {
        const layers = baseTileLayersRef.current;
        if (layers.length === 0) {
          return;
        }
        const zoom = map.getZoom();
        const bounds = map.getPixelBounds();
        const TILE = 256;
        const minX = bounds.min?.x ?? 0;
        const maxX = bounds.max?.x ?? 0;
        const minY = bounds.min?.y ?? 0;
        const maxY = bounds.max?.y ?? 0;
        const minTx = Math.floor(minX / TILE);
        const maxTx = Math.floor(maxX / TILE);
        const minTy = Math.floor(minY / TILE);
        const maxTy = Math.floor(maxY / TILE);
        const maxTile = 2 ** zoom - 1;
        const ring: Array<{ x: number; y: number; z: number }> = [];
        // 바깥 1링만 (Leaflet 버퍼와 겹치지 않게).
        for (let x = minTx - 3; x <= maxTx + 3; x += 1) {
          for (const y of [minTy - 3, maxTy + 3]) {
            if (y >= 0 && y <= maxTile) {
              ring.push({ x, y, z: zoom });
            }
          }
        }
        for (let y = minTy - 2; y <= maxTy + 2; y += 1) {
          if (y < 0 || y > maxTile) {
            continue;
          }
          for (const x of [minTx - 3, maxTx + 3]) {
            ring.push({ x, y, z: zoom });
          }
        }
        const urls: string[] = [];
        for (const layer of layers) {
          for (const coords of ring) {
            if (urls.length >= 48) {
              break;
            }
            try {
              urls.push(layer.getTileUrl(coords));
            } catch {
              // 타일 URL 생성 실패는 건너뛴다.
            }
          }
          if (urls.length >= 48) {
            break;
          }
        }
        for (const url of urls) {
          try {
            const img = new Image();
            img.decoding = "async";
            img.src = url;
          } catch {
            // 프리페치 실패는 무시한다 (Leaflet이 정식으로 다시 받는다).
          }
        }
      } catch {
        // bounds 계산 실패는 무시한다.
      }
    };
    const schedule = (): void => {
      if (cancelled || typeof window === "undefined") {
        return;
      }
      const ric = (
        window as unknown as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
          cancelIdleCallback?: (id: number) => void;
        }
      ).requestIdleCallback;
      if (typeof ric === "function") {
        if (idleHandle !== null) {
          try {
            (
              window as unknown as { cancelIdleCallback?: (id: number) => void }
            ).cancelIdleCallback?.(idleHandle);
          } catch {}
        }
        idleHandle = ric.call(window, prefetchRing, { timeout: 5000 });
      } else {
        window.setTimeout(prefetchRing, 1000);
      }
    };
    map.on("moveend", schedule);
    schedule();
    return () => {
      cancelled = true;
      try {
        map.off("moveend", schedule);
      } catch {}
    };
  }, [mapStyle, isMapReady]);

  useEffect(() => {
    if (!isMapReady || !mapInstanceRef.current) {
      return;
    }

    const map = mapInstanceRef.current;
    const syncZoomLevel = () => {
      setZoomLevel(map.getZoom());
    };
    const syncAdminViewport = () => {
      try {
        const c = map.getCenter();
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          updateAdminViewport(c.lat, c.lng);
        }
      } catch {}
    };

    syncZoomLevel();
    syncAdminViewport();
    map.on("zoomend", syncZoomLevel);
    map.on("moveend", syncZoomLevel);
    map.on("moveend", syncAdminViewport);

    return () => {
      map.off("zoomend", syncZoomLevel);
      map.off("moveend", syncZoomLevel);
      map.off("moveend", syncAdminViewport);
    };
  }, [isMapReady, updateAdminViewport]);

  useEffect(() => {
    if (mapStyle !== "globe" || !isGlobeReady || !globeMapRef.current) {
      return;
    }
    const map = globeMapRef.current as unknown as {
      getZoom?: () => number;
      on?: (event: string, handler: () => void) => void;
      off?: (event: string, handler: () => void) => void;
    };
    const syncGlobeZoom = () => {
      try {
        const raw = map.getZoom?.();
        if (typeof raw === "number" && Number.isFinite(raw)) {
          const clamped = Math.min(GLOBE_ZOOM_RANGE.max, Math.max(GLOBE_ZOOM_RANGE.min, Math.round(raw)));
          setZoomLevel((prev) => (prev === clamped ? prev : clamped));
        }
      } catch {}
    };
    const syncGlobeViewport = () => {
      try {
        const globeMap = globeMapRef.current;
        const c = globeMap?.getCenter?.();
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          updateAdminViewport(c.lat, c.lng);
        }
      } catch {}
    };
    syncGlobeZoom();
    syncGlobeViewport();
    try {
      map.on?.("zoomend", syncGlobeZoom);
      map.on?.("zoom", syncGlobeZoom);
      map.on?.("moveend", syncGlobeViewport);
    } catch {}
    return () => {
      try {
        map.off?.("zoomend", syncGlobeZoom);
        map.off?.("zoom", syncGlobeZoom);
        map.off?.("moveend", syncGlobeViewport);
      } catch {}
    };
  }, [mapStyle, isGlobeReady, updateAdminViewport]);

  useEffect(() => {
    if (mapStyle !== "cesium" || !isCesiumReady || !cesiumViewerRef.current) {
      return;
    }
    const viewer = cesiumViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    const syncCesiumZoom = () => {
      try {
        const height = viewer.camera.positionCartographic.height;
        if (!Number.isFinite(height) || height <= 0) {
          return;
        }
        const rawZoom = 19 - Math.log2(Math.max(1, height) / 1000);
        const clamped = Math.min(CESIUM_ZOOM_RANGE.max, Math.max(CESIUM_ZOOM_RANGE.min, Math.round(rawZoom)));
        setZoomLevel((prev) => (prev === clamped ? prev : clamped));
      } catch {}
      try {
        const CesiumLib = (window as unknown as { Cesium?: typeof import("cesium") }).Cesium;
        const canvas = viewer.scene.canvas as HTMLCanvasElement;
        if (CesiumLib && canvas) {
          const centerPixel = new CesiumLib.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
          const cartesian = viewer.camera.pickEllipsoid(centerPixel, viewer.scene.globe.ellipsoid);
          if (cartesian) {
            const carto = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
            const lat = CesiumLib.Math.toDegrees(carto.latitude);
            const lon = CesiumLib.Math.toDegrees(carto.longitude);
            updateAdminViewport(lat, lon);
            return;
          }
        }
        const fallback = viewer.camera.positionCartographic;
        updateAdminViewport(
          (window as unknown as { Cesium?: typeof import("cesium") }).Cesium?.Math.toDegrees(fallback.latitude) ?? 0,
          (window as unknown as { Cesium?: typeof import("cesium") }).Cesium?.Math.toDegrees(fallback.longitude) ?? 0,
        );
      } catch {}
    };
    syncCesiumZoom();
    let remove: (() => void) | null = null;
    try {
      remove = viewer.camera.moveEnd.addEventListener(syncCesiumZoom);
    } catch {}
    return () => {
      if (remove) {
        try {
          remove();
        } catch {}
      }
    };
  }, [mapStyle, isCesiumReady, updateAdminViewport]);

  useEffect(() => {
    if (!isMapReady || !mapInstanceRef.current || clusterUnits.length === 0) {
      setEdgeIndicators((previousIndicators) => (previousIndicators.length === 0 ? previousIndicators : []));
      return;
    }

    const map = mapInstanceRef.current;
    const pointById = new Map<number, MapPoint>();
    for (const point of renderablePoiPoints) {
      pointById.set(point.id, point);
    }

    const updateEdgeIndicators = () => {
      const size = map.getSize();
      const width = size.x;
      const height = size.y;
      const padding = 34;
      const toolbarHeight = bottomToolbarRef.current?.offsetHeight ?? EDGE_INDICATOR_FALLBACK_TOOLBAR_HEIGHT;
      const bottomReserved = Math.max(0, toolbarHeight + EDGE_INDICATOR_BOTTOM_SAFE_GAP);
      const minX = padding;
      const maxX = width - padding;
      const minY = padding;
      const maxY = Math.max(minY + 1, height - padding - bottomReserved);

       const playerReference = playerLocation;

      const nextIndicators: EdgeIndicator[] = [];

      for (const cluster of clusterUnits) {
        const candidateIds = cluster.id
          .split("-")
          .map((value) => Number.parseInt(value, 10))
          .filter(Number.isFinite);

        const unvisitedCandidates: MapPoint[] = [];
        for (const pointId of candidateIds) {
          const candidate = pointById.get(pointId);
          if (!candidate) {
            continue;
          }
          if (isVisitedEventKey(candidate.eventKey)) {
            continue;
          }
          unvisitedCandidates.push(candidate);
        }

        if (unvisitedCandidates.length === 0) {
          continue;
        }

        const representativeLat =
          unvisitedCandidates.reduce((sum, candidate) => sum + candidate.lat, 0) /
          unvisitedCandidates.length;
        const representativeLon =
          unvisitedCandidates.reduce((sum, candidate) => sum + candidate.lon, 0) /
          unvisitedCandidates.length;

        const point = map.latLngToContainerPoint([representativeLat, representativeLon]);
        const isInside = point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
        if (isInside) {
          continue;
        }

        const projected = projectToEdge(width, height, point.x, point.y, padding, {
          minX,
          maxX,
          minY,
          maxY,
        });
        if (!projected) {
          continue;
        }

        let nearestDistanceMeters: number | null = null;
        if (playerReference) {
          for (const candidate of unvisitedCandidates) {
            const distance = calculateDistance(
              playerReference.lat,
              playerReference.lon,
              candidate.lat,
              candidate.lon
            );

            nearestDistanceMeters =
              nearestDistanceMeters === null ? distance : Math.min(nearestDistanceMeters, distance);
          }

          if (nearestDistanceMeters === null) {
            nearestDistanceMeters = calculateDistance(
              playerReference.lat,
              playerReference.lon,
              representativeLat,
              representativeLon
            );
          }
        }

        nextIndicators.push({
          id: unvisitedCandidates
            .map((candidate) => candidate.id)
            .sort((a, b) => a - b)
            .join("-"),
          left: projected.left,
          top: projected.top,
          angle: projected.angle,
          count: unvisitedCandidates.length,
          nearestDistanceMeters,
        });
      }

      const browserWidth =
        typeof window !== "undefined" && Number.isFinite(window.innerWidth) && window.innerWidth > 0
          ? window.innerWidth
          : width;
      const mergedIndicators = mergeOverlappingIndicators(nextIndicators, browserWidth);
      setEdgeIndicators((previousIndicators) => {
        if (previousIndicators.length !== mergedIndicators.length) {
          return mergedIndicators;
        }

        const hasDifference = previousIndicators.some((indicator, index) => {
          const next = mergedIndicators[index];
          return (
            indicator.id !== next.id ||
            indicator.count !== next.count ||
            Math.abs(indicator.left - next.left) > 0.01 ||
            Math.abs(indicator.top - next.top) > 0.01 ||
            Math.abs(indicator.angle - next.angle) > 0.01 ||
            Math.abs((indicator.nearestDistanceMeters ?? -1) - (next.nearestDistanceMeters ?? -1)) > 0.1
          );
        });

        return hasDifference ? mergedIndicators : previousIndicators;
      });
    };

    let rafId = 0;
    let trailingId = 0;
    let lastRun = 0;
    // 드래그 중 매 프레임 setState하면 지도 전체가 리렌더돼 버벅인다.
    // 이동 중에는 trailing 250ms로 묶고, 이동 종료 시점에 즉시 갱신한다.
    const EDGE_UPDATE_MIN_INTERVAL = 250;
    const runUpdate = (): void => {
      lastRun = typeof performance !== "undefined" ? performance.now() : Date.now();
      cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(updateEdgeIndicators);
    };
    const scheduleUpdate = () => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastRun >= EDGE_UPDATE_MIN_INTERVAL) {
        lastRun = now;
        window.clearTimeout(trailingId);
        cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(updateEdgeIndicators);
        return;
      }
      window.clearTimeout(trailingId);
      trailingId = window.setTimeout(runUpdate, EDGE_UPDATE_MIN_INTERVAL - (now - lastRun));
    };
    const scheduleImmediate = (): void => {
      window.clearTimeout(trailingId);
      runUpdate();
    };

    updateEdgeIndicatorsRef.current = scheduleUpdate;

    updateEdgeIndicators();
    map.on("move", scheduleUpdate);
    map.on("zoom", scheduleUpdate);
    map.on("moveend", scheduleImmediate);
    map.on("rotate", scheduleUpdate);
    map.on("rotateend", scheduleImmediate);
    map.on("resize", scheduleImmediate);

    return () => {
      window.clearTimeout(trailingId);
      cancelAnimationFrame(rafId);
      updateEdgeIndicatorsRef.current = null;
      map.off("move", scheduleUpdate);
      map.off("zoom", scheduleUpdate);
      map.off("moveend", scheduleImmediate);
      map.off("rotate", scheduleUpdate);
      map.off("rotateend", scheduleImmediate);
      map.off("resize", scheduleImmediate);
    };
  }, [clusterUnits, isMapReady, isVisitedEventKey, playerLocation, location, renderablePoiPoints]);

  useEffect(() => {
    if (!isMapReady || clusterUnits.length === 0) {
      return;
    }

    const rotationTick = isHeadingUpMode ? mapRotationDeg : 0;
    if (!Number.isFinite(rotationTick)) {
      return;
    }

    updateEdgeIndicatorsRef.current?.();
  }, [isHeadingUpMode, mapRotationDeg, isMapReady, clusterUnits.length]);

  const statusLabel = useMemo(() => {
    if (status === "loading") return "위치 가져오는 중";
    if (status === "success") return "현재 위치 확인됨";
    if (status === "error") return "위치 확인 실패";
    return "대기 중";
  }, [status]);

  const subtitle = useMemo(() => {
    if (status === "loading") return "브라우저에서 위치 권한을 확인하는 중입니다";
    if (status === "error") return errorMessage ?? "알 수 없는 오류";
    if (tileError) return tileError;
    if (status === "success") return "지도의 중앙에 현재 위치를 표시했습니다";
    return "위치 초기화 중";
  }, [errorMessage, status, tileError]);

  const formattedScore = useMemo(() => {
    const numericScore = typeof playerScore === "number" ? playerScore : 0;
    return Math.max(0, Math.floor(numericScore)).toLocaleString("ko-KR");
  }, [playerScore]);

  useEffect(() => {
    setCompassIconDataUrl(createThreeCompassDataUrl());
  }, [createThreeCompassDataUrl]);

  useEffect(() => {
    setEdgeIndicatorIconDataUrl(createThreeEdgeIndicatorDataUrl());
  }, [createThreeEdgeIndicatorDataUrl]);

  const mapVisualRotationDeg = isHeadingUpMode ? mapRotationDeg : 0;

  const resolveIndicatorEdge = useCallback((indicator: EdgeIndicator): "left" | "right" | "top" | "bottom" => {
    const container = mapContainerRef.current;
    const width = container?.clientWidth ?? (typeof window !== "undefined" ? window.innerWidth : 0);
    const height = container?.clientHeight ?? (typeof window !== "undefined" ? window.innerHeight : 0);

    const distLeft = indicator.left;
    const distRight = Math.max(0, width - indicator.left);
    const distTop = indicator.top;
    const distBottom = Math.max(0, height - indicator.top);

    let edge: "left" | "right" | "top" | "bottom" = "left";
    let best = distLeft;

    if (distRight < best) {
      edge = "right";
      best = distRight;
    }

    if (distTop < best) {
      edge = "top";
      best = distTop;
    }

    if (distBottom < best) {
      edge = "bottom";
    }

    return edge;
  }, []);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!isMapReady || !map) {
      return;
    }

    map.setBearing(isHeadingUpMode ? mapRotationDeg : 0);
  }, [isHeadingUpMode, isMapReady, mapRotationDeg]);

  useEffect(() => {
    const bearing = isHeadingUpMode ? -mapRotationDeg : 0;
    const globeMap = globeMapRef.current as unknown as {
      setBearing?: (bearing: number) => void;
      easeTo?: (options: { bearing?: number }) => void;
    } | null;
    if (globeMap) {
      try {
        if (typeof globeMap.setBearing === "function") {
          globeMap.setBearing(bearing);
        } else if (typeof globeMap.easeTo === "function") {
          globeMap.easeTo({ bearing });
        }
      } catch {}
    }
    const viewer = cesiumViewerRef.current;
    if (viewer && !viewer.isDestroyed()) {
      try {
        const Cesium = (window as unknown as { Cesium?: typeof import("cesium") })?.Cesium;
        if (Cesium) {
          const targetHeading = Cesium.Math.toRadians(bearing);
          const carto = viewer.camera.positionCartographic;
          viewer.camera.setView({
            destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
            orientation: {
              heading: targetHeading,
              pitch: viewer.camera.pitch,
              roll: viewer.camera.roll,
            },
          });
        }
      } catch {}
    }
  }, [isHeadingUpMode, mapRotationDeg, isGlobeReady, isCesiumReady]);

  const triggerNavigation = useCallback(
    (target: string) => {
      if (target.startsWith("http")) {
        window.location.href = target;
        return;
      }

      router.push(target);
    },
    [router]
  );

  // 영토전 GPS-free + 시작 위치 확정 시에는 위치 오버레이를 띄우지 않는다.
  const showOverlay =
    (status !== "success" && !(territoryEnabled && territoryStart)) || Boolean(tileError);

  useEffect(() => {
    if (!isMapReady) {
      return;
    }

    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L) {
      return;
    }

    const layer = ensureNearbyPlayerLayer();
    if (!layer) {
      return;
    }

    const markerMap = nearbyPlayerMarkerMapRef.current;
    let cancelled = false;

    const syncNearbyPlayers = async () => {
      if (cancelled) {
        return;
      }

      // 기록 우선순위: GPS > 영토전 시작 위치.
      // 영토전 GPS-free에서도 체크인·주변 플레이어용으로 시작 위치를 기록한다.
      const startLocation =
        territoryEnabled && territoryStart
          ? { lat: territoryStart.lat, lon: territoryStart.lon, accuracy: undefined as number | undefined }
          : null;
      // 영토전 GPS-free 모드에서는 실시간 GPS를 서버에 올리지 않는다 (시작 위치만 사용).
      const currentLocation = territoryEnabled
        ? startLocation
        : locationRef.current ?? startLocation;
      if (!currentLocation) {
        return;
      }

      const baseLocation = currentLocation;

      const previousWriteLocation = lastLocationWriteRef.current;
      const movedDistance = previousWriteLocation
        ? calculateDistance(
            previousWriteLocation.lat,
            previousWriteLocation.lon,
            baseLocation.lat,
            baseLocation.lon
          )
        : Number.POSITIVE_INFINITY;
      const shouldWriteLocation = movedDistance >= PLAYER_LOCATION_MIN_MOVE_METERS;

      if (shouldWriteLocation) {
        try {
          const response = await fetch("/api/player-location", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              lat: baseLocation.lat,
              lon: baseLocation.lon,
              // 영토전 GPS-free면 시작 위치를 기록한다.
              source:
                startLocation &&
                      baseLocation.lat === startLocation.lat &&
                      baseLocation.lon === startLocation.lon
                    ? "start"
                    : "gps",
              accuracy: currentLocation.accuracy ?? null,
            }),
          });

          if (response.ok) {
            lastLocationWriteRef.current = {
              lat: baseLocation.lat,
              lon: baseLocation.lon,
            };
          }
        } catch {
        }
      }

      if (cancelled) {
        return;
      }

      let bounds: ReturnType<typeof map.getBounds>;
      try {
        bounds = map.getBounds();
      } catch {
        // 언마운트(페이지 이동) 후 해제된 지도 접근은 무시한다.
        return;
      }
      if (typeof (bounds as unknown as { pad?: (ratio: number) => typeof bounds }).pad === "function") {
        bounds = (bounds as unknown as { pad: (ratio: number) => typeof bounds }).pad(
          NEARBY_PLAYERS_BOUNDS_PAD_RATIO
        );
      }

      const query = new URLSearchParams({
        north: bounds.getNorth().toString(),
        south: bounds.getSouth().toString(),
        east: bounds.getEast().toString(),
        west: bounds.getWest().toString(),
        sinceSec: NEARBY_PLAYERS_SINCE_SEC.toString(),
        limit: NEARBY_PLAYERS_LIMIT.toString(),
      });

      try {
        const response = await fetch(`/api/nearby-players?${query.toString()}`);
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { players?: NearbyPlayer[] };
        const players = Array.isArray(payload.players) ? payload.players : [];
        const nextIds = new Set(players.map((player) => player.userId));

        markerMap.forEach((entry, id) => {
          if (!nextIds.has(id)) {
            entry.marker.remove();
            entry.dispose();
            markerMap.delete(id);
          }
        });

        players.forEach((player) => {
          if (!Number.isFinite(player.lat) || !Number.isFinite(player.lon)) {
            return;
          }

          const position: [number, number] = [player.lat, player.lon];
          const selectedCharacter = parseNearbyPlayerCharacter(player.selectedCharacter);
          const existing = markerMap.get(player.userId);
          if (existing && existing.selectedCharacter !== selectedCharacter) {
            existing.marker.remove();
            existing.dispose();
            markerMap.delete(player.userId);
          }

          const currentEntry = markerMap.get(player.userId);
          if (!currentEntry) {
            const markerVisual = createNearbyPlayerMarkerVisual(selectedCharacter);
            if (!markerVisual) {
              return;
            }

            const marker = L.marker(position, { icon: markerVisual.icon }).addTo(layer);
            marker.bindTooltip(player.nickname || "PLAYER", {
              permanent: true,
              direction: "top",
              offset: [0, POI_LABEL_OFFSET_Y],
              className: "map-player-label",
            });

            markerMap.set(player.userId, {
              marker,
              dispose: markerVisual.dispose,
              selectedCharacter,
            });
            return;
          }

          currentEntry.marker.setLatLng(position);
          currentEntry.marker.setTooltipContent(player.nickname || "PLAYER");
        });
      } catch {
      }
    };

    const timerId = window.setInterval(() => {
      void syncNearbyPlayers();
    }, NEARBY_PLAYERS_POLL_INTERVAL_MS);

    void syncNearbyPlayers();

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
      markerMap.forEach((entry) => {
        entry.marker.remove();
        entry.dispose();
      });
      markerMap.clear();
    };
  }, [createNearbyPlayerMarkerVisual, ensureNearbyPlayerLayer, isMapReady, parseNearbyPlayerCharacter]);

  const getTerritoryCenter = useCallback((): { lat: number; lon: number } | null => {
    try {
      const map = mapInstanceRef.current as unknown as {
        getCenter?: () => { lat?: unknown; lng?: unknown } | null;
      } | null;
      const center = map?.getCenter?.() ?? null;
      if (!center) {
        return null;
      }
      const lat = typeof center.lat === "number" ? center.lat : Number(center.lat);
      const lon = typeof center.lng === "number" ? center.lng : Number(center.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }
      return { lat, lon };
    } catch {
      return null;
    }
  }, []);

  // 플레이어 위치 (조이스틱 기점 우선). 게임 로직은 이 getter만 쓴다.
  const getPlayerLocation = useCallback((): { lat: number; lon: number } | null => {
    if (!playerLocation) {
      return null;
    }
    return { lat: playerLocation.lat, lon: playerLocation.lon };
  }, [playerLocation]);

  const isTerritoryVisible = useCallback(
    (lat: number, lon: number): boolean => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return true;
      }
      try {
        if (mapStyle === "globe" && globeMapRef.current) {
          const bounds = (
            globeMapRef.current as unknown as {
              getBounds?: () => { contains?: (p: [number, number]) => unknown } | null;
            }
          ).getBounds?.();
          const contains = bounds?.contains?.([lon, lat]);
          return typeof contains === "boolean" ? contains : true;
        }
        if (mapStyle === "cesium" && cesiumViewerRef.current) {
          const viewer = cesiumViewerRef.current as unknown as {
            isDestroyed?: () => boolean;
            scene?: { globe?: { ellipsoid?: unknown } };
            camera?: {
              computeViewRectangle?: (ellipsoid?: unknown) => {
                west?: unknown;
                south?: unknown;
                east?: unknown;
                north?: unknown;
              } | null;
            };
          };
          const CesiumLib = (
            window as unknown as {
              Cesium?: {
                Math?: { toDegrees?: (rad: number) => number };
                Rectangle?: { contains?: (...args: never[]) => unknown };
                Cartographic?: { fromDegrees?: (lon: number, lat: number) => unknown };
              };
            }
          ).Cesium;
          if (!viewer || viewer.isDestroyed?.()) {
            return true;
          }
          const rect = viewer.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
          const toDeg = CesiumLib?.Math?.toDegrees;
          if (
            rect &&
            typeof rect.west === "number" &&
            typeof rect.east === "number" &&
            typeof rect.south === "number" &&
            typeof rect.north === "number" &&
            typeof toDeg === "function"
          ) {
            const west = toDeg(rect.west);
            const east = toDeg(rect.east);
            const south = toDeg(rect.south);
            const north = toDeg(rect.north);
            const inLon = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
            return inLon && lat >= south && lat <= north;
          }
          return true;
        }
        const map = mapInstanceRef.current as unknown as {
          getBounds?: () => { contains?: (p: [number, number]) => unknown } | null;
        } | null;
        const bounds = map?.getBounds?.();
        const contains = bounds?.contains?.([lat, lon]);
        return typeof contains === "boolean" ? contains : true;
      } catch {
        return true;
      }
    },
    [mapStyle],
  );

  const panTerritoryTo = useCallback(
    (lat: number, lon: number): void => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return;
      }
      if (mapStyle === "cesium" && cesiumViewerRef.current) {
        try {
          const viewer = cesiumViewerRef.current as unknown as {
            isDestroyed?: () => boolean;
            camera?: {
              positionCartographic?: { height?: unknown };
              setView?: (options: { destination?: unknown }) => void;
            };
          };
          const CesiumLib = (
            window as unknown as {
              Cesium?: { Cartesian3?: { fromDegrees?: (lon: number, lat: number, h: number) => unknown } };
            }
          ).Cesium;
          if (viewer && !viewer.isDestroyed?.() && CesiumLib?.Cartesian3?.fromDegrees) {
            const rawHeight = viewer.camera?.positionCartographic?.height;
            const height = typeof rawHeight === "number" && Number.isFinite(rawHeight) ? rawHeight : 5000;
            viewer.camera?.setView?.({
              destination: CesiumLib.Cartesian3.fromDegrees(lon, lat, height),
            });
            return;
          }
        } catch {
          // ignore
        }
      }
      if (mapStyle === "globe" && globeMapRef.current) {
        try {
          globeMapRef.current.easeTo({ center: [lon, lat] });
        } catch {
          try {
            globeMapRef.current.setCenter([lon, lat]);
          } catch {
            // ignore
          }
        }
        return;
      }
      const map = mapInstanceRef.current;
      if (map) {
        try {
          map.panTo([lat, lon], { animate: true });
        } catch {
          try {
            map.setView([lat, lon], map.getZoom());
          } catch {
            // ignore
          }
        }
      }
    },
    [mapStyle],
  );

  const castlePoints = useMemo(
    () =>
      (points ?? [])
        .filter((p) => (p.eventKey ?? "").trim().startsWith("castle-"))
        .map((p) => ({
          eventKey: (p.eventKey ?? "").trim(),
          lat: p.lat,
          lon: p.lon,
          label: p.label ?? "",
        })),
    [points]
  );

  // 영토전: 부대 마커 레이어 (이동 중 깜빡임 방지: 마커 재사용 + 위치만 갱신)
  useEffect(() => {
    if (!territoryEnabled || !isMapReady) {
      return;
    }
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L) {
      return;
    }
    if (!unitLayerRef.current) {
      unitLayerRef.current = L.layerGroup().addTo(map);
    }
    const seen = new Set<string>();
    const esc = (value: string): string =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    for (const mark of unitMarks) {
      if (!Number.isFinite(mark.lat) || !Number.isFinite(mark.lon)) {
        continue;
      }
      // 줌 15 미만에서는 무법자를 숨긴다 (중립성·성과 동일 조건).
      if (zoomLevel < 15 && mark.id.startsWith("neutral-")) {
        continue;
      }
      seen.add(mark.id);
      const existing = unitMarkerMapRef.current.get(mark.id);
      // 플레이어 캐릭터처럼 이동 방향(경도 증감)에 따라 좌우 반전한다.
      const prevFacing = unitFacingRef.current.get(mark.id);
      let facingLeft = prevFacing?.left ?? false;
      if (prevFacing && Math.abs(mark.lon - prevFacing.lon) > 1e-7) {
        facingLeft = mark.lon < prevFacing.lon;
      }
      unitFacingRef.current.set(mark.id, { lon: mark.lon, left: facingLeft });
      const applyUnitFacing = (marker: Marker): void => {
        const img = marker.getElement()?.querySelector<HTMLImageElement>("img.territory-soldier-idle, img.territory-outlaw");
        if (img) {
          // 병사 스프라이트 기본 방향이 왼쪽이므로 플레이어와 반대로 뒤집는다.
          // 무법자는 기본 방향이 오른쪽이라 플레이어와 동일하게 뒤집는다.
          const isOutlaw = img.classList.contains("territory-outlaw");
          const next = facingLeft
            ? isOutlaw
              ? "scaleX(-1)"
              : "scaleX(1)"
            : isOutlaw
              ? "scaleX(1)"
              : "scaleX(-1)";
          if (img.style.transform !== next) {
            img.style.transform = next;
          }
        }
      };
      const applyUnitWalk = (marker: Marker): void => {
        const img = marker.getElement()?.querySelector<HTMLImageElement>("img.territory-soldier-idle, img.territory-outlaw");
        if (img) {
          const next = mark.moving ? "1" : "0";
          if (img.dataset.walk !== next) {
            img.dataset.walk = next;
          }
        }
      };
      if (existing) {
        // 지도가 직접 애니메이션 중인 타인 부대는 서버 스냅샷으로 위치를 덮어쓰지 않는다.
        const mapAnim = !mark.mine ? otherUnitMoveAnimRef.current.get(mark.id) : undefined;
        const mapAnimHold = !!mapAnim && (mapAnim.path !== null || mapAnim.done);
        if (!mapAnimHold) {
          const cur = existing.getLatLng();
          if (Math.abs(cur.lat - mark.lat) > 1e-7 || Math.abs(cur.lng - mark.lon) > 1e-7) {
            existing.setLatLng([mark.lat, mark.lon]);
          }
        }
        applyUnitFacing(existing);
        applyUnitWalk(existing);
        const el = existing.getElement()?.querySelector(".unit-pin span");
        if (el && el.textContent !== mark.name) {
          el.textContent = mark.name;
        }
        const pin = existing.getElement()?.querySelector(".unit-pin");
        if (pin) {
          pin.classList.toggle("unit-pin-enemy", !mark.mine);
          pin.classList.toggle("unit-pin-selected", mark.selected);
        }
        continue;
      }
      const icon = L.divIcon({
        className: "map-unit-marker",
        html: `<div class="unit-pin${mark.mine ? "" : " unit-pin-enemy"}${mark.selected ? " unit-pin-selected" : ""} map-rotation-upright">${mark.id.startsWith("neutral-") ? territoryOutlawAnimationMarkup() : territorySoldierAnimationMarkup()}<span>${esc(mark.name)}</span></div>`,
        iconSize: [72, 68],
        iconAnchor: [36, 26],
      });
      // 무법자: 탭하면 정보 패널 (15m 인접 시 공격 버튼).
      const isNeutralMark = mark.id.startsWith("neutral-");
      const marker = L.marker([mark.lat, mark.lon], { icon, interactive: mark.mine || isNeutralMark }).addTo(unitLayerRef.current);
      if (mark.mine) {
        marker.on("click", () => handleUnitMarkerClick(mark.id));
      } else if (isNeutralMark) {
        marker.on("click", () => {
          const wildId = Number.parseInt(mark.id.slice("neutral-".length), 10);
          if (!Number.isFinite(wildId)) {
            return;
          }
          // 마커는 폴링과 무관하게 재사용되므로 클로저 mark는 오래된 데이터일 수 있다.
          // 탭 시점의 최신 스냅샷으로 경로·위치를 조회한다.
          const freshMark = unitMarksRef.current.find((m) => m.id === mark.id) ?? mark;
          applyHostileInstant(marker, mark.id);
          // 패널 좌표는 폴링 시점 좌표가 아닌 현재 보간 위치를 사용한다
          // (그렇지 않으면 출발 지점으로 화면이 이동하고 버튼이 잘못 표시된다).
          // 마커 애니메이션과 같은 저장 경로 구간을 따라 보간해 표시 위치와 일치시킨다.
          let liveLat = freshMark.lat;
          let liveLon = freshMark.lon;
          try {
            const t = freshMark.moveTarget;
            if (t && Number.isFinite(t.lat) && Number.isFinite(t.lon) && Date.now() < t.endsAt) {
              const sub = neutralLegSubpath(t.fromLat, t.fromLon, t.lat, t.lon, t.path ?? null, t.pathIdx ?? null);
              const pos = positionAtMoveTarget(
                {
                  fromLat: t.fromLat,
                  fromLon: t.fromLon,
                  lat: t.lat,
                  lon: t.lon,
                  startedAt: t.startedAt,
                  endsAt: t.endsAt,
                  via: null,
                  path: sub,
                },
                Date.now(),
              );
              if (Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
                liveLat = pos.lat;
                liveLon = pos.lon;
              }
            }
          } catch {
            // 폴백: 폴링 좌표 유지
          }
          const tapLoc = getPlayerLocation();
          const tapDist =
            tapLoc && Number.isFinite(tapLoc.lat) && Number.isFinite(tapLoc.lon)
              ? Math.max(0, Math.round(calculateDistance(tapLoc.lat, tapLoc.lon, liveLat, liveLon)))
              : null;
          setWildRouteWildId(wildId);
          setWildRoutePath(wildPathPoints(freshMark.moveTarget as UnitMoveTargetMark | null));
          showMarkerPanel({
            title: `무법자 #${wildId}`,
            lines: [
              `이름: 무법자 #${wildId}`,
              "유형: 무법자",
              "상태: 배회 중",
              ...(tapDist !== null ? [`거리: 약 ${tapDist}m (플레이어)`] : []),
            ],
            wildId,
            lat: liveLat,
            lon: liveLon,
          });
        });
      }
      registerTerritorySoldierAnimation(marker.getElement() ?? null);
      applyUnitFacing(marker);
      applyUnitWalk(marker);
      unitMarkerMapRef.current.set(mark.id, marker);
    }
    const removedOutlaws: string[] = [];
    for (const [id, marker] of [...unitMarkerMapRef.current]) {
      if (!seen.has(id)) {
        if (id.startsWith("neutral-")) {
          removedOutlaws.push(id);
        }
        unitLayerRef.current.removeLayer(marker);
        unitMarkerMapRef.current.delete(id);
        unitFacingRef.current.delete(id);
      }
    }
    if (removedOutlaws.length > 0 && isMapPerfEnabled()) {
      console.log(
        `[perf] outlaw removed=${removedOutlaws.length} marks=${unitMarks.length} zoom=${zoomLevel} ids=${removedOutlaws.slice(0, 5).join(",")}`,
      );
    }
  }, [territoryEnabled, isMapReady, unitMarks, zoomLevel, handleUnitMarkerClick, showMarkerPanel]);

  // 영토전: 타인 부대 이동을 서버 주문서 기준으로 직접 애니메이션한다.
  // 서버 권위: 주문서에 확정 경로(path)가 들어있어 보는 쪽 재계산이 필요 없다.
  // (리로드 후 전체경로 A*가 여기서 돌아 프리징의 원인이었음)
  useEffect(() => {
    if (!territoryEnabled || !isMapReady) {
      return;
    }
    const anims = otherUnitMoveAnimRef.current;
    const seen = new Set<string>();
    for (const mark of unitMarks) {
      if (mark.mine || !mark.moveTarget) {
        continue;
      }
      const target = mark.moveTarget;
      const coords = [target.fromLat, target.fromLon, target.lat, target.lon, target.startedAt, target.endsAt];
      if (!coords.every(Number.isFinite)) {
        continue;
      }
      seen.add(mark.id);
      const key = `${target.startedAt}:${target.lat},${target.lon}`;
      const prev = anims.get(mark.id);
      if (prev && prev.key === key) {
        continue;
      }
      const storedPath = (() => {
        const raw: Array<{ lat: number; lon: number }> | null =
          Array.isArray(target.path) && target.path.length > 0
            ? target.path.filter(
                (p): p is { lat: number; lon: number } =>
                  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon),
              )
            : null;
        if (!mark.id.startsWith("neutral-")) {
          return raw && raw.length > 0 ? raw : [{ lat: target.lat, lon: target.lon }];
        }
        // 무법자: 그려지는 경로 위를 이동한다. 저장 경로 중 현재 다리 구간만
        // 잘라내어 애니메이션한다.
        if (!raw || raw.length === 0) {
          return [{ lat: target.lat, lon: target.lon }];
        }
        // 무효 점이 걸러졌으면 인덱스가 어긋나므로 서버 진행 인덱스를 쓰지 않는다.
        const idx = Array.isArray(target.path) && raw.length === target.path.length ? target.pathIdx ?? null : null;
        return neutralLegSubpath(target.fromLat, target.fromLon, target.lat, target.lon, raw, idx);
      })();
      anims.set(mark.id, {
        key,
        path: storedPath,
        startedAt: target.startedAt,
        endsAt: target.endsAt,
        fromLat: target.fromLat,
        fromLon: target.fromLon,
        destLat: target.lat,
        destLon: target.lon,
        done: false,
        lastLon: target.fromLon,
        img: null,
      });
    }
    for (const id of [...anims.keys()]) {
      if (!seen.has(id)) {
        anims.delete(id);
      }
    }
  }, [territoryEnabled, isMapReady, unitMarks]);

  useEffect(() => {
    if (!territoryEnabled || !isMapReady) {
      return;
    }
    let running = true;
    let raf = 0;
    const cancelTick = (): void => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(raf);
    };
    const tick = (): void => {
      if (!running) {
        return;
      }
      const anims = otherUnitMoveAnimRef.current;
      let hasWork = false;
      for (const anim of anims.values()) {
        if (!anim.done) {
          hasWork = true;
          break;
        }
      }
      // 움직이는 부대가 없으면 vsync를 깨우지 않고 0.8초 간격으로만 확인한다.
      if (!hasWork) {
        raf = window.setTimeout(tick, 800);
        return;
      }
      for (const [id, anim] of anims) {
        if (anim.done) {
          continue;
        }
        const marker = unitMarkerMapRef.current.get(id);
        if (!marker) {
          continue;
        }
        // 서버 권위 위치와 동일한 수식 (등속 폴리선 보간).
        const pos = positionAtMoveTarget(
          {
            fromLat: anim.fromLat,
            fromLon: anim.fromLon,
            lat: anim.destLat,
            lon: anim.destLon,
            startedAt: anim.startedAt,
            endsAt: anim.endsAt,
            via: null,
            path: anim.path,
          },
          Date.now(),
        );
        marker.setLatLng([pos.lat, pos.lon]);
        // 마커 엘리먼트는 재생성 전까지 동일하므로 img를 캐시해 매 프레임 querySelector를 피한다.
        let img = anim.img;
        if (!img || !img.isConnected) {
          img = marker.getElement()?.querySelector<HTMLImageElement>("img.territory-soldier-idle, img.territory-outlaw") ?? null;
          anim.img = img;
        }
        if (img) {
          if (img.dataset.walk !== "1") {
            img.dataset.walk = "1";
          }
          if (Math.abs(pos.lon - anim.lastLon) > 1e-9) {
            // 무법자는 기본 방향이 오른쪽이라 플레이어와 동일하게 뒤집는다.
            const toLeft = pos.lon < anim.lastLon;
            const isOutlaw = img.classList.contains("territory-outlaw");
            img.style.transform = toLeft
              ? isOutlaw
                ? "scaleX(-1)"
                : "scaleX(1)"
              : isOutlaw
                ? "scaleX(1)"
                : "scaleX(-1)";
            anim.lastLon = pos.lon;
          }
        }
        if (pos.arrived) {
          anim.done = true;
          if (img && img.dataset.walk !== "0") {
            img.dataset.walk = "0";
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelTick();
    };
  }, [territoryEnabled, isMapReady]);

  // 줌·이동이 끝나면 경로 화살표 개수를 다시 판정한다 (리렌더 없이 레이어만 갱신).
  // 드래그·줌 중에는 스프라이트 stepping을 멈춰 강제 리플로우를 막는다.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!territoryEnabled || !isMapReady || !map) {
      return;
    }
    const redraw = (): void => {
      try {
        redrawPathsRef.current();
      } catch {}
    };
    const onMoveStart = (): void => {
      setTerritoryAnimPaused(true);
    };
    const onMoveEnd = (): void => {
      setTerritoryAnimPaused(false);
      redraw();
    };
    map.on("movestart", onMoveStart);
    map.on("moveend", onMoveEnd);
    map.on("zoomstart", onMoveStart);
    map.on("zoomend", onMoveEnd);
    return () => {
      map.off("movestart", onMoveStart);
      map.off("moveend", onMoveEnd);
      map.off("zoomstart", onMoveStart);
      map.off("zoomend", onMoveEnd);
      setTerritoryAnimPaused(false);
    };
  }, [territoryEnabled, isMapReady]);

  // 영토전: 부대 이동 경로 녹색 점선
  useEffect(() => {
    if (!territoryEnabled || !isMapReady) {
      return;
    }
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L) {
      return;
    }
    if (!unitMovePathLayerRef.current) {
      unitMovePathLayerRef.current = L.layerGroup().addTo(map);
    }
    drawDirectedPath(unitMovePathLayerRef.current, L, map, unitMovePath ?? [], "#22c55e");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [territoryEnabled, isMapReady, unitMovePath]);

  // 무법자 이동경로 빨간 점선 (줌 15 미만에서는 무법자 마커와 동일하게 숨긴다).
  useEffect(() => {
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L) {
      return;
    }
    if (!wildRouteLayerRef.current) {
      wildRouteLayerRef.current = L.layerGroup().addTo(map);
    }
    if (zoomLevel < 15) {
      wildRouteLayerRef.current.clearLayers();
      return;
    }
    drawDirectedPath(wildRouteLayerRef.current, L, map, wildRoutePath ?? [], "#ef4444");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [territoryEnabled, isMapReady, wildRoutePath, zoomLevel]);

  // 패널이 열린 무법자의 경로가 바뀌면(새 목적지·새 경로) 점선을 갱신한다.
  useEffect(() => {
    if (wildRouteWildId === null) {
      return;
    }
    const mark = unitMarks.find((m) => m.id === `neutral-${wildRouteWildId}`);
    setWildRoutePath(wildPathPoints(mark?.moveTarget ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitMarks]);

// ?nowalk=1 이동가능영역 오버레이 kill 스위치 (성능 A/B용 — URL 바뀌어도 유지).
const isWalkableDisabled = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    // ?walk=1 강제 표시 (킬 스위치 해제).
    if (window.location.search.includes("walk=1")) {
      window.sessionStorage.removeItem("map-nowalk");
      return false;
    }
    if (window.location.search.includes("nowalk=1")) {
      window.sessionStorage.setItem("map-nowalk", "1");
      return true;
    }
    return window.sessionStorage.getItem("map-nowalk") === "1";
  } catch {
    return false;
  }
};

// ?vdebug=1 플래그는 URL이 바뀌어도(sessionStorage) 유지된다.
const isViewportDebugEnabled = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    if (window.location.search.includes("vdebug=1")) {
      window.sessionStorage.setItem("map-vdebug-enabled", "1");
      return true;
    }
    return window.sessionStorage.getItem("map-vdebug-enabled") === "1";
  } catch {
    return false;
  }
};
// ?perf=1 플래그는 URL이 바뀌어도(sessionStorage) 유지된다 — 점수 애니메이션 등이 router.replace("/map")으로 쿼리를 지우기 때문.
const isMapPerfEnabled = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    if (window.location.search.includes("perf=1")) {
      window.sessionStorage.setItem("map-perf-enabled", "1");
      return true;
    }
    return window.sessionStorage.getItem("map-perf-enabled") === "1";
  } catch {
    return false;
  }
};

  // ?perf=1 일시 롱태스크 귀속 기록 (리로드 직후 프리징 원인 특정용 — 평소엔 미동작).
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!isMapPerfEnabled()) {
      return;
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const detail = entry as PerformanceEntry & {
            attribution?: Array<{ name?: string; containerType?: string; containerName?: string }>;
          };
          const attr = (detail.attribution ?? [])
            .map((a) => `${a.containerType ?? ""}:${a.containerName ?? a.name ?? ""}`)
            .join(",");
          console.log(`[perf] longtask ${Math.round(entry.duration)}ms ${entry.name} ${attr}`);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      return () => observer.disconnect();
    } catch {
      return;
    }
  }, []);

  // ?perf=1 드래그 잰크 계측 (movestart→moveend 프레임 간격 기록 — 평소엔 미동작).
  useEffect(() => {
    if (!isMapReady || typeof window === "undefined") {
      return;
    }
    if (!isMapPerfEnabled()) {
      return;
    }
    const map = mapInstanceRef.current;
    if (!map) {
      return;
    }
    let dragging = false;
    let rafId = 0;
    let frames = 0;
    let jankFrames = 0;
    let worstGap = 0;
    let lastT = 0;
    let startT = 0;
    const loop = (t: number): void => {
      if (!dragging) {
        return;
      }
      frames += 1;
      if (lastT > 0) {
        const gap = t - lastT;
        if (gap > worstGap) {
          worstGap = gap;
        }
        if (gap > 50) {
          jankFrames += 1;
        }
      }
      lastT = t;
      rafId = window.requestAnimationFrame(loop);
    };
    const onStart = (): void => {
      dragging = true;
      frames = 0;
      jankFrames = 0;
      worstGap = 0;
      lastT = 0;
      startT = performance.now();
      rafId = window.requestAnimationFrame(loop);
    };
    const onEnd = (): void => {
      if (!dragging) {
        return;
      }
      dragging = false;
      window.cancelAnimationFrame(rafId);
      const duration = performance.now() - startT;
      console.log(
        `[perf] drag ${Math.round(duration)}ms frames=${frames} jank(>50ms)=${jankFrames} worst=${Math.round(worstGap)}ms fps=${(frames / (duration / 1000)).toFixed(1)}`,
      );
    };
    map.on("movestart", onStart);
    map.on("moveend", onEnd);
    return () => {
      dragging = false;
      window.cancelAnimationFrame(rafId);
      map.off("movestart", onStart);
      map.off("moveend", onEnd);
    };
  }, [isMapReady]);

  // 영토전: 부대 이동 목적지 역삼각형 마커 (지시 후 유지)
  useEffect(() => {
    if (!territoryEnabled || !isMapReady) {
      return;
    }
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L) {
      return;
    }
    if (!unitMoveDestinationLayerRef.current) {
      unitMoveDestinationLayerRef.current = L.layerGroup().addTo(map);
    }
    const layer = unitMoveDestinationLayerRef.current;
    layer.clearLayers();
    if (!unitMoveDestination) {
      return;
    }
    const icon = L.divIcon({
      className: "map-unit-destination-marker",
      html: `<div class="map-rotation-upright"><div class="unit-destination-triangle"></div></div>`,
      iconSize: [44, 34],
      iconAnchor: [22, 0],
    });
    L.marker([unitMoveDestination.lat, unitMoveDestination.lon], { icon, interactive: false }).addTo(layer);
  }, [territoryEnabled, isMapReady, unitMoveDestination]);

  useEffect(() => {
    // console.log("[CurrentLocationMap] marker effect start", {
    //   isMapReady,
    //   pointsCount: points.length,
    //   hasLeaflet: Boolean(leafletRef.current),
    //   hasMapInstance: Boolean(mapInstanceRef.current),
    //   pointsSample: points.slice(0, 3).map(p => ({ id: p.id, lat: p.lat.toFixed(5), lon: p.lon.toFixed(5) })),
    // });

    if (!isMapReady) {
      // console.warn("[CurrentLocationMap] skip marker render: map not ready yet");
      return;
    }

    if (!leafletRef.current || !mapInstanceRef.current) {
      // console.warn("[CurrentLocationMap] skip marker render: leaflet/map instance missing", {
      //   hasLeaflet: Boolean(leafletRef.current),
      //   hasMapInstance: Boolean(mapInstanceRef.current),
      // });
      return;
    }

    if (!pointsLayerRef.current) {
      // console.log("[CurrentLocationMap] creating points layer group");
      pointsLayerRef.current = leafletRef.current.layerGroup().addTo(mapInstanceRef.current);
    }

    // 같은 입력으로 이펙트가 반복 실행돼도 마커 전체 재빌드는 1회로 제한한다.
    // (콜백 identity 변경 등으로 이펙트가 3연타되던 것을 스킵 — clearLayers+191개 재생성이 블로킹 주범)
    const buildSig = `${zoomLevel}|${territoryEnabled}|${markerPoiPoints.map((p) => `${p.id}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(";")}|v:${visitedEventKeys.join(",")}|c:${[...castleKindMap.entries()].map(([k, v]) => `${k}=${v}`).join(",")}|n:${neutralDamageExpiresAtRef.current.size}`;
    if (
      markerBuildSigRef.current === buildSig &&
      (markerPoiPoints.length === 0 || (pointsLayerRef.current.getLayers().length > 0))
    ) {
      return;
    }
    if (isMapPerfEnabled() && markerBuildSigRef.current !== null) {
      const prevParts = markerBuildSigRef.current.split("|");
      const nextParts = buildSig.split("|");
      const changed: string[] = [];
      const labels = ["zoom", "territory", "points", "visited", "castleKind", "neutral"];
      for (let i = 0; i < labels.length; i += 1) {
        if (prevParts[i] !== nextParts[i]) {
          const a = (prevParts[i] ?? "").length;
          const b = (nextParts[i] ?? "").length;
          changed.push(`${labels[i]}(${a}->${b})`);
        }
      }
      console.log(`[perf] marker rebuild reason: ${changed.join(",") || "unknown"}`);
    }
    markerBuildSigRef.current = buildSig;
    markerBuildRunRef.current += 1;
    const buildRunId = markerBuildRunRef.current;

    // console.log("[CurrentLocationMap] clearing existing markers");
    pointsLayerRef.current.clearLayers();
    poiMarkerElementsRef.current.clear();
    poiMarkerByKeyRef.current.clear();

    if (!markerPoiPoints.length) {
      setClusterUnits((previousUnits) => (previousUnits.length === 0 ? previousUnits : []));
      // console.warn("[CurrentLocationMap] no GPS points to render - points array is empty");
      return;
    }

    // console.log("[CurrentLocationMap] rendering GPS markers", {
    //   count: points.length,
    //   sample: points.slice(0, 5).map(p => ({ id: p.id, label: p.label, lat: p.lat.toFixed(5), lon: p.lon.toFixed(5) })),
    // });

    const L = leafletRef.current;
    if (!poiIconRef.current) {
      // console.log("[CurrentLocationMap] creating poi icon with Three.js");
      const poiIconDataUrl = createThreePoiMarkerDataUrl("unvisited");
      if (poiIconDataUrl) {
        // console.log("[CurrentLocationMap] poi icon created successfully, generating divIcon");
        poiIconRef.current = L.divIcon({
          className: "three-poi-marker-shell",
          html: `<div class="map-rotation-upright"><div class="three-poi-marker-spin"><img src="${poiIconDataUrl}" alt="" class="three-poi-marker" /></div></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 29],
        });
      } else {
        // console.warn("[CurrentLocationMap] poi icon dataURL is null, using fallback");
        poiIconRef.current = L.divIcon({
          className: "three-poi-marker-shell",
          html: '<div class="map-rotation-upright"><div class="three-poi-marker-fallback" aria-hidden="true"></div></div>',
          iconSize: [30, 30],
          iconAnchor: [15, 29],
        });
      }

      // console.log("[CurrentLocationMap] poi icon prepared", {
      //   usingThreeIcon: Boolean(poiIconDataUrl),
      //   iconClassName: poiIconRef.current.options?.className,
      // });
    }
    const poiIcon = poiIconRef.current;
    if (!poiIcon) {
      // console.error("[CurrentLocationMap] CRITICAL: poiIcon is still null after creation!");
      return;
    }

    if (!poiVisitedIconRef.current) {
      const poiVisitedIconDataUrl = createThreePoiMarkerDataUrl("visited");
      const poiUnvisitedIconDataUrl = createThreePoiMarkerDataUrl("unvisited");
      if (poiVisitedIconDataUrl) {
        poiVisitedIconRef.current = L.divIcon({
          className: "three-poi-marker-visited-shell",
          html: `<div class="map-rotation-upright"><div class="three-poi-marker-visited-wrap"><span class="three-poi-marker-visited-glow" aria-hidden="true"></span><span class="three-poi-marker-visited-ripple" aria-hidden="true"></span>${poiUnvisitedIconDataUrl ? `<img src="${poiUnvisitedIconDataUrl}" alt="" class="three-poi-marker-visited-red" />` : ""}<img src="${poiVisitedIconDataUrl}" alt="" class="three-poi-marker-visited" /></div></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 29],
        });
      } else {
        poiVisitedIconRef.current = L.divIcon({
          className: "three-poi-marker-visited-shell",
          html: '<div class="map-rotation-upright"><div class="three-poi-marker-visited-wrap"><span class="three-poi-marker-visited-glow" aria-hidden="true"></span><span class="three-poi-marker-visited-ripple" aria-hidden="true"></span><div class="three-poi-marker-fallback three-poi-marker-visited-red" aria-hidden="true"></div><div class="three-poi-marker-fallback three-poi-marker-visited-fallback three-poi-marker-visited" aria-hidden="true"></div></div></div>',
          iconSize: [30, 30],
          iconAnchor: [15, 29],
        });
      }
    }
    const poiVisitedIcon = poiVisitedIconRef.current ?? poiIcon;

    if (!poiNeutralIconRef.current) {
      poiNeutralIconRef.current = L.divIcon({
        className: "neutral-poi-marker-shell",
        html: `<div class="map-rotation-upright"><img src="/markers/neutral-castle-v2-short.png" alt="" style="width:54px;height:54px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))" /></div>`,
        iconSize: [54, 54],
        iconAnchor: [27, 27],
      });
    }
    const poiNeutralIcon = poiNeutralIconRef.current ?? poiIcon;

    if (!poiLordIconRef.current) {
      poiLordIconRef.current = L.divIcon({
        className: "castle-lord-marker-shell",
        html: `<div class="map-rotation-upright"><img src="/markers/lord-castle-v2.png" alt="" style="width:54px;height:54px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))" /></div>`,
        iconSize: [54, 54],
        iconAnchor: [27, 27],
      });
    }
    const poiLordIcon = poiLordIconRef.current ?? poiIcon;

    if (!damagedLordCastleIconRef.current) {
      damagedLordCastleIconRef.current = L.divIcon({
        className: "castle-lord-marker-shell",
        html: `<div class="map-rotation-upright"><img src="/markers/lord-castle-damaged-1.png" alt="" style="width:54px;height:54px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))" /></div>`,
        iconSize: [54, 54],
        iconAnchor: [27, 27],
      });
    }
    const damagedLordCastleIcon = damagedLordCastleIconRef.current ?? poiLordIcon;

    if (!poiNobleIconRef.current) {
      poiNobleIconRef.current = L.divIcon({
        className: "castle-noble-marker-shell",
        html: `<div class="map-rotation-upright"><img src="/markers/neutral-castle-v2.png" alt="" style="width:54px;height:54px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))" /></div>`,
        iconSize: [54, 54],
        iconAnchor: [27, 27],
      });
    }
    const poiNobleIcon = poiNobleIconRef.current ?? poiIcon;

    // console.log("[CurrentLocationMap] starting clustering calculation", {
    //   totalPoints: points.length,
    //   clusterDistancePx: CLUSTER_DISTANCE_PX,
    //   currentZoom: mapInstanceRef.current.getZoom(),
    // });

    let addedCount = 0;

    // 클러스터링: 가까운 마커들을 그룹화
    const map = mapInstanceRef.current;
    if (!map) {
      // console.warn("[CurrentLocationMap] skip clustering: map not ready");
      return;
    }

    if (!poiIcon) {
      // console.warn("[CurrentLocationMap] skip markers: poiIcon not ready");
      return;
    }

    const clusters: { center: MapPoint; points: MapPoint[] }[] = [];
    const processed = new Set<number>();

    // 전수 비교 O(n²) 대신 공간 그리드 O(n)으로 클러스터링한다.
    // (리로드 직후 수천 개 마커에서 수백 ms 메인스레드 블로킹의 주범이었음.
    //  셀 크기=임계값이므로 임계 내 점은 반드시 3x3 이웃 셀에 있어 결과가 동일하다.)
    const pixelCoords = new Map<number, { x: number; y: number }>();
    const cellOf = (x: number, y: number): string =>
      `${Math.floor(x / CLUSTER_DISTANCE_PX)},${Math.floor(y / CLUSTER_DISTANCE_PX)}`;
    const grid = new Map<string, number[]>();
    for (const point of markerPoiPoints) {
      const px = map.latLngToContainerPoint([point.lat, point.lon]);
      pixelCoords.set(point.id, { x: px.x, y: px.y });
      const key = cellOf(px.x, px.y);
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(point.id);
      } else {
        grid.set(key, [point.id]);
      }
    }
    const byId = new Map<number, MapPoint>();
    for (const point of markerPoiPoints) {
      byId.set(point.id, point);
    }

    // 클러스터 찾기
    for (const point of markerPoiPoints) {
      if (processed.has(point.id)) continue;

      const clusterPoints: MapPoint[] = [point];
      processed.add(point.id);
      const pointCoords = pixelCoords.get(point.id) ?? { x: 0, y: 0 };
      const cellX = Math.floor(pointCoords.x / CLUSTER_DISTANCE_PX);
      const cellY = Math.floor(pointCoords.y / CLUSTER_DISTANCE_PX);
      for (let gx = cellX - 1; gx <= cellX + 1; gx += 1) {
        for (let gy = cellY - 1; gy <= cellY + 1; gy += 1) {
          const bucket = grid.get(`${gx},${gy}`);
          if (!bucket) continue;
          for (const otherId of bucket) {
            if (processed.has(otherId)) continue;
            const other = byId.get(otherId);
            if (!other) continue;
            const otherCoords = pixelCoords.get(otherId) ?? { x: 0, y: 0 };
            const dx = pointCoords.x - otherCoords.x;
            const dy = pointCoords.y - otherCoords.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < CLUSTER_DISTANCE_PX) {
              clusterPoints.push(other);
              processed.add(otherId);
            }
          }
        }
      }

      clusters.push({ center: point, points: clusterPoints });
    }
    if (isMapPerfEnabled()) {
      console.log(`[perf] satellite cluster n=${markerPoiPoints.length} clusters=${clusters.length}`);
    }

    const nextClusterUnits: ClusterUnit[] = clusters.map((cluster) => ({
      id: cluster.points
        .map((point) => point.id)
        .sort((a, b) => a - b)
        .join("-"),
      lat: cluster.center.lat,
      lon: cluster.center.lon,
      count: cluster.points.length,
    }));
    setClusterUnits((previousUnits) => {
      if (previousUnits.length !== nextClusterUnits.length) {
        return nextClusterUnits;
      }

      const hasDifference = previousUnits.some((unit, index) => {
        const next = nextClusterUnits[index];
        return (
          unit.id !== next.id ||
          unit.count !== next.count ||
          Math.abs(unit.lat - next.lat) > 0.000001 ||
          Math.abs(unit.lon - next.lon) > 0.000001
        );
      });

      return hasDifference ? nextClusterUnits : previousUnits;
    });

    // console.log("[CurrentLocationMap] clustering result", {
    //   totalPoints: points.length,
    //   clusters: clusters.length,
    //   clusterSizes: clusters.map(c => c.points.length),
    //   uniqueMarkers: clusters.filter(c => c.points.length === 1).length,
    //   clusteredMarkers: clusters.filter(c => c.points.length > 1).length,
    // });

    // 마커 추가 (줌 변경 시 191개 동기 생성이 300ms 블로킹이 되므로 32개마다 yield)
    void (async () => {
      for (const [index, cluster] of clusters.entries()) {
        if (index % 32 === 0) {
          if (buildRunId !== markerBuildRunRef.current) {
            return;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          if (buildRunId !== markerBuildRunRef.current) {
            return;
          }
        }
      if (cluster.points.length === 1) {
        // 단일 마커
        const point = cluster.center;
        //console.log(`[CurrentLocationMap] adding SINGLE marker ${index}: id=${point.id}, label=${point.label}, lat=${point.lat.toFixed(5)}, lon=${point.lon.toFixed(5)`);
        const pointVisited = isVisitedEventKey(point.eventKey);
        const castleKind = castleKindOf(point.eventKey);
        const neutralDamageExpiresAt = isNeutralEventKey(point.eventKey)
          ? getNeutralDamageExpiry(point.eventKey)
          : null;
        const territorySoldierIcon = territoryEnabled && !pointVisited && !isNeutralEventKey(point.eventKey) && castleKind === null
          ? L.divIcon({
              className: "three-poi-marker-shell",
              html: `<div class="map-rotation-upright">${territorySoldierAnimationMarkup()}</div>`,
              iconSize: [52, 52],
              iconAnchor: [26, 51],
            })
          : null;
        const poiMarkerIcon = neutralDamageExpiresAt !== null
          ? L.divIcon({
              className: "three-poi-marker-shell",
              html: `<div class="map-rotation-upright">${neutralDamageAnimationMarkup()}</div>`,
              iconSize: [54, 54],
              iconAnchor: [27, 27],
            })
          : pointVisited && territoryEnabled && castleKind === "lord"
            ? damagedLordCastleIcon
              : territorySoldierIcon
                ? territorySoldierIcon
                : pointVisited
              ? poiVisitedIcon
              : isNeutralEventKey(point.eventKey)
                ? poiNeutralIcon
                : castleKind === "lord"
                  ? poiLordIcon
                  : castleKind === "noble"
                    ? poiNobleIcon
                    : poiIcon;
        const poiMarker = L.marker([point.lat, point.lon], { icon: poiMarkerIcon });

        if (point.label) {
          poiMarker.bindTooltip(point.label, {
            permanent: true,
            direction: "top",
            offset: [0, POI_LABEL_OFFSET_Y],
            className: "map-poi-label",
          });
        }

        if (point.eventKey) {
          poiMarker.on("click", () => {
            if (placeCastleAt(point.lat, point.lon)) {
              return;
            }
            const eventKey = point.eventKey ?? "";
            // 코드 생성 중립성 마커는 전용 패널로 연결한다.
            if (isNeutralEventKey(eventKey)) {
              applyHostileInstant(poiMarker, eventKey);
              showMarkerPanel(buildNeutralPanel(point.label, eventKey, point.lat, point.lon));
              return;
            }
            // 영토 미션의 성 마커는 영토 시트(W2)로 연결한다.
            if (territoryEnabled && eventKey.trim().startsWith("castle-")) {
              if (!ownedCastleKeys.includes(eventKey)) {
                applyHostileInstant(poiMarker, eventKey);
              }
              setTerritoryCastleKey(eventKey);
              return;
            }
            const isQuizType = point.eventType?.toLowerCase() === "quiztype";
            const clickedScore = getVisitedScore(point.eventKey);
            showMarkerPanel({
              title: isQuizType ? "퀴즈 마커" : "이벤트 마커",
              lines: [
                `이름: ${point.label ?? "-"}`,
                `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
                ...(pointVisited ? ["상태: 방문 완료"] : []),
                ...(clickedScore !== null ? [`획득 점수: ${clickedScore}점`] : []),
              ],
              eventKey,
            });
          });
        } else {
          poiMarker.on("click", () => {
            showMarkerPanel({
              title: "GPS 마커",
              lines: [
                `이름: ${point.label ?? "-"}`,
                `이벤트 종류: ${getEventTypeLabel(point.eventType)}`,
              ],
            });
          });
        }

        pointsLayerRef.current?.addLayer(poiMarker);
        if (point.eventKey) {
          poiMarkerByKeyRef.current.set(point.eventKey, poiMarker);
        }
        registerTerritorySoldierAnimation(poiMarker.getElement() ?? null);
        if (neutralDamageExpiresAt !== null) {
          window.setTimeout(() => {
            if (map.hasLayer(poiMarker)) {
              poiMarker.setIcon(poiNeutralIcon);
            }
          }, Math.max(0, neutralDamageExpiresAt - Date.now()));
        }
        if (pointVisited) {
          const visitedKey = point.eventKey?.trim() ?? "";
          if (visitedKey) {
            poiMarkerElementsRef.current.set(visitedKey, poiMarker);
            if (!readCelebratedTimes().has(visitedKey)) {
              poiMarker.getElement()?.classList.add("morph-pending");
            }
          }
        }
        if (isNeutralEventKey(point.eventKey)) {
          pointsLayerRef.current?.addLayer(
            L.circle([point.lat, point.lon], {
              radius: NEUTRAL_RANGE_RADIUS_M,
              color: "#fbbf24",
              weight: 2,
              opacity: 0.9,
              fillColor: "#fbbf24",
              fillOpacity: 0.12,
              interactive: false,
            })
          );
        }
        addedCount += 1;
      } else {
        // 클러스터 마커
        const count = cluster.points.length;
        const clusterVisitedCount = cluster.points.filter((p) => isVisitedEventKey(p.eventKey)).length;
        const clusterAllVisited = clusterVisitedCount === count;
        //console.log(`[CurrentLocationMap] adding CLUSTER marker ${index}: count=${count}, lat=${cluster.center.lat.toFixed(5)}, lon=${cluster.center.lon.toFixed(5)}`);
        //console.log(`[CurrentLocationMap] cluster members:`, cluster.points.map(p => ({ id: p.id, label: p.label })));
        const clusterIcon = L.divIcon({
          className: "cluster-marker-shell",
          html: `<div class="cluster-marker${clusterAllVisited ? " cluster-marker-visited" : ""} map-rotation-upright"><span>${count}</span></div>`,
          iconSize: [56, 56],
          iconAnchor: [28, 28],
        });

        const clusterMarker = L.marker([cluster.center.lat, cluster.center.lon], {
          icon: clusterIcon,
        });

        const labels = cluster.points.map((p) => p.label ?? "-").join(", ");
        clusterMarker.bindTooltip(`(${count}개) ${labels}`, {
          permanent: false,
          direction: "top",
          offset: [0, -30],
          className: "map-cluster-tooltip",
        });

        clusterMarker.on("click", () => {
          if (placeCastleAt(cluster.center.lat, cluster.center.lon)) {
            return;
          }
          const lines = cluster.points.flatMap((p) => {
            const memberScore = getVisitedScore(p.eventKey);
            return [
              `이름: ${p.label ?? "-"}`,
              `이벤트 종류: ${getEventTypeLabel(p.eventType)}`,
              ...(memberScore !== null ? [`획득 점수: ${memberScore}점`] : []),
              "---",
            ];
          });
          const clusterEventKeys = cluster.points
            .map((p) => p.eventKey?.trim() ?? "")
            .filter((key) => key.length > 0);
          showMarkerPanel({
            title: `마커 ${count}개`,
            lines,
            eventKey: clusterEventKeys.length > 0 ? clusterEventKeys.join("\n") : undefined,
          });
        });

        pointsLayerRef.current?.addLayer(clusterMarker);
        addedCount += count;
      }
      }

      if (!scoreCelebrationPendingRef.current) {
        celebrateVisitedMarkers();
      }
    })();

    // console.log("[CurrentLocationMap] FINAL RESULT - gps markers added", {
    //   requestedCount: points.length,
    //   clustersCount: clusters.length,
    //   addedCount,
    //   layerCount: pointsLayerRef.current?.getLayers().length ?? 0,
    // });
  }, [createThreePoiMarkerDataUrl, isMapReady, markerPoiPoints, showMarkerPanel, zoomLevel, isVisitedEventKey, getVisitedScore, getNeutralDamageExpiry, celebrateVisitedMarkers, territoryEnabled, placeCastleAt, castleKindMap]);

  // 축성 위치 지정: 위성 지도 클릭으로 확정 단계 진입.
  useEffect(() => {
    if (mapStyle !== "satellite" || !isMapReady || !mapInstanceRef.current) {
      return;
    }
    const map = mapInstanceRef.current;
    const handleMapClick = (e: unknown): void => {
      const latlng = (e as { latlng?: { lat?: unknown; lng?: unknown } } | null)?.latlng;
      const lat = typeof latlng?.lat === "number" ? latlng.lat : NaN;
      const lon = typeof latlng?.lng === "number" ? latlng.lng : NaN;
      placeCastleAt(lat, lon);
    };
    map.on("click", handleMapClick);
    return () => {
      try {
        map.off("click", handleMapClick);
      } catch {}
    };
  }, [isMapReady, mapStyle, placeCastleAt]);

  // 영주 캐릭터 탭 폴백: 마커 클릭이 먹지 않는 경우에도 지도 탭으로 선택되게 한다.
  // (마커 자체 클릭이 동작하면 같은 시트를 다시 여는 것이라 무해하다)
  useEffect(() => {
    if (mapStyle !== "satellite" || !isMapReady || !mapInstanceRef.current) {
      return;
    }
    const map = mapInstanceRef.current;
    const handleLordTapFallback = (e: unknown): void => {
      try {
        if (castlePlacement) {
          return;
        }
        const raw = e as {
          containerPoint?: { x?: unknown; y?: unknown };
          originalEvent?: { target?: unknown } | null;
        } | null;
        const cx = typeof raw?.containerPoint?.x === "number" ? raw.containerPoint.x : NaN;
        const cy = typeof raw?.containerPoint?.y === "number" ? raw.containerPoint.y : NaN;
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
          return;
        }
        const target = raw?.originalEvent?.target as Element | null | undefined;
        if (target && typeof target.closest === "function") {
          const iconEl = target.closest(".leaflet-marker-icon");
          // 다른 마커를 탭한 경우는 해당 마커 핸들러에 맡긴다.
          if (iconEl && !iconEl.classList.contains("three-player-marker") && !iconEl.querySelector(".three-player-marker")) {
            return;
          }
        }
        const center = playerLocation;
        if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
          return;
        }
        const pp = map.latLngToContainerPoint([center.lat, center.lon]);
        if (Math.hypot(pp.x - cx, pp.y - cy) > 48) {
          return;
        }
        handleUnitMarkerClick(LORD_UNIT_ID);
      } catch {
        // 무시
      }
    };
    map.on("click", handleLordTapFallback);
    return () => {
      try {
        map.off("click", handleLordTapFallback);
      } catch {}
    };
  }, [isMapReady, mapStyle, castlePlacement, playerLocation]);

  // 확정 단계에서 고른 위치에 성 표시를 남긴다.
  useEffect(() => {
    if (!castlePlacement?.confirming || castlePlacement.lat === null || castlePlacement.lon === null) {
      return;
    }
    const { lat, lon } = castlePlacement;
    const pinSrc = CASTLE_IMAGE_BY_KIND[castlePlacement.kind];
    if (mapStyle === "satellite" && isMapReady && mapInstanceRef.current && leafletRef.current) {
      const L = leafletRef.current;
      const pin = L.marker([lat, lon], {
        icon: L.divIcon({
          className: "castle-pin-marker-shell",
          html: `<div class="map-rotation-upright"><img src="${pinSrc}" alt="" style="width:54px;height:54px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))" /></div>`,
          iconSize: [54, 54],
          iconAnchor: [27, 27],
        }),
        interactive: false,
        keyboard: false,
      });
      pin.addTo(mapInstanceRef.current);
      return () => {
        try {
          mapInstanceRef.current?.removeLayer(pin);
        } catch {}
      };
    }
    if (mapStyle === "globe" && isGlobeReady && globeMapRef.current) {
      const Ctor = globeMarkerCtorRef.current;
      if (!Ctor) {
        return;
      }
      const element = document.createElement("div");
      element.style.width = "54px";
      element.style.height = "54px";
      element.style.pointerEvents = "none";
      const image = document.createElement("img");
      image.src = pinSrc;
      image.alt = "";
      image.style.width = "54px";
      image.style.height = "54px";
      image.style.filter = "drop-shadow(0 2px 3px rgba(0,0,0,0.55))";
      element.appendChild(image);
      const pin = new Ctor({ element, anchor: "center" })
        .setLngLat([lon, lat])
        .addTo(globeMapRef.current);
      return () => {
        try {
          pin.remove();
        } catch {}
      };
    }
    if (mapStyle === "cesium" && isCesiumReady && cesiumViewerRef.current) {
      const viewer = cesiumViewerRef.current;
      if (viewer.isDestroyed()) {
        return;
      }
      const CesiumLib = (window as unknown as { Cesium?: typeof import("cesium") }).Cesium;
      if (!CesiumLib) {
        return;
      }
      const entity = viewer.entities.add({
        position: CesiumLib.Cartesian3.fromDegrees(lon, lat),
        billboard: {
          image: pinSrc,
          width: 54,
          height: 54,
          heightReference: CesiumLib.HeightReference.CLAMP_TO_GROUND,
        },
      });
      cesiumPoiEntitiesRef.current.push(entity);
      return () => {
        try {
          viewer.entities.remove(entity);
        } catch {}
        cesiumPoiEntitiesRef.current = cesiumPoiEntitiesRef.current.filter((e) => e !== entity);
      };
    }
    return;
  }, [castlePlacement, mapStyle, isMapReady, isGlobeReady, isCesiumReady]);

  useEffect(() => {
    // console.log("[CurrentLocationMap] zoom level changed", { zoomLevel });
  }, [zoomLevel]);

  useEffect(() => {
    // console.log("[CurrentLocationMap] playerScore updated", {
    //   playerScore,
    //   formattedScore,
    // });
  }, [playerScore, formattedScore]);

  const handleConfirmPanel = useCallback(() => {
    if (!markerPanel?.confirmTarget) {
      return;
    }
    try {
      const perStyleKey = `map-zoom:${locationCacheKey}:${mapStyle}`;
      sessionStorage.setItem(perStyleKey, String(zoomLevel));
      sessionStorage.setItem(`map-zoom:${locationCacheKey}`, String(zoomLevel));
    } catch {}
    const target = markerPanel.confirmTarget;
    const exitUrl = markerPanel.exitUrl;
    setMarkerPanel(null);

    if (target.includes("/event?")) {
      window.location.href = target;
      return;
    }

    if (exitUrl) {
      router.push(exitUrl);
    } else {
      triggerNavigation(target);
    }
  }, [markerPanel, triggerNavigation, router, zoomLevel, locationCacheKey, mapStyle]);

  // ---- Admin boundary overlays (Leaflet satellite / MapLibre globe / Cesium 3D) ----
  // Single source of truth: adminGeoJson. Hover/selection restyle without reload.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapInstanceRef.current;
    if (mapStyle !== "satellite" || !adminGeoJson || !isMapReady || !map || !L) {
      if (adminLeafletLayerRef.current && map) {
        try {
          map.removeLayer(adminLeafletLayerRef.current);
        } catch {}
        adminLeafletLayerRef.current = null;
      } else if (!map) {
        adminLeafletLayerRef.current = null;
      }
      return;
    }
    if (adminLeafletLayerRef.current) {
      try {
        map.removeLayer(adminLeafletLayerRef.current);
      } catch {}
      adminLeafletLayerRef.current = null;
    }
    const readCode = (props: unknown): string | null => {
      if (typeof props !== "object" || props === null) {
        return null;
      }
      const record = props as Record<string, unknown>;
      const normCode = record["_normCode"];
      if (typeof normCode === "string" && normCode !== "") {
        return normCode;
      }
      const code = record["code"];
      return typeof code === "string" ? code : null;
    };
    const readName = (props: unknown): string => {
      if (typeof props !== "object" || props === null) {
        return "unknown";
      }
      const record = props as Record<string, unknown>;
      const display = record["_displayName"];
      if (typeof display === "string" && display !== "") {
        return display;
      }
      const name = record["_normName"];
      return typeof name === "string" && name !== "" ? name : "unknown";
    };
    const styleFor = (feature?: GeoJSON.Feature): import("leaflet").PathOptions => {
      const code = feature ? readCode(feature.properties) : null;
      const isSel = code !== null && code === adminSelectedRef.current;
      const s = getBoundaryStyle(adminLevel, isSel, false);
      // 영토전 동 수준에서는 소유자 색으로 채운다.
      if (territoryEnabled && adminLevel === "dong" && code) {
        const own = ownedDongMap.get(code);
        if (own) {
          return {
            color: s.strokeColor,
            weight: s.strokeWeight,
            fillColor: territoryOwnerColor(own.ownerId),
            fillOpacity: 0.35,
          };
        }
      }
      return { color: s.strokeColor, weight: s.strokeWeight, fillColor: s.fillColor, fillOpacity: s.fillOpacity };
    };
    // 3,500여 개 동 폴리곤을 SVG DOM 대신 단일 canvas로 그린다 (전용 pane, 오버레이 아래).
    if (!map.getPane(ADMIN_LEAFLET_PANE)) {
      // leaflet-rotate: 기본 pane들은 rotatePane 안에 있다. 커스텀 pane도 그 안에 만들어야
      // 회전·이동이 함께 적용된다 (mapPane에 두면 canvas가 엉뚱한 위치에 그려진다).
      const pane = map.createPane(ADMIN_LEAFLET_PANE, map.getPane("rotatePane") ?? undefined);
      pane.style.zIndex = "450";
    }
    let renderer = adminCanvasRendererRef.current;
    if (!renderer || adminCanvasRendererMapRef.current !== map) {
      renderer = L.canvas({ padding: 0.5, pane: ADMIN_LEAFLET_PANE });
      adminCanvasRendererRef.current = renderer;
      adminCanvasRendererMapRef.current = map;
    }
    // GeoJSON 옵션은 하위 Path 생성자에 그대로 전달되므로 renderer도 적용된다 (타입 정의에는 없음).
    const pathRenderOptions = { pane: ADMIN_LEAFLET_PANE, renderer } as import("leaflet").GeoJSONOptions;
    const layer = L.geoJSON(adminGeoJson as GeoJSON.GeoJsonObject, {
      ...pathRenderOptions,
      style: styleFor,
      onEachFeature: (feature: GeoJSON.Feature, featureLayer: import("leaflet").Layer) => {
        const props = feature.properties as Record<string, unknown> | null;
        const code = readCode(props);
        const name = readName(props);
        const interactive = featureLayer as unknown as {
          on: (event: string, handler: (e: unknown) => void) => void;
          bindTooltip: (content: string, options: Record<string, unknown>) => void;
        };
        if (code !== null) {
          interactive.on("click", (e: unknown) => {
            if (placementRef.current) {
              return;
            }
            const maybeEvent = e as { originalEvent?: Event };
            if (maybeEvent?.originalEvent?.target instanceof HTMLElement) {
              try {
                (maybeEvent.originalEvent.target as HTMLElement).blur();
              } catch {}
            }
            if (document.activeElement instanceof HTMLElement) {
              try {
                document.activeElement.blur();
              } catch {}
            }
            setSelectedAdminCode(code);
            setSelectedAdminName(name);
          });
          interactive.on("mouseover", () => setHoveredAdminCode(code));
          interactive.on("mouseout", () => {
            setHoveredAdminCode((prev) => (prev === code ? null : prev));
          });
        }
      },
    });
    layer.addTo(map);
    adminLeafletLayerRef.current = layer;
    return () => {
      const currentMap = mapInstanceRef.current;
      const currentLayer = adminLeafletLayerRef.current;
      if (currentMap && currentLayer) {
        try {
          currentMap.removeLayer(currentLayer);
        } catch {}
      }
      adminLeafletLayerRef.current = null;
    };
  }, [adminGeoJson, adminLevel, isMapReady, mapStyle, ownedDongMap, territoryEnabled]);

  useEffect(() => {
    const layer = adminLeafletLayerRef.current;
    if (!layer) {
      return;
    }
    layer.setStyle((feature?: GeoJSON.Feature) => {
      const props = feature?.properties as Record<string, unknown> | null;
      const rawCode = props?.["_normCode"] ?? props?.["code"];
      const code = typeof rawCode === "string" ? rawCode : null;
      const isSel = code !== null && code === selectedAdminCode;
      const isHov = code !== null && code === hoveredAdminCode;
      const s = getBoundaryStyle(adminLevel, isSel, isHov);
      // 영토 색 유지 (선택·호버 갱신 시에도 소유자 채우기를 덮어쓰지 않는다).
      if (territoryEnabled && adminLevel === "dong" && code) {
        const own = ownedDongMap.get(code);
        if (own) {
          return {
            color: s.strokeColor,
            weight: s.strokeWeight,
            fillColor: territoryOwnerColor(own.ownerId),
            fillOpacity: 0.35,
          };
        }
      }
      return { color: s.strokeColor, weight: s.strokeWeight, fillColor: s.fillColor, fillOpacity: s.fillOpacity };
    });
  }, [selectedAdminCode, hoveredAdminCode, adminLevel, ownedDongMap, territoryEnabled]);

  useEffect(() => {
    if (mapStyle !== "globe" || !isGlobeReady) {
      const existing = globeMapRef.current;
      if (existing) {
        try {
          if (existing.getLayer(ADMIN_GLOBE_FILL_LAYER_ID)) {
            existing.removeLayer(ADMIN_GLOBE_FILL_LAYER_ID);
          }
        } catch {}
        try {
          if (existing.getLayer(ADMIN_GLOBE_LINE_LAYER_ID)) {
            existing.removeLayer(ADMIN_GLOBE_LINE_LAYER_ID);
          }
        } catch {}
        try {
          if (existing.getSource(ADMIN_GLOBE_SOURCE_ID)) {
            existing.removeSource(ADMIN_GLOBE_SOURCE_ID);
          }
        } catch {}
      }
      return;
    }
    const map = globeMapRef.current;
    if (!map || !adminGeoJson) {
      const existingMap = globeMapRef.current;
      if (existingMap && !adminGeoJson) {
        try {
          if (existingMap.getLayer(ADMIN_GLOBE_FILL_LAYER_ID)) {
            existingMap.removeLayer(ADMIN_GLOBE_FILL_LAYER_ID);
          }
        } catch {}
        try {
          if (existingMap.getLayer(ADMIN_GLOBE_LINE_LAYER_ID)) {
            existingMap.removeLayer(ADMIN_GLOBE_LINE_LAYER_ID);
          }
        } catch {}
        try {
          if (existingMap.getSource(ADMIN_GLOBE_SOURCE_ID)) {
            existingMap.removeSource(ADMIN_GLOBE_SOURCE_ID);
          }
        } catch {}
      }
      return;
    }
    const readAdminProps = (props: Record<string, unknown> | null | undefined): { code: string | null; name: string } => {
      if (!props) {
        return { code: null, name: "unknown" };
      }
      const rawCode = props["_normCode"] ?? props["code"];
      const rawName = props["_displayName"] ?? props["_normName"];
      return {
        code: typeof rawCode === "string" ? rawCode : null,
        name: typeof rawName === "string" && rawName !== "" ? rawName : "unknown",
      };
    };
    if (map.getSource(ADMIN_GLOBE_SOURCE_ID)) {
      try {
        map.getSource(ADMIN_GLOBE_SOURCE_ID)?.setData(adminGeoJson as unknown as GlobePoiGeoJsonData as unknown as never);
      } catch {}
    } else {
      try {
        map.addSource(ADMIN_GLOBE_SOURCE_ID, {
          type: "geojson",
          data: adminGeoJson as unknown as GlobePoiGeoJsonData,
        } as unknown as Parameters<typeof map.addSource>[1]);
      } catch {
        return;
      }
      try {
        map.addLayer({
          id: ADMIN_GLOBE_FILL_LAYER_ID,
          type: "fill",
          source: ADMIN_GLOBE_SOURCE_ID,
          paint: { "fill-color": "transparent", "fill-opacity": 0 },
        });
        map.addLayer({
          id: ADMIN_GLOBE_LINE_LAYER_ID,
          type: "line",
          source: ADMIN_GLOBE_SOURCE_ID,
          paint: { "line-color": "#ffffff", "line-width": 1.2 },
        });
      } catch {}
      map.on("click", ADMIN_GLOBE_FILL_LAYER_ID, (e: GlobeMapMouseEventLike) => {
        if (placementRef.current) {
          return;
        }
        const feat = e.features?.[0];
        const { code, name } = readAdminProps(feat?.properties);
        if (code !== null) {
          setSelectedAdminCode(code);
          setSelectedAdminName(name);
        }
        try {
          (map.getCanvas() as unknown as HTMLElement)?.blur();
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        } catch {}
      });
      (map as unknown as { on: (type: string, fn: (e: unknown) => void) => void }).on(
        "click",
        (e: unknown) => {
          const lngLat = (e as { lngLat?: { lat?: unknown; lng?: unknown } } | null)?.lngLat;
          const lat = typeof lngLat?.lat === "number" ? lngLat.lat : NaN;
          const lon = typeof lngLat?.lng === "number" ? lngLat.lng : NaN;
          placeCastleAt(lat, lon);
        }
      );
      map.on("mousemove", ADMIN_GLOBE_FILL_LAYER_ID, (e: GlobeMapMouseEventLike) => {
        const feat = e.features?.[0];
        const { code } = readAdminProps(feat?.properties);
        setHoveredAdminCode(code);
        try {
          map.getCanvas().style.cursor = code ? "pointer" : "";
        } catch {}
      });
      map.on("mouseleave", ADMIN_GLOBE_FILL_LAYER_ID, () => {
        setHoveredAdminCode(null);
        try {
          map.getCanvas().style.cursor = "";
        } catch {}
      });
    }
  }, [adminGeoJson, mapStyle, isGlobeReady]);

  useEffect(() => {
    if (mapStyle !== "globe" || !isGlobeReady) {
      return;
    }
    const map = globeMapRef.current;
    if (!map) {
      return;
    }
    try {
      if (!map.getLayer(ADMIN_GLOBE_FILL_LAYER_ID) || !map.getLayer(ADMIN_GLOBE_LINE_LAYER_ID)) {
        return;
      }
      map.setPaintProperty(ADMIN_GLOBE_FILL_LAYER_ID, "fill-opacity", 0);
      if (selectedAdminCode) {
        map.setPaintProperty(ADMIN_GLOBE_LINE_LAYER_ID, "line-color", [
          "case",
          ["==", ["get", "_normCode"], selectedAdminCode],
          "#ff0000",
          "#ffffff",
        ]);
        map.setPaintProperty(ADMIN_GLOBE_LINE_LAYER_ID, "line-width", [
          "case",
          ["==", ["get", "_normCode"], selectedAdminCode],
          2.8,
          1.2,
        ]);
      } else {
        map.setPaintProperty(ADMIN_GLOBE_LINE_LAYER_ID, "line-color", "#ffffff");
        map.setPaintProperty(ADMIN_GLOBE_LINE_LAYER_ID, "line-width", 1.2);
      }
    } catch {}
  }, [selectedAdminCode, mapStyle, isGlobeReady]);

  useEffect(() => {
    if (mapStyle !== "cesium" || !isCesiumReady || !adminGeoJson) {
      const stale = cesiumAdminDataSourceRef.current;
      if (stale) {
        try {
          cesiumViewerRef.current?.dataSources.remove(stale, true);
        } catch {}
        cesiumAdminDataSourceRef.current = null;
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      const viewer = cesiumViewerRef.current;
      if (!viewer || viewer.isDestroyed()) {
        return;
      }
      const Cesium = (window as unknown as { Cesium?: typeof import("cesium") }).Cesium;
      if (!Cesium) {
        return;
      }
      if (cesiumAdminDataSourceRef.current) {
        try {
          viewer.dataSources.remove(cesiumAdminDataSourceRef.current, true);
        } catch {}
        cesiumAdminDataSourceRef.current = null;
      }
      let ds: CesiumTypes.DataSource;
      try {
        ds = await Cesium.GeoJsonDataSource.load(adminGeoJson as unknown as object, {
          stroke: Cesium.Color.fromCssColorString("#ffffff"),
          fill: Cesium.Color.TRANSPARENT,
          strokeWidth: 1.2,
          clampToGround: false,
        });
      } catch {
        return;
      }
      if (cancelled) {
        try {
          viewer.dataSources.remove(ds, true);
        } catch {}
        return;
      }
      try {
        viewer.dataSources.add(ds);
      } catch {
        return;
      }
      cesiumAdminDataSourceRef.current = ds;
      const selected = adminSelectedRef.current;
      for (const ent of ds.entities.values) {
        const bag = ent.properties as unknown as Record<string, { getValue?: () => unknown } | undefined> | undefined;
        const rawCode = bag?.["_normCode"]?.getValue?.() ?? bag?.["code"]?.getValue?.();
        const code = typeof rawCode === "string" ? rawCode : null;
        const isSel = code !== null && code === selected;
        const s = getBoundaryStyle(adminLevel, isSel, false);
        if (ent.polygon) {
          try {
            ent.polygon.material = (s.fillColor === "transparent"
              ? Cesium.Color.TRANSPARENT
              : Cesium.Color.fromCssColorString(s.fillColor).withAlpha(s.fillOpacity)) as unknown as CesiumTypes.PolygonGraphics["material"];
            ent.polygon.outlineColor = Cesium.Color.fromCssColorString(
              s.strokeColor
            ) as unknown as CesiumTypes.PolygonGraphics["outlineColor"];
            (ent.polygon as unknown as { outline?: unknown }).outline = new (
              Cesium as unknown as { ConstantProperty: new (v: boolean) => unknown }
            ).ConstantProperty(true) as unknown as typeof ent.polygon.outline;
            (ent.polygon as unknown as { outlineWidth?: unknown }).outlineWidth = new (
              Cesium as unknown as { ConstantProperty: new (v: number) => unknown }
            ).ConstantProperty(s.strokeWeight) as unknown as typeof ent.polygon.outlineWidth;
          } catch {}
        }
      }
      const viewerWithFlag = viewer as unknown as { _adminHandler?: { destroy?: () => void } };
      if (!viewerWithFlag._adminHandler) {
        try {
          const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
          handler.setInputAction((movement: { position?: unknown }) => {
            if (placementRef.current) {
              try {
                const cartesian = viewer.camera.pickEllipsoid(
                  movement.position as never,
                  viewer.scene.globe.ellipsoid
                ) as unknown as { x?: unknown } | undefined;
                if (cartesian) {
                  const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(
                    cartesian as never
                  ) as unknown as { latitude?: unknown; longitude?: unknown } | undefined;
                  const lat =
                    typeof cartographic?.latitude === "number"
                      ? (cartographic.latitude as number) * (180 / Math.PI)
                      : NaN;
                  const lon =
                    typeof cartographic?.longitude === "number"
                      ? (cartographic.longitude as number) * (180 / Math.PI)
                      : NaN;
                  placeCastleAt(lat, lon);
                }
              } catch {}
              return;
            }
            const picked = (viewer.scene.pick as (pos: unknown) => { id?: unknown } | undefined)(
              movement.position
            );
            const ent = picked?.id as
              | { properties?: Record<string, { getValue?: () => unknown } | undefined> }
              | undefined;
            const rawCode = ent?.properties?.["_normCode"]?.getValue?.();
            if (typeof rawCode === "string") {
              const rawName = ent?.properties?.["_displayName"]?.getValue?.();
              setSelectedAdminCode(rawCode);
              setSelectedAdminName(typeof rawName === "string" && rawName !== "" ? rawName : rawCode);
              try {
                (viewer.scene.canvas as unknown as HTMLElement)?.blur();
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
              } catch {}
            }
          }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
          handler.setInputAction((movement: { endPosition?: unknown }) => {
            const picked = (viewer.scene.pick as (pos: unknown) => { id?: unknown } | undefined)(
              movement.endPosition
            );
            const ent = picked?.id as
              | { properties?: Record<string, { getValue?: () => unknown } | undefined> }
              | undefined;
            const rawCode = ent?.properties?.["_normCode"]?.getValue?.();
            const code = typeof rawCode === "string" ? rawCode : null;
            setHoveredAdminCode(code);
            try {
              viewer.scene.canvas.style.cursor = code ? "pointer" : "default";
            } catch {}
          }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
          viewerWithFlag._adminHandler = handler as unknown as { destroy?: () => void };
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminGeoJson, mapStyle, isCesiumReady, adminLevel]);

  useEffect(() => {
    const ds = cesiumAdminDataSourceRef.current;
    if (!ds || mapStyle !== "cesium" || !isCesiumReady) {
      return;
    }
    const Cesium = (window as unknown as { Cesium?: typeof import("cesium") }).Cesium;
    if (!Cesium) {
      return;
    }
    for (const ent of ds.entities.values) {
      const bag = ent.properties as unknown as Record<string, { getValue?: () => unknown } | undefined> | undefined;
      const rawCode = bag?.["_normCode"]?.getValue?.() ?? bag?.["code"]?.getValue?.();
      const code = typeof rawCode === "string" ? rawCode : null;
      const isSel = code !== null && code === selectedAdminCode;
      const isHov = code !== null && code === hoveredAdminCode;
      const s = getBoundaryStyle(adminLevel, isSel, isHov);
      if (ent.polygon) {
        try {
          ent.polygon.material = (s.fillColor === "transparent"
            ? Cesium.Color.TRANSPARENT
            : Cesium.Color.fromCssColorString(s.fillColor).withAlpha(s.fillOpacity)) as unknown as CesiumTypes.PolygonGraphics["material"];
          ent.polygon.outlineColor = Cesium.Color.fromCssColorString(
            s.strokeColor
          ) as unknown as CesiumTypes.PolygonGraphics["outlineColor"];
          (ent.polygon as unknown as { outline?: unknown }).outline = new (
            Cesium as unknown as { ConstantProperty: new (v: boolean) => unknown }
          ).ConstantProperty(true) as unknown as typeof ent.polygon.outline;
          (ent.polygon as unknown as { outlineWidth?: unknown }).outlineWidth = new (
            Cesium as unknown as { ConstantProperty: new (v: number) => unknown }
          ).ConstantProperty(s.strokeWeight) as unknown as typeof ent.polygon.outlineWidth;
        } catch {}
      }
    }
  }, [selectedAdminCode, hoveredAdminCode, adminLevel, mapStyle, isCesiumReady]);

  const handleGoToQR = useCallback(() => {
    router.push("/qr");
  }, [router]);

  const handleToggleRankingPanel = useCallback(() => {
    setShowRankingPanel((previous) => !previous);
  }, []);


  const handleExit = useCallback(async () => {
    await signOut({ redirect: false });
    router.push("/");
  }, [router]);

  const handleResetScore = useCallback(async () => {
    try {
      const res = await fetch("/api/resetscore", { 
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        console.log("[ResetScore] score reset to 0, reloading page");
        clearAllGameSnapshots();
        window.location.reload();
      } else {
        console.error("[ResetScore] API returned error", res.status);
      }
    } catch (e) {
      console.error("[ResetScore] failed", e);
    }
  }, []);

  const handleAnimationComplete = useCallback(() => {
    console.log("[Animation] onComplete - animation finished, URL cleanup");
    animationCompleteRef.current = true;
    setAnimateScore(false);
    scoreCelebrationPendingRef.current = false;
    celebrateVisitedMarkers();
    router.replace("/map");
  }, [router, celebrateVisitedMarkers]);

  return (
    <section
      className={cn("relative isolate flex h-full w-full overflow-hidden", className)}
      aria-label="현재 위치 지도"
    >
      {viewportDebugLines.length > 0 ? (
        <div className="pointer-events-none fixed left-2 top-24 z-[5000] max-w-[92vw] overflow-hidden rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-tight text-lime-200">
          {viewportDebugLines.map((line, i) => (
            <p key={i} className="whitespace-pre-wrap break-all">{line}</p>
          ))}
        </div>
      ) : null}
      <div
        ref={mapContainerRef}
        className="absolute inset-0 h-full w-full overflow-hidden"
        style={{
          minHeight: "100dvh",
          display: mapStyle === "satellite" ? undefined : "none",
        }}
      />
      <div
        ref={globeContainerRef}
        className="absolute inset-0 h-full w-full overflow-hidden"
        style={{
          minHeight: "100dvh",
          display: mapStyle === "globe" ? undefined : "none",
        }}
      />
      <div
        ref={cesiumContainerRef}
        className="absolute inset-0 h-full w-full overflow-hidden"
        style={{
          minHeight: "100dvh",
          display: mapStyle === "cesium" ? undefined : "none",
        }}
      />

      {showOverlay ? (
        <div
          className={cn(
            "absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center text-white",
            status === "error" ? "pointer-events-auto" : "pointer-events-none"
          )}
        >
          {status === "error" ? (
            <>
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-red-300/40 bg-red-500/20">
                <svg className="h-7 w-7 text-red-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                  <line x1="4" y1="4" x2="20" y2="20" />
                </svg>
              </div>
              <div>
                <p className="text-base font-semibold">{statusLabel}</p>
                <p className="text-sm text-white/70">{subtitle}</p>
              </div>
              <button
                type="button"
                onClick={requestLocation}
                className="rounded-lg border border-sky-300/50 bg-sky-500 px-5 py-2 text-sm font-semibold text-white shadow-[0_4px_14px_rgba(14,165,233,0.4)] transition hover:bg-sky-400 active:scale-95"
              >
                위치 권한 다시 요청
              </button>
              {permissionState === "denied" ? (
                <p className="max-w-xs text-xs leading-relaxed text-white/60">
                  브라우저에서 위치 접근이 차단되어 있습니다. 주소창의 자물쇠(또는 설정) 아이콘 → 사이트 설정 → 위치 허용으로 변경한 뒤 다시 요청을 눌러주세요.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="h-14 w-14 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              <div>
                <p className="text-base font-semibold">{statusLabel}</p>
                <p className="text-sm text-white/70">{subtitle}</p>
              </div>
            </>
          )}
        </div>
      ) : null}

      {showRankingPanel && !territoryEnabled ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 z-[1250]">
          <div className="pointer-events-none absolute left-3 top-3 z-[1260]">
            <button
              type="button"
              onClick={() => setShowRankingPanel(false)}
              className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/50 backdrop-blur-sm shadow-lg transition hover:bg-black/70"
            >
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
          </div>
          <div className="pointer-events-auto h-full w-full overflow-hidden border-y border-indigo-200/35 pb-[env(safe-area-inset-bottom)] shadow-[0_20px_40px_rgba(15,23,42,0.58)]">
            <Ranking
              embedded
              items={rankingItems}
              myNickname={rankingNickname ?? playerNickname ?? "PLAYER"}
            />
          </div>
        </div>
      ) : null}

      {showAdminBoundaries && selectedAdminCode ? (
        <div
          className={cn(
            "pointer-events-auto absolute left-3 z-[1210] flex max-w-[70%] items-center gap-2",
            territoryEnabled ? "top-[7rem]" : "top-[3.75rem]",
            "rounded-full border border-amber-200/60 bg-black/60 px-3 py-1.5 backdrop-blur-xl",
            "shadow-[0_10px_24px_rgba(0,0,0,0.34)]"
          )}
          role="status"
          aria-label="선택된 행정구역"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
          <p className="truncate text-xs font-bold text-white">
            선택: {selectedAdminDisplayName ?? selectedAdminCode}
          </p>
          <button
            type="button"
            aria-label="행정구역 선택 해제"
            onClick={() => {
              setSelectedAdminCode(null);
              setSelectedAdminName(null);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/15 text-[11px] font-bold leading-none text-white transition hover:bg-white/30"
          >
            ×
          </button>
        </div>
      ) : null}

      {territoryEnabled && territoryLegend.length > 0 ? (
        <div
          className={cn(
            "pointer-events-auto absolute left-3 z-[1205] flex max-h-28 w-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-white/20 bg-black/60 px-2 py-1.5 shadow-lg backdrop-blur-sm",
            selectedAdminCode ? "top-[9.75rem]" : "top-[7rem]",
          )}
          aria-label="영토 범례"
        >
          {territoryLegend.map((entry) => (
            <div key={entry.ownerId} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: territoryOwnerColor(entry.ownerId) }}
              />
              <span className="truncate text-[11px] font-bold text-white/90">
                {entry.nickname || "무명"}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-white/60">
                {entry.count}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {!territoryEnabled && !showRankingPanel && totalMarkerCount > 0 && unvisitedMarkerCount === 0 ? (
        <div
          role="alertdialog"
          aria-live="polite"
          aria-label="모든 미션 완료"
          className="pointer-events-auto absolute left-1/2 top-[4.25rem] z-[2000] w-max max-w-[92%] -translate-x-1/2 overflow-hidden rounded-2xl border-2 border-emerald-200/50 bg-[linear-gradient(135deg,#064e3b_0%,#022c22_60%,#020617_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-center gap-2.5 px-4 py-3">
            <span className="text-2xl" aria-hidden="true">
              🎉
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black text-emerald-50">모든 미션 완료!</p>
              <p className="truncate text-xs font-semibold text-emerald-200/80">
                전체 {totalMarkerCount}개 마커를 모두 방문했습니다
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {attackDenied ? (
        <div
          role="alertdialog"
          aria-live="polite"
          aria-label="공격 실패"
          className="pointer-events-auto fixed left-1/2 top-1/2 z-[2000] w-max max-w-[92%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border-2 border-amber-200/50 bg-[linear-gradient(135deg,#1e293b_0%,#0f172a_55%,#020617_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
        >
          <div className="flex flex-col items-center gap-3 px-6 py-5 text-center">
            <p className="text-base font-black text-amber-50">
              {attackDenied === "gone"
                ? "무법자가 이미 사라졌습니다"
                : "무법자가 범위에서 벗어났습니다"}
            </p>
            <p className="text-xs text-slate-300">
              15m 이내로 접근한 뒤 다시 공격해 주세요.
            </p>
            <button
              type="button"
              onClick={() => {
                setAttackDenied(null);
                router.replace("/map");
              }}
              className="rounded-lg border border-amber-200/50 bg-amber-300/15 px-5 py-2 text-sm font-bold text-amber-50 transition hover:bg-amber-300/25"
            >
              확인
            </button>
          </div>
        </div>
      ) : null}

      {showEventRevisited ? (
        <div
          role="alertdialog"
          aria-live="polite"
          aria-label="이미 진행한 이벤트"
          className="pointer-events-auto fixed left-1/2 top-1/2 z-[2000] w-max max-w-[92%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border-2 border-amber-200/50 bg-[linear-gradient(135deg,#1e293b_0%,#0f172a_55%,#020617_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
        >
          <div className="flex flex-col items-center gap-3 px-6 py-5 text-center">
            <p className="text-base font-black text-amber-50">이미 진행한 이벤트입니다</p>
            <button
              type="button"
              onClick={() => {
                setShowEventRevisited(false);
                router.replace("/map");
              }}
              className="rounded-lg border border-amber-200/50 bg-amber-300/15 px-5 py-2 text-sm font-bold text-amber-50 transition hover:bg-amber-300/25"
            >
              지도로 이동
            </button>
          </div>
        </div>
      ) : null}

      {markerPanel ? (
        <div
          className={
            territoryEnabled
              ? (() => {
                  // 중립성·무법자 정보창은 하단 가운데, 나머지는 화면 중앙.
                  const isQuizEntry =
                    markerPanel.wildId !== undefined ||
                    (markerPanel.eventKey !== undefined && isNeutralEventKey(markerPanel.eventKey));
                  return isQuizEntry
                    ? "pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] left-1/2 z-[1200] mx-auto w-max min-w-[35%] max-w-[92%] -translate-x-1/2 overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#1e293b_0%,#0f172a_55%,#020617_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
                    : "pointer-events-auto fixed left-1/2 top-1/2 z-[1200] mx-auto w-max min-w-[35%] max-w-[92%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#1e293b_0%,#0f172a_55%,#020617_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.55)]";
                })()
              : "pointer-events-auto absolute bottom-[calc(env(safe-area-inset-bottom)+7.25rem)] left-1/2 z-[1200] w-max min-w-[35%] max-w-[92%] -translate-x-1/2 overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#1e293b_0%,#0f172a_55%,#020617_100%)] shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
          }
        >
          <div className="flex items-center gap-2.5 border-b border-amber-200/25 bg-amber-300/10 px-3.5 py-2.5">
            <div
              className="relative flex h-8 w-8 shrink-0 touch-none select-none items-center justify-center rounded-md border border-amber-200/35 bg-amber-200/15"
              style={{ WebkitTouchCallout: "none" }}
              onTouchStart={() => setShowPanelEventKey(true)}
              onTouchEnd={() => setShowPanelEventKey(false)}
              onTouchCancel={() => setShowPanelEventKey(false)}
              onMouseDown={() => setShowPanelEventKey(true)}
              onMouseUp={() => setShowPanelEventKey(false)}
              onMouseLeave={() => setShowPanelEventKey(false)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <svg className="h-4 w-4 text-amber-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              {markerPanel.eventKey && showPanelEventKey ? (
                <div className="absolute left-full top-1/2 z-10 ml-2 w-max max-w-[13rem] -translate-y-1/2 rounded-lg border border-slate-600/60 bg-slate-900/95 px-2.5 py-1.5 text-left shadow-xl">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">EventKey</p>
                  <p className="whitespace-pre-line break-all text-[11px] font-semibold text-slate-50">{markerPanel.eventKey}</p>
                </div>
              ) : null}
            </div>
            <p className="min-w-0 flex-1 truncate text-sm font-bold text-amber-50">{markerPanel.title}</p>
          </div>
          <div className="space-y-1.5 px-4 py-3">
            {markerPanel.lines.map((line, index) => {
              const [label, value] = line.split(": ");
              return (
                <div key={`${markerPanel.title}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-400">{label}</span>
                  <span className="max-w-[60%] truncate text-right font-semibold text-slate-50">{value}</span>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 border-t border-amber-200/15 bg-amber-200/5 px-4 py-2.5">
            {Number.isFinite(markerPanel.lat) && Number.isFinite(markerPanel.lon)
              ? (() => {
                  // 대상이 이미 지도 화면 안에 있으면 버튼을 숨긴다.
                  const tlat = markerPanel.lat as number;
                  const tlon = markerPanel.lon as number;
                  try {
                    const map = mapInstanceRef.current;
                    const bounds = map?.getBounds?.();
                    if (bounds?.contains?.([tlat, tlon])) {
                      return null;
                    }
                  } catch {
                    // bounds 확인 실패 시 버튼을 표시한다.
                  }
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        panTerritoryTo(tlat, tlon);
                      }}
                      className="whitespace-nowrap rounded-lg border border-sky-300/50 bg-sky-600/80 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500/80"
                    >
                      위치로 이동
                    </button>
                  );
                })()
              : null}
            <button
              type="button"
              onClick={closeMarkerPanel}
              className="whitespace-nowrap rounded-lg border border-slate-600/60 bg-slate-800/80 px-4 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700/80"
            >
              닫기
            </button>
            {markerPanel.isProximity && markerPanel.confirmTarget ? (
              <button
                type="button"
                onClick={handleConfirmPanel}
                className="rounded-lg border border-emerald-300/50 bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-white shadow-[0_4px_14px_rgba(16,185,129,0.4)] transition hover:bg-emerald-400"
              >
                {markerPanel.confirmLabel ?? "실행"}
              </button>
            ) : null}
            {!markerPanel.isProximity &&
            (markerPanel.wildId !== undefined ||
              (markerPanel.eventKey && isNeutralEventKey(markerPanel.eventKey)))
              ? (() => {
                  // 무법자· 중립성 공용: 인접 시 진입 버튼, 범위 밖이면 안내 문구.
                  const isWild = markerPanel.wildId !== undefined;
                  const rangeM = isWild ? WILD_ATTACK_RANGE_M : NEUTRAL_QUIZ_RANGE_M;
                  const plat = markerPanel.lat;
                  const plon = markerPanel.lon;
                  let inRange = false;
                  if (Number.isFinite(plat) && Number.isFinite(plon)) {
                    const base = playerLocation;
                    if (
                      base &&
                      Number.isFinite(base.lat) &&
                      Number.isFinite(base.lon) &&
                      calculateDistance(base.lat, base.lon, plat as number, plon as number) <= rangeM
                    ) {
                      inRange = true;
                    }
                    if (!inRange) {
                      inRange = unitMarks.some(
                        (mark) =>
                          mark.mine &&
                          Number.isFinite(mark.lat) &&
                          Number.isFinite(mark.lon) &&
                          calculateDistance(mark.lat, mark.lon, plat as number, plon as number) <=
                            rangeM,
                      );
                    }
                  }
                  if (!inRange) {
                    return (
                      <p className="px-4 py-2.5 text-xs text-slate-400">
                        {rangeM}m 이내로 접근(본체 또는 부대)해야 {isWild ? "공격" : "퀴즈 풀기"}할 수
                        있습니다.
                      </p>
                    );
                  }
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        closeMarkerPanel();
                        if (isWild) {
                          router.push("/map");
                        } else {
                          router.push(
                            "/map",
                          );
                        }
                      }}
                      className="rounded-lg border border-emerald-300/50 bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-white shadow-[0_4px_14px_rgba(16,185,129,0.4)] transition hover:bg-emerald-400"
                    >
                      {isWild ? "공격" : "퀴즈 풀기"}
                    </button>
                  );
                })()
              : null}
          </div>
        </div>
      ) : null}

      {edgeIndicators.length > 0 ? (
        <div className="pointer-events-none absolute inset-0 z-[1100]">
          {edgeIndicators.map((indicator) => {
            const edge = resolveIndicatorEdge(indicator);

            const indicatorNode = (
              <span className="inline-flex shrink-0 items-center gap-1 leading-none">
                {edgeIndicatorIconDataUrl ? (
                  <img
                    src={edgeIndicatorIconDataUrl}
                    alt="방향 표시"
                    className="h-4 w-4 object-contain"
                    style={{ transform: `rotate(${indicator.angle}deg)` }}
                  />
                ) : (
                  <span
                    className="inline-block text-[10px] leading-none"
                    style={{ transform: `rotate(${indicator.angle}deg)` }}
                  >
                    ▲
                  </span>
                )}
                <span className="inline-flex items-center tabular-nums leading-none">{indicator.count}</span>
              </span>
            );

            const distanceNode = indicator.nearestDistanceMeters !== null ? (
              <span className="inline-flex items-center tabular-nums text-[10px] leading-none text-amber-200/95">
                {formatEdgeIndicatorDistance(indicator.nearestDistanceMeters)}
              </span>
            ) : null;

            const directionClass =
              edge === "top" || edge === "bottom" ? "flex-col items-center" : "flex-row items-center";
            const rightEdgeWidthClass = edge === "right" ? "min-w-[88px] pr-3" : "";

            return (
              <div
                key={indicator.id}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${indicator.left}px`, top: `${indicator.top}px` }}
              >
                <div
                  className={`select-none whitespace-nowrap flex ${directionClass} ${rightEdgeWidthClass} gap-1 rounded-full border border-amber-200/45 bg-black/70 px-2 py-1 text-[11px] font-bold text-amber-100 shadow-[0_8px_20px_rgba(0,0,0,0.35)]`}
                >
                  {edge === "right" ? distanceNode : null}
                  {edge === "bottom" ? distanceNode : null}
                  {indicatorNode}
                  {edge === "left" || edge === "top" ? distanceNode : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className={`pointer-events-none absolute top-3 z-1200 ${territoryEnabled ? "left-3 right-12" : "left-3 flex w-auto max-w-[calc(100%-6rem)] items-center gap-1.5"}`}>
        {territoryEnabled ? (
          <>
            <TerritoryDash />
          </>
        ) : (
        <>
        <div className="pointer-events-auto flex w-auto flex-row items-center gap-1.5 rounded-md border border-amber-200/40 bg-black/60 px-2 py-1 text-amber-100 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.32)]">
          <span className="text-center text-[11px] font-bold leading-none">점수</span>
          <AnimatedScoreCounter
            value={typeof playerScore === "number" ? playerScore : 0}
            startFrom={previousScore}
            shouldAnimate={animateScore}
            onAnimationComplete={handleAnimationComplete}
            duration={3000}
          />
        </div>
        <div
          className="pointer-events-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-amber-200/40 bg-black/60 px-2 py-1 text-amber-100 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.32)]"
          title={`미방문 마커 ${unvisitedMarkerCount}개 / 전체 ${totalMarkerCount}개`}
          aria-label={`미방문 마커 ${unvisitedMarkerCount}개, 전체 ${totalMarkerCount}개`}
        >
          <span className="text-center text-[11px] font-bold leading-none">미방문</span>
          <span className="flex h-5 items-center text-sm font-extrabold leading-none tabular-nums">
            {unvisitedMarkerCount}/{totalMarkerCount}
          </span>
        </div>
        <div
          className="pointer-events-auto flex shrink-0 items-center whitespace-nowrap rounded-md border border-amber-200/40 bg-black/60 px-2 py-1 text-amber-100 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.32)]"
          title={myRank !== null ? `현재 등수 ${myRank}위` : "현재 등수 확인 불가"}
          aria-label={myRank !== null ? `현재 등수 ${myRank}위` : "현재 등수 확인 불가"}
        >
          <span className="flex h-5 items-center text-sm font-extrabold leading-none tabular-nums">
            {myRank !== null ? `${myRank}위` : "-"}
          </span>
        </div>
        </>
        )}
      </div>

      <div className="pointer-events-none absolute right-4 top-4 z-[1200]">
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (isHeadingUpMode) {
                setIsHeadingUpMode(false);
              } else {
                enableHeadingUpMode();
              }
            }}
            className="pointer-events-auto mb-2 flex h-8 w-8 items-center justify-center rounded-xl border border-white/25 bg-black/55 p-0.5 text-white backdrop-blur-xl shadow-[0_10px_24px_rgba(0,0,0,0.34)] transition active:translate-y-0.5"
            aria-label={isHeadingUpMode ? "북쪽 고정 모드로 전환" : "진행방향 고정 모드로 전환"}
            title={isHeadingUpMode ? "진행방향 고정 모드: 켜짐" : "북쪽 고정 모드: 켜짐"}
          >
            <span
              className="pointer-events-none absolute text-[10px] font-black leading-none text-rose-400 drop-shadow-[0_0_4px_rgba(248,113,113,0.45)]"
              style={{ transform: `rotate(${mapVisualRotationDeg.toFixed(2)}deg) translateY(-13px)` }}
            >
              N
            </span>
            {compassIconDataUrl ? (
              <img
                src={compassIconDataUrl}
                alt="나침반"
                className="h-7 w-7 object-contain"
                style={{ transform: `rotate(${mapVisualRotationDeg.toFixed(2)}deg)` }}
              />
            ) : (
              <span className="text-xs font-black leading-none text-emerald-200">◎</span>
            )}
          </button>

          {status === "success" && location?.accuracy !== undefined ? (
            (() => {
              const tier = gpsAccuracyTier(location.accuracy);
              return (
                <div
                  className="pointer-events-auto absolute right-full top-0 mr-2 inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-sky-200/35 bg-black/60 px-2 py-1 text-[10px] font-semibold text-sky-100 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.32)]"
                  title={`GPS 상태: ${tier} (${location.accuracy.toFixed(1)}m)`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className="h-5 w-5 text-sky-200"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M13 7 9 3 5 7l4 4" />
                    <path d="m17 11 4 4-4 4-4-4" />
                    <path d="m8 12 4 4 6-6-4-4Z" />
                    <path d="m16 8 3-3" />
                    <path d="M9 21a6 6 0 0 0-6-6" />
                  </svg>
                  <span className={GPS_ACCURACY_TIER_TEXT_CLASS[tier]}>{tier}</span>
                </div>
              );
            })()
          ) : null}

          <div className="pointer-events-auto flex w-8 flex-col items-center gap-1.5 rounded-xl border border-white/25 bg-black/55 py-1.5 text-white backdrop-blur-xl shadow-[0_10px_24px_rgba(0,0,0,0.34)]">
            <button
              type="button"
              aria-label="지도 확대"
              onClick={handleZoomIn}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-white/15 text-xs font-bold leading-none text-white transition active:translate-y-0.5"
            >
              +
            </button>

            <div className="flex h-16 w-5 items-center justify-center">
              <input
                type="range"
                min={ZOOM_RANGE_BY_STYLE[mapStyle].min}
                max={ZOOM_RANGE_BY_STYLE[mapStyle].max}
                step={1}
                value={zoomLevel}
                onChange={handleZoomSliderChange}
                aria-label="지도 축소 확대 슬라이더"
                className="map-zoom-slider -rotate-90"
              />
            </div>

            <button
              type="button"
              aria-label="지도 축소"
              onClick={handleZoomOut}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-white/15 text-xs font-bold leading-none text-white transition active:translate-y-0.5"
            >
              -
            </button>
          </div>
          <div
            className="mt-1 flex w-12 justify-center gap-1 text-[9px] leading-none text-white/60"
            aria-hidden="true"
          >
            <span>{ZOOM_RANGE_BY_STYLE[mapStyle].min}</span>
            <span className="text-white/40">/</span>
            <span className="font-bold text-white">{zoomLevel}</span>
            <span className="text-white/40">/</span>
            <span>{ZOOM_RANGE_BY_STYLE[mapStyle].max}</span>
          </div>

          <button
            type="button"
            aria-label="설정"
            onClick={() => {
              setShowSettingsModal(true);
            }}
            className="pointer-events-auto mt-2 flex h-8 w-8 items-center justify-center rounded-xl border border-white/25 bg-black/55 text-white backdrop-blur-xl shadow-[0_10px_24px_rgba(0,0,0,0.34)] transition active:translate-y-0.5"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.55V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.04-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1.04H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.87L4.2 6.07a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.7 1.7 0 0 0 8.96 3a1.7 1.7 0 0 0 1.04-1.55V1.4a2 2 0 0 1 4 0v.09A1.7 1.7 0 0 0 15.04 3a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 1.55 1.04H21a2 2 0 0 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
            </svg>
          </button>
        </div>
      </div>

      {walkableLoading && territoryEnabled ? (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-[1250] -translate-x-1/2 -translate-y-1/2">
          <div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-3 py-1.5 shadow-lg backdrop-blur-sm">
            <div className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            <span className="text-xs font-semibold text-white/90">
              {walkablePending ? `이동가능영역 불러오는 중 (${walkablePending.done}/${walkablePending.total})` : "이동가능영역 불러오는 중"}
            </span>
          </div>
        </div>
      ) : null}

      {!territoryEnabled ? (
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[1000]">
        <div
          ref={bottomToolbarRef}
          className="pointer-events-auto relative flex w-full justify-center border-t border-indigo-900/50 px-4 py-1"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.55),rgba(49,46,129,0.85)_80%,rgba(49,46,129,1))]" />
          <div className="relative flex items-center gap-6">
            <button
              type="button"
              onClick={handleToggleRankingPanel}
              aria-pressed={showRankingPanel}
              className={`relative h-14 w-14 shrink-0 rounded-lg border backdrop-blur-md active:translate-y-0.5 ${
                showRankingPanel
                  ? "translate-y-0.5 border-emerald-200/80 bg-white/25 shadow-[inset_0_2px_8px_rgba(15,23,42,0.55)]"
                  : "border-white/20 bg-white/10 shadow-lg shadow-indigo-900/30"
              }`}
            >
              <img
                src={showRankingPanel ? "/globe.svg" : "/ranking_icon.png"}
                alt={showRankingPanel ? "지도" : "랭킹"}
                className="h-full w-full rounded-lg object-contain px-1 pt-[2px] pb-4"
              />
              <span className="absolute inset-x-0 bottom-1 text-center text-[9px] font-semibold leading-none text-white drop-shadow-md">{showRankingPanel ? "지도" : "랭킹"}</span>
            </button>
            <button
              type="button"
              onClick={handleGoToQR}
              className="relative h-14 w-14 shrink-0 rounded-lg border border-white/20 bg-white/10 backdrop-blur-md shadow-lg shadow-indigo-900/30 active:translate-y-0.5"
            >
              <img src="/qrreader_icon.png" alt="QR" className="h-full w-full rounded-lg object-contain px-1 pt-[2px] pb-4" />
              <span className="absolute inset-x-0 bottom-1 text-center text-[9px] font-semibold leading-none text-white drop-shadow-md">QR읽기</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void handleExit();
              }}
              className="relative h-14 w-14 shrink-0 rounded-lg border border-white/20 bg-white/10 backdrop-blur-md shadow-lg shadow-indigo-900/30 active:translate-y-0.5"
            >
              <img src="/exit_icon.png" alt="나가기" className="h-full w-full rounded-lg object-contain px-1 pt-[2px] pb-4" />
              <span className="absolute inset-x-0 bottom-1 text-center text-[9px] font-semibold leading-none text-white drop-shadow-md">나가기</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void handleResetScore();
              }}
              className="relative h-14 w-14 shrink-0 rounded-lg border border-white/20 bg-white/10 backdrop-blur-md shadow-lg shadow-indigo-900/30 active:translate-y-0.5"
            >
              <img src="/exit_icon.png" alt="점수리셋" className="h-full w-full rounded-lg object-contain px-1 pt-[2px] pb-4" />
              <span className="absolute inset-x-0 bottom-1 text-center text-[9px] font-semibold leading-none text-white drop-shadow-md">점수리셋</span>
            </button>
          </div>
        </div>
      </div>
      ) : null}

      {showSettingsModal ? (
        <div className="pointer-events-auto fixed inset-0 z-[2100] bg-white">
          <div className="flex h-full w-full flex-col px-5 py-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="설정 닫기"
                onClick={() => {
                  setShowSettingsModal(false);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 text-slate-700 transition active:scale-95"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <h2 className="text-lg font-bold text-slate-900">설정</h2>
              <div className="h-10 w-10" aria-hidden="true" />
            </div>

            <div className="mt-8 min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain pb-10">
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-base font-semibold text-slate-900">계정 정보</h3>
                <div className="space-y-1">
                  <p className="text-xs text-slate-500">아이디</p>
                  <p className="break-all text-sm font-bold text-slate-900">{locationCacheKey}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-slate-500">ARMissionKey</p>
                  <p className="break-all text-sm font-bold text-slate-900">{missionKey ?? "-"}</p>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-base font-semibold text-slate-900">조작 설정</h3>

                {territoryEnabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      setStartPickerOpen(true);
                      setShowSettingsModal(false);
                    }}
                    className="flex w-full items-center justify-between rounded-2xl border border-slate-300 bg-white px-4 py-4 text-left transition"
                  >
                    <div>
                      <p className="text-sm font-bold text-slate-900">시작 위치 변경</p>
                      <p className="text-xs text-slate-500">
                        {territoryStart
                          ? `${territoryStart.sido} ${territoryStart.sigungu} ${territoryStart.dong}`
                          : "미설정"}
                      </p>
                    </div>
                    <span className="rounded-full border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600">
                      변경
                    </span>
                  </button>
                ) : null}

              </div>

              <div className="space-y-3">
                <h3 className="text-base font-semibold text-slate-900">지도 스타일</h3>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setMapStyle("satellite")}
                    aria-pressed={mapStyle === "satellite"}
                    className={cn(
                      "rounded-2xl border px-4 py-4 text-left transition",
                      mapStyle === "satellite"
                        ? "border-sky-400 bg-sky-50"
                        : "border-slate-300 bg-white"
                    )}
                  >
                    <p className="text-sm font-bold text-slate-900">위성 지도</p>
                    <p className="text-xs text-slate-500">기존 Esri 위성</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMapStyle("globe")}
                    aria-pressed={mapStyle === "globe"}
                    className={cn(
                      "rounded-2xl border px-4 py-4 text-left transition",
                      mapStyle === "globe"
                        ? "border-sky-400 bg-sky-50"
                        : "border-slate-300 bg-white"
                    )}
                  >
                    <p className="text-sm font-bold text-slate-900">지구본 지도</p>
                    <p className="text-xs text-slate-500">MapLibre 지구본</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMapStyle("cesium")}
                    aria-pressed={mapStyle === "cesium"}
                    className={cn(
                      "rounded-2xl border px-4 py-4 text-left transition",
                      mapStyle === "cesium"
                        ? "border-sky-400 bg-sky-50"
                        : "border-slate-300 bg-white"
                    )}
                  >
                    <p className="text-sm font-bold text-slate-900">3D 지구</p>
                    <p className="text-xs text-slate-500">Cesium 3D</p>
                  </button>
                </div>
                <p className="text-xs text-slate-500">{mapStyle === "cesium" ? "3D 지구본으로 위성 지도를 표시합니다 (Cesium)" : mapStyle === "globe" ? "지구본 형태로 위성 지도를 표시합니다 (MapLibre)" : "기존 위성 지도 (Esri)를 표시합니다"}</p>
              </div>

              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-slate-900">행정구역 표시</h4>
                  <label className={`relative inline-flex items-center ${territoryEnabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      checked={territoryEnabled || showAdminBoundaries}
                      disabled={territoryEnabled}
                      onChange={(e) => {
                        if (!territoryEnabled) {
                          setShowAdminBoundaries(e.target.checked);
                        }
                      }}
                      className="peer sr-only"
                    />
                    <div className="peer h-6 w-11 rounded-full bg-slate-300 peer-checked:bg-sky-500 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition" />
                  </label>
                </div>
                {territoryEnabled ? (
                  <p className="text-xs text-slate-500">영토전 모드에서는 항상 표시됩니다</p>
                ) : null}
                {territoryEnabled || showAdminBoundaries ? (
                  <>
                    <label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                      <span className="text-sm font-medium text-slate-700">
                        지도 중심 따라 자동 전환{adminAutoCountry && adminCountry ? ` (${adminCountry})` : ""}
                      </span>
                      <input
                        type="checkbox"
                        checked={adminAutoCountry}
                        onChange={(e) => setAdminAutoCountry(e.target.checked)}
                        className="h-4 w-4 accent-sky-500"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={adminCountry}
                        disabled={adminAutoCountry}
                        onChange={(e) => {
                          setAdminCountry(e.target.value);
                          setSelectedAdminCode(null);
                          setSelectedAdminName(null);
                        }}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-1 text-sm disabled:opacity-50"
                      >
                        {SUPPORTED_COUNTRIES.map((iso) => (
                          <option key={iso} value={iso}>
                            {iso}
                          </option>
                        ))}
                      </select>
                      <select
                        value={adminLevel}
                        onChange={(e) => {
                          setAdminLevel(e.target.value as AdminLevel);
                          setSelectedAdminCode(null);
                          setSelectedAdminName(null);
                        }}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-1 text-sm"
                      >
                        {(["country", "sido", "sigungu", "dong"] as AdminLevel[]).map((lv) => (
                          <option key={lv} value={lv}>
                            {ADMIN_LEVEL_LABEL[lv]}
                          </option>
                        ))}
                      </select>
                    </div>
                    {adminLoading ? <p className="text-xs text-slate-500">불러오는 중…</p> : null}
                    {selectedAdminName ? (
                      <div className="rounded-xl border border-amber-300 bg-white px-3 py-2">
                        <p className="text-xs text-slate-500">선택된 구역</p>
                        <p className="text-sm font-bold text-slate-900">
                          {selectedAdminName}
                        </p>
                      </div>
                    ) : null}
                    {!selectedAdminName && !adminLoading ? (
                      <p className="text-xs text-slate-500">
                        구역을 클릭하면 이름이 표시됩니다 ({ADMIN_LEVEL_LABEL[adminLevel]} 수준)
                      </p>
                    ) : null}
                    <p className="text-[11px] text-slate-400">
                      {`데이터: /boundaries/${adminCountry.toLowerCase()}_${adminLevel}.topojson${useDongHd ? ` · 확대(z${DONG_HD_MIN_ZOOM}+) 시 고해상도 경계` : ""} · 동 수준은 읍면동(한국) / 동등 최하위 행정구역`}
                    </p>
                  </>
                ) : null}
              </div>

              <h3 className="text-base font-semibold text-slate-900">캐릭터 선택</h3>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={walkingFrameUrls.length === 0}
                  onClick={() => {
                    setSelectedCharacter("walking");
                  }}
                  className={cn(
                    "flex w-full items-center gap-4 rounded-2xl border px-4 py-4 text-left transition",
                    selectedCharacter === "walking"
                      ? "border-emerald-400 bg-emerald-50"
                      : "border-slate-300 bg-white",
                    walkingFrameUrls.length === 0 && "cursor-not-allowed opacity-55"
                  )}
                >
                  <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-slate-300 bg-slate-50">
                    {walkingFrameUrls.length > 0 ? (
                      <img
                        src={walkingFrameUrls[0]}
                        alt="오크"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-[10px] font-semibold text-slate-500">N/A</span>
                    )}
                  </div>

                  <div className="flex-1">
                    <p className="text-sm font-bold text-slate-900">오크</p>
                    <p className="text-xs text-slate-500">
                      {isWalkingFramesLoading
                        ? "프레임 로딩 중..."
                        : walkingFrameUrls.length > 0
                          ? `${walkingFrameUrls.length}개 프레임`
                          : "오크 PNG를 찾을 수 없음"}
                    </p>
                  </div>

                  <div
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold",
                      selectedCharacter === "walking"
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : "border-slate-300 bg-white text-transparent"
                    )}
                  >
                    ✓
                  </div>
                </button>

                <button
                  type="button"
                  disabled={fallenAngelFrameUrls.length === 0}
                  onClick={() => {
                    setSelectedCharacter("fallenAngel");
                  }}
                  className={cn(
                    "flex w-full items-center gap-4 rounded-2xl border px-4 py-4 text-left transition",
                    selectedCharacter === "fallenAngel"
                      ? "border-fuchsia-400 bg-fuchsia-50"
                      : "border-slate-300 bg-white",
                    fallenAngelFrameUrls.length === 0 && "cursor-not-allowed opacity-55"
                  )}
                >
                  <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-slate-300 bg-slate-50">
                    {fallenAngelFrameUrls.length > 0 ? (
                      <img
                        src={fallenAngelFrameUrls[0]}
                        alt="타락천사"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-[10px] font-semibold text-slate-500">N/A</span>
                    )}
                  </div>

                  <div className="flex-1">
                    <p className="text-sm font-bold text-slate-900">타락천사</p>
                    <p className="text-xs text-slate-500">기본 캐릭터</p>
                  </div>

                  <div
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold",
                      selectedCharacter === "fallenAngel"
                        ? "border-fuchsia-500 bg-fuchsia-500 text-white"
                        : "border-slate-300 bg-white text-transparent"
                    )}
                  >
                    ✓
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {territoryEnabled && (!territoryStart || startPickerOpen) ? (
        <TerritoryStartPicker
          required={!territoryStart}
          initial={territoryStart}
          onPick={(start) => {
            try {
              writeTerritoryStart(locationCacheKey, start);
            } catch {}
            setTerritoryStart(start);
            setStartPickerOpen(false);
          }}
          onClose={() => setStartPickerOpen(false)}
        />
      ) : null}
      {territoryEnabled ? (
        <TerritoryUI
          castleKey={territoryCastleKey}
          onCloseCastle={() => setTerritoryCastleKey(null)}
          onOpenCastle={setTerritoryCastleKey}
          castlePoints={castlePoints}
          myLocation={playerLocation}
          getMapCenter={getTerritoryCenter}
          getPlayerLocation={getPlayerLocation}
          isLocationVisible={isTerritoryVisible}
          onUnitMarks={setUnitMarks}
          panToLocation={panTerritoryTo}
          territoryStart={territoryStart}
          ownedCastleKeys={ownedCastleKeys}
          castleNames={castleNameMap}
          unitMarkerSelection={unitMarkerSelection}
          onUnitMarkerSelectionHandled={clearUnitMarkerSelection}
          targetMarkerUrl={territoryTargetMarkerUrl}
          onMovePath={setUnitMovePath}
          onMoveDestination={setUnitMoveDestination}
          onMoveTargetCenter={setMoveTargetCenter}
          onLordSelectedChange={setLordSelected}
          markerDialogOpen={territoryEnabled && markerPanel !== null}
          dongCode={selectedAdminCode}
          playerDongCode={playerDongCode}
          wildSeeds={wildSeeds}
          onExit={() => void handleExit()}
          onResetScore={() => void handleResetScore()}
          lordMoveTarget={playerMoveTarget}
          onLordMoveOrder={(target) => {
            try {
              window.sessionStorage.setItem(LORD_ORDER_STORAGE_KEY, JSON.stringify(target));
            } catch {
              // 무시
            }
            setPlayerManualBase(null);
            setPlayerMoveTarget(target);
          }}
          onLordMoveStop={() => {
            setPlayerMoveTarget((current) => {
              if (current) {
                const pos = positionAtMoveTarget(current, Date.now());
                if (Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
                  try {
                    window.sessionStorage.setItem(LORD_BASE_STORAGE_KEY, JSON.stringify({ lat: pos.lat, lon: pos.lon }));
                  } catch {
                    // 무시
                  }
                  setPlayerManualBase({ lat: pos.lat, lon: pos.lon });
                }
              }
              try {
                window.sessionStorage.removeItem(LORD_ORDER_STORAGE_KEY);
              } catch {
                // 무시
              }
              return null;
            });
          }}
          onLordSetBase={(pos) => {
            try {
              window.sessionStorage.setItem(LORD_BASE_STORAGE_KEY, JSON.stringify({ lat: pos.lat, lon: pos.lon }));
            } catch {
              // 무시
            }
            setPlayerManualBase({ lat: pos.lat, lon: pos.lon });
          }}
          onStartPlacement={(draft) => {
            closeMarkerPanel();
            setCastlePlacement({ ...draft, lat: null, lon: null, confirming: false });
          }}
          placementNotice={placementNotice}
        />
      ) : null}
      {castlePlacement && !castlePlacement.confirming ? (
        <CastlePlacementGhost src={CASTLE_IMAGE_BY_KIND[castlePlacement.kind]} />
      ) : null}
      {castlePlacement && !castlePlacement.confirming ? (
        <div className="pointer-events-auto fixed left-1/2 top-[4.5rem] z-[1150] w-max max-w-[92vw] -translate-x-1/2 rounded-2xl border border-white/30 bg-slate-900/95 px-4 py-1.5 text-center shadow-xl">
          <p className="text-sm font-black text-white">
            {castlePlacement.kind === "lord" ? "영주성" : "귀족성"} {castlePlacement.name}
          </p>
          <p className="mt-0.5 text-xs text-slate-300">현재 위치의 동 안에서 클릭해 위치를 정하세요</p>
          <button
            type="button"
            onClick={cancelCastlePlacement}
            className="mt-1.5 rounded-lg border border-slate-500 bg-slate-700 px-4 py-1.5 text-xs font-bold text-white"
          >
            취소
          </button>
        </div>
      ) : null}
      {castlePlacement?.confirming &&
      castlePlacement.lat !== null &&
      castlePlacement.lon !== null ? (
        <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-[1250] mx-auto w-full max-w-xl rounded-[24px] border border-white/30 bg-white/95 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.45)]">
          <p className="text-base font-black text-slate-900">이 위치에 세우시겠습니까?</p>
          <p className="mt-1 text-sm font-bold text-slate-700">
            {castlePlacement.kind === "lord" ? "영주성" : "귀족성"} {castlePlacement.name}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            위도 {castlePlacement.lat.toFixed(6)} · 경도 {castlePlacement.lon.toFixed(6)}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={cancelCastlePlacement}
              disabled={placementBusy}
              className="min-h-[33px] rounded-[16px] border border-slate-300 bg-white px-4 py-1.5 text-sm font-black tracking-wide text-slate-700 disabled:opacity-40"
            >
              취소
            </button>
            <button
              type="button"
              title={placementBlockReason ?? ""}
              onClick={() => {
                if (placementBlockReason) {
                  setPlacementReason(placementBlockReason);
                  return;
                }
                confirmCastlePlacement();
              }}
              disabled={placementBusy}
              aria-disabled={placementBlockReason !== null}
              className={`min-h-[33px] rounded-[16px] px-4 py-1.5 text-sm font-black tracking-wide text-white disabled:opacity-40 ${
                placementBlockReason ? "bg-slate-400" : "bg-slate-900"
              }`}
            >
              {placementBusy ? "세우는 중…" : "세우기"}
            </button>
          </div>
        </div>
      ) : null}
      {placementReason ? (
        <div className="fixed inset-0 z-[1350] flex items-end justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-[24px] border border-white/30 bg-white/95 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.45)]">
            <p className="text-base font-black text-slate-900">축성할 수 없습니다</p>
            <p className="mt-1 text-sm font-bold text-slate-700">{placementReason}</p>
            <button
              type="button"
              onClick={() => setPlacementReason(null)}
              className="mt-3 min-h-[33px] w-full rounded-[16px] bg-slate-900 px-4 py-1.5 text-sm font-black tracking-wide text-white"
            >
              확인
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
