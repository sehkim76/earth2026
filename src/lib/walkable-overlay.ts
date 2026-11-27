import type { Bounds, GeoJSON as LeafletGeoJSON, Map as LeafletMap, Point } from "leaflet";

import {
  getWalkableGridImageForDong,
  getWalkableOverlayTilesBestEffort,
  getWalkableContours,
  paintWalkableFillTiles,
  paintWalkableTiles,
  type GridFull,
} from "@/lib/walkable-client";

export type { GridFull };
export { getWalkableGridImageForDong, getWalkableOverlayTilesBestEffort, paintWalkableTiles };

/** 타일 dataUrl → Image 캐시 (디코드 1회, drawImage로 재사용). */
const fillImages = new Map<string, HTMLImageElement>();

const IMAGE_CACHE_LIMIT = 200;

const trimCache = (cache: Map<string, HTMLImageElement>): void => {
  if (cache.size <= IMAGE_CACHE_LIMIT) {
    return;
  }
  const oldest = cache.keys().next();
  if (!oldest.done) {
    cache.delete(oldest.value);
  }
};

const imageFor = (
  cache: Map<string, HTMLImageElement>,
  key: string,
  dataUrl: string,
  onLoad: () => void,
): HTMLImageElement | null => {
  if (!dataUrl) {
    return null;
  }
  const hit = cache.get(key);
  if (hit) {
    if (!hit.complete) hit.addEventListener("load", onLoad, { once: true });
    return hit.complete && hit.naturalWidth > 0 ? hit : null;
  }
  if (typeof document === "undefined") {
    return null;
  }
  const image = new Image();
  image.addEventListener("load", onLoad, { once: true });
  image.src = dataUrl;
  cache.set(key, image);
  trimCache(cache);
  return null;
};

interface ReadyTile {
  grid: GridFull;
  fill: HTMLImageElement;
}

function readyFillTiles(tiles: GridFull[], onReady: () => void, visibleKeys?: Set<string>): ReadyTile[] {
  paintWalkableFillTiles(tiles, visibleKeys);
  const ready: ReadyTile[] = [];
  for (const grid of tiles) {
    if (visibleKeys && !visibleKeys.has(grid.key)) continue;
    const fill = imageFor(fillImages, grid.key, grid.dataUrl, onReady);
    if (fill) ready.push({ grid, fill });
  }
  return ready;
}

// 기존 2.5m 윤곽은 한국 위도에서 줌 15일 때 약 0.65 CSS 픽셀이다.
export const WALKABLE_BORDER_WIDTH_PX = 0.65;
export const WALKABLE_BORDER_COLOR = "#1491ff";
const tileLines = new WeakMap<GridFull, GeoJSON.MultiLineString>();
const tracedLines = new WeakMap<ReturnType<typeof getWalkableContours>, GeoJSON.MultiLineString>();

function borderParts(tiles: GridFull[], visibleKeys?: Set<string>): Map<string, GeoJSON.MultiLineString> {
  const parts = new Map<string, GeoJSON.MultiLineString>();
  if (tiles.length === 0) return parts;
  const toLine = (run: Array<[number, number]>, grid: GridFull): number[][] =>
    run.map(([x, y]) => [x * grid.cellLon, y * grid.cellLat]);
  if (tiles.some(grid => !grid.contourRuns)) {
    // 이전 형식은 전체 타일의 합집합을 추적해야 타일 사이에 가짜 선이 생기지 않는다.
    const contours = getWalkableContours(tiles);
    let geometry = tracedLines.get(contours);
    if (!geometry) {
      geometry = { type: "MultiLineString", coordinates: contours.map(({ points }) =>
        toLine([...points, points[0]], tiles[0])) };
      tracedLines.set(contours, geometry);
    }
    parts.set("trace:" + tiles.map(grid => grid.key).sort().join(","), geometry);
    return parts;
  }
  for (const grid of tiles) {
    if (!grid.contourRuns?.length || (visibleKeys && !visibleKeys.has(grid.key))) continue;
    let geometry = tileLines.get(grid);
    if (!geometry) {
      geometry = { type: "MultiLineString", coordinates: grid.contourRuns.map(run => toLine(run, grid)) };
      tileLines.set(grid, geometry);
    }
    parts.set(grid.key, geometry);
  }
  return parts;
}

interface WalkableComposite {
  key: string;
  fillUrl: string;
  border: GeoJSON.MultiLineString;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** 합성 결과 캐시 (ready 타일 집합 기준 — 인코딩 1회). */
const compositeCache = new Map<string, WalkableComposite>();
const COMPOSITE_CACHE_LIMIT = 5;

export const getWalkableComposite = (
  tiles: GridFull[],
  onReady: () => void,
): WalkableComposite | null => {
  const ready = readyFillTiles(tiles, onReady);
  if (ready.length === 0) {
    return null;
  }
  const sig = ready.map(({ grid }) => grid.key).sort().join(",");
  const hit = compositeCache.get(sig);
  if (hit) {
    return hit;
  }
  const built = buildWalkableComposite(ready);
  if (!built) {
    return null;
  }
  const parts = borderParts(ready.map(({ grid }) => grid));
  const out: WalkableComposite = {
    key: sig,
    fillUrl: built.fill.toDataURL("image/png"),
    border: { type: "MultiLineString", coordinates: Array.from(parts.values()).flatMap(part => part.coordinates) },
    west: built.west,
    south: built.south,
    east: built.east,
    north: built.north,
  };
  compositeCache.set(sig, out);
  if (compositeCache.size > COMPOSITE_CACHE_LIMIT) {
    const oldest = compositeCache.keys().next();
    if (!oldest.done) {
      compositeCache.delete(oldest.value);
    }
  }
  return out;
};

const buildWalkableComposite = (
  ready: ReadyTile[],
): { fill: HTMLCanvasElement; west: number; south: number; east: number; north: number } | null => {
  if (ready.length === 0 || typeof document === "undefined") {
    return null;
  }
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const { grid } of ready) {
    west = Math.min(west, grid.west);
    south = Math.min(south, grid.south);
    east = Math.max(east, grid.east);
    north = Math.max(north, grid.north);
  }
  // 기준 타일(첫 타일)의 미터당 픽셀을 전체 합성 해상도로 사용한다.
  const base = ready[0]?.grid;
  if (!base) {
    return null;
  }
  const pxPerLon = base.nx / (base.east - base.west);
  const pxPerLat = base.ny / (base.north - base.south);
  const width = Math.max(1, Math.round((east - west) * pxPerLon));
  const height = Math.max(1, Math.round((north - south) * pxPerLat));
  // 합성 캔버스 상한 (초과 시 globe/cesium은 단일 오버레이를 건너뛴다).
  if (width * height > 4096 * 4096) {
    return null;
  }
  const fill = document.createElement("canvas");
  fill.width = width;
  fill.height = height;
  const fillCtx = fill.getContext("2d");
  if (!fillCtx) return null;
  for (const { grid, fill: fillImage } of ready) {
    const dx = Math.round((grid.west - west) * pxPerLon);
    const dy = Math.round((north - grid.north) * pxPerLat);
    const dw = Math.max(1, Math.round((grid.east - grid.west) * pxPerLon));
    const dh = Math.max(1, Math.round((grid.north - grid.south) * pxPerLat));
    try {
      fillCtx.drawImage(fillImage, dx, dy, dw, dh);
    } catch {
      // 타일 경계 반올림 오차는 건너뛴다.
    }
  }
  return { fill, west, south, east, north };
};

/** 팬할 때는 여백을 포함한 채움 캔버스를 재사용한다. 윤곽은 SVG로 별도 투영한다. */
export function createWalkableCanvasLayer(
  L: typeof import("leaflet"),
  getTiles: () => GridFull[],
  fillOpacity: number,
  borderOpacity: number,
): { addTo(map: LeafletMap): void; remove(): void; refresh(): void } {
  const canvas = L.DomUtil.create("canvas", "walkable-canvas-layer");
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none";
  const renderer = L.svg({ padding: 0.35 });
  const borders = L.layerGroup();
  const layers = new Map<string, LeafletGeoJSON>();
  let map: LeafletMap | null = null;
  let frame: number | null = null;
  let drawnBounds: Bounds | null = null;
  let pixelOrigin: Point | null = null;
  let drawnZoom = -1;
  let drawnDpr = 0;
  const filled = new Set<string>();

  function syncBorders(parts: Map<string, GeoJSON.MultiLineString>): void {
    for (const [key, layer] of layers) {
      if (!parts.has(key)) {
        borders.removeLayer(layer);
        layers.delete(key);
      }
    }
    for (const [key, geometry] of parts) {
      if (layers.has(key)) continue;
      const layer = L.geoJSON(geometry, { interactive: false, style: {
        renderer, className: "walkable-road-outline", color: WALKABLE_BORDER_COLOR,
        weight: WALKABLE_BORDER_WIDTH_PX, opacity: borderOpacity, fill: false,
      } });
      layer.addTo(borders);
      layers.set(key, layer);
    }
  }

  function paint(): void {
    frame = null;
    if (!map) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const zoom = map.getZoom();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const tiles = getTiles();
    const keys = new Set(tiles.map(grid => grid.key));
    const size = map.getSize();
    // 네 모서리를 투영해 지도를 회전해도 채움과 윤곽이 같은 위치에 놓이게 한다.
    const viewport = L.bounds([[0, 0], [size.x, 0], [0, size.y], [size.x, size.y]]
      .map(([x, y]) => map!.containerPointToLayerPoint([x, y])));
    if (!drawnBounds?.contains(viewport) || zoom !== drawnZoom || dpr !== drawnDpr ||
        !pixelOrigin?.equals(map.getPixelOrigin()) ||
        Array.from(filled).some(key => !keys.has(key))) {
      const pad = viewport.getSize().multiplyBy(0.35).round();
      drawnBounds = L.bounds(viewport.min!.subtract(pad), viewport.max!.add(pad));
      pixelOrigin = map.getPixelOrigin().clone();
      drawnZoom = zoom;
      drawnDpr = dpr;
      filled.clear();
      const extent = drawnBounds.getSize();
      canvas.width = Math.max(1, Math.ceil(extent.x * dpr));
      canvas.height = Math.max(1, Math.ceil(extent.y * dpr));
      canvas.style.width = extent.x + "px";
      canvas.style.height = extent.y + "px";
      L.DomUtil.setPosition(canvas, drawnBounds.min!);
    }
    const origin = drawnBounds.min!;
    const bounds = L.latLngBounds(map.layerPointToLatLng(origin), map.layerPointToLatLng(drawnBounds.max!));
    const visible = new Set(tiles.filter(grid => bounds.intersects([[grid.south, grid.west], [grid.north, grid.east]]))
      .map(grid => grid.key));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = fillOpacity;
    for (const { grid, fill } of readyFillTiles(tiles, refresh, visible)) {
      if (filled.has(grid.key)) continue;
      const nw = map.latLngToLayerPoint([grid.north, grid.west]).subtract(origin);
      const se = map.latLngToLayerPoint([grid.south, grid.east]).subtract(origin);
      ctx.drawImage(fill, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
      filled.add(grid.key);
    }
    syncBorders(borderParts(tiles, visible));
  }

  function refresh(): void {
    if (map && frame === null) frame = requestAnimationFrame(paint);
  }
  const events = "moveend zoomend viewreset resize rotate";
  return {
    addTo(target): void {
      map = target;
      target.getPanes().overlayPane.appendChild(canvas);
      borders.addTo(target);
      target.on(events, refresh);
      refresh();
    },
    remove(): void {
      map?.off(events, refresh);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      borders.clearLayers().remove();
      layers.clear();
      renderer.remove();
      canvas.remove();
      filled.clear();
      drawnBounds = null;
      map = null;
    },
    refresh,
  };
}
