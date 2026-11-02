import {
  getWalkableGridImageForDong,
  getWalkableOverlayTilesBestEffort,
  paintWalkableBorderTiles,
  paintWalkableFillTiles,
  paintWalkableTiles,
  type GridFull,
} from "@/lib/walkable-client";

export type { GridFull };
export { getWalkableGridImageForDong, getWalkableOverlayTilesBestEffort, paintWalkableTiles };

/** 타일 dataUrl → Image 캐시 (디코드 1회, drawImage로 재사용). */
const fillImages = new Map<string, HTMLImageElement>();
const borderImages = new Map<string, HTMLImageElement>();
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
    return hit.complete && hit.naturalWidth > 0 ? hit : null;
  }
  if (typeof document === "undefined") {
    return null;
  }
  const image = new Image();
  image.onload = onLoad;
  image.src = dataUrl;
  cache.set(key, image);
  trimCache(cache);
  return null;
};

/**
 * 그릴 준비가 된 타일 이미지 목록. 아직 디코드 중인 타일은 건너뛰고,
 * 로드가 끝나면 onReady를 호출해 다시 그리게 한다.
 */
/** 테두리 지연 페인트 예약 (idle 시 1회로 합친다). */
let borderIdleQueued = false;
let borderIdleLatest: { tiles: GridFull[]; visibleKeys?: Set<string>; onReady: () => void } | null = null;

const scheduleBorderPaint = (
  tiles: GridFull[],
  visibleKeys: Set<string> | undefined,
  onReady: () => void,
): void => {
  borderIdleLatest = { tiles, visibleKeys, onReady };
  if (borderIdleQueued || typeof window === "undefined") {
    return;
  }
  borderIdleQueued = true;
  const run = (): void => {
    borderIdleQueued = false;
    const latest = borderIdleLatest;
    borderIdleLatest = null;
    if (!latest) {
      return;
    }
    paintWalkableBorderTiles(latest.tiles, latest.visibleKeys);
    latest.onReady();
  };
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === "function") {
    ric.call(window, run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
};

export const getReadyTileImages = (
  tiles: GridFull[],
  onReady: () => void,
  visibleKeys?: Set<string>,
  deferBorders = false,
): Array<{ grid: GridFull; fill: HTMLImageElement; border: HTMLImageElement | null }> => {
  // 채움은 동기, 테두리는 지연(idle) 또는 동기.
  paintWalkableFillTiles(tiles, visibleKeys);
  if (deferBorders) {
    const needsBorder = tiles.some(
      (grid) => grid.dataUrl && !grid.borderDataUrl && (!visibleKeys || visibleKeys.has(grid.key)),
    );
    if (needsBorder) {
      scheduleBorderPaint(tiles, visibleKeys, onReady);
    }
  } else {
    paintWalkableBorderTiles(tiles, visibleKeys);
  }
  const out: Array<{ grid: GridFull; fill: HTMLImageElement; border: HTMLImageElement | null }> = [];
  for (const grid of tiles) {
    const fill = imageFor(fillImages, `${grid.key}:fill`, grid.dataUrl, onReady);
    if (!fill) {
      continue;
    }
    const border = imageFor(borderImages, `${grid.key}:border`, grid.borderDataUrl, onReady);
    out.push({ grid, fill, border });
  }
  return out;
};

/** 합성 결과 캐시 (ready 타일 집합 기준 — 인코딩 1회). */
const compositeCache = new Map<
  string,
  { fillUrl: string; borderUrl: string; west: number; south: number; east: number; north: number }
>();
const COMPOSITE_CACHE_LIMIT = 5;

export const getWalkableCompositeUrls = (
  tiles: GridFull[],
  onReady: () => void,
): { fillUrl: string; borderUrl: string; west: number; south: number; east: number; north: number } | null => {
  const ready = getReadyTileImages(tiles, onReady);
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
  const out = {
    fillUrl: built.fill.toDataURL("image/png"),
    borderUrl: built.border.toDataURL("image/png"),
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
  ready: Array<{ grid: GridFull; fill: HTMLImageElement; border: HTMLImageElement | null }>,
): { fill: HTMLCanvasElement; border: HTMLCanvasElement; west: number; south: number; east: number; north: number } | null => {
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
  const border = document.createElement("canvas");
  border.width = width;
  border.height = height;
  const fillCtx = fill.getContext("2d");
  const borderCtx = border.getContext("2d");
  if (!fillCtx || !borderCtx) {
    return null;
  }
  for (const { grid, fill: fillImage, border: borderImage } of ready) {
    const dx = Math.round((grid.west - west) * pxPerLon);
    const dy = Math.round((north - grid.north) * pxPerLat);
    const dw = Math.max(1, Math.round((grid.east - grid.west) * pxPerLon));
    const dh = Math.max(1, Math.round((grid.north - grid.south) * pxPerLat));
    try {
      fillCtx.drawImage(fillImage, dx, dy, dw, dh);
      if (borderImage) {
        borderCtx.drawImage(borderImage, dx, dy, dw, dh);
      }
    } catch {
      // 타일 경계 반올림 오차는 건너뛴다.
    }
  }
  return { fill, border, west, south, east, north };
};

export type WalkableLeaflet = {
  Layer: {
    extend: (methods: Record<string, unknown>) => { new (...args: never[]): unknown };
  };
  DomUtil: {
    create: (tag: string, className: string, container: HTMLElement) => HTMLElement;
    setPosition: (element: HTMLElement, point: { x: number; y: number }) => void;
  };
};

/**
 * Leaflet 단일 캔버스 레이어. 타일 수와 무관하게 캔버스 1장으로 그린다.
 * 팬 중에는 위치만 옮기고(저렴), 이동이 끝나면 다시 그린다.
 */
export const createWalkableCanvasLayer = (
  L: WalkableLeaflet,
  getTiles: () => GridFull[],
  fillOpacity: number,
  borderOpacity: number,
): unknown => {
  let canvas: HTMLCanvasElement | null = null;
  let redrawQueued = false;
  // 그리기 상태 (재사용 판정용).
  let drawnTilesSig: string | null = null;
  let drawnZoom: number | null = null;
  let drawnSize = "";
  let drawnKeys = new Set<string>();
  let canvasNorth = 0;
  let canvasSouth = 0;
  let canvasWest = 0;
  let canvasEast = 0;
  // 그리기 시점 기준 (CSS px, 줌 불변).
  let canvasOriginLL: { lat: number; lng: number } | null = null;
  let drawnCssW = 0;
  let drawnCssH = 0;
  let crispTimer: ReturnType<typeof setTimeout> | null = null;
  const LayerClass = L.Layer.extend({
    onAdd(map: {
      getPanes: () => { overlayPane: HTMLElement };
      getSize: () => { x: number; y: number };
      containerPointToLayerPoint: (point: [number, number]) => { x: number; y: number };
      latLngToContainerPoint: (latlng: [number, number]) => { x: number; y: number };
      containerPointToLatLng: (point: [number, number]) => { lat: number; lng: number };
      getZoom: () => number;
      getBounds: () => { getNorth: () => number; getSouth: () => number; getWest: () => number; getEast: () => number };
      on: (events: string, fn: () => void, context: unknown) => void;
      off: (events: string, fn: () => void, context: unknown) => void;
    }) {
      canvas = L.DomUtil.create("canvas", "walkable-canvas-layer", map.getPanes().overlayPane) as HTMLCanvasElement;
      canvas.style.pointerEvents = "none";
      canvas.style.position = "absolute";
      (this as { _map: unknown })._map = map;
      map.on("moveend zoomend viewreset resize", (this as { _paint: () => void })._paint, this);
      (this as { _paint: () => void })._paint();
      return this;
    },
    onRemove(map: {
      getPanes: () => { overlayPane: HTMLElement };
      off: (events: string, fn: () => void, context: unknown) => void;
    }) {
      map.off("moveend zoomend viewreset resize", (this as { _paint: () => void })._paint, this);
      if (crispTimer !== null) {
        clearTimeout(crispTimer);
        crispTimer = null;
      }
      if (canvas?.parentNode === map.getPanes().overlayPane) {
        map.getPanes().overlayPane.removeChild(canvas);
      }
      canvas = null;
      drawnTilesSig = null;
      drawnKeys = new Set<string>();
      canvasOriginLL = null;
      return this;
    },
    // 외부에서 타일 집합 변경 시 호출 (내부에서 재사용 여부 판단).
    refresh(this: { _paint: () => void }) {
      this._paint();
      return this;
    },
    _paint(this: { _map: unknown }) {
      const map = this._map as {
        getSize: () => { x: number; y: number };
        getZoom: () => number;
        getBounds: () => { getNorth: () => number; getSouth: () => number; getWest: () => number; getEast: () => number };
        containerPointToLayerPoint: (point: [number, number]) => { x: number; y: number };
        containerPointToLatLng: (point: [number, number]) => { lat: number; lng: number };
        latLngToContainerPoint: (latlng: [number, number]) => { x: number; y: number };
        latLngToLayerPoint: (latlng: [number, number]) => { x: number; y: number };
      };
      if (!canvas || !map) {
        return;
      }
      if (redrawQueued) {
        return;
      }
      redrawQueued = true;
      const self = this as unknown as { _paint: () => void; _fullReset: () => void };
      requestAnimationFrame(() => {
        redrawQueued = false;
        if (!canvas || !map) {
          return;
        }
        const paintStart = typeof performance !== "undefined" ? performance.now() : 0;
        const logPaint = (count: number): void => {
          try {
            if (
              typeof window !== "undefined" &&
              window.sessionStorage.getItem("map-perf-enabled") === "1"
            ) {
              console.log(`[perf] overlay paint ${Math.round(performance.now() - paintStart)}ms tiles:${count}`);
            }
          } catch {}
        };
        const tiles = getTiles();
        const tilesSig = tiles.map((grid) => grid.key).sort().join(",");
        const size = map.getSize();
        const sizeSig = `${size.x}x${size.y}`;
        const zoom = map.getZoom();
        // 화면(+여유)에 들어오는 타일만 래스터화한다. 나머지는 보일 때 그린다.
        const viewBounds = map.getBounds();
        const latPad = (viewBounds.getNorth() - viewBounds.getSouth()) * 0.3;
        const lngPad = (viewBounds.getEast() - viewBounds.getWest()) * 0.3;
        const visibleKeys = new Set<string>();
        for (const grid of tiles) {
          if (
            grid.east >= viewBounds.getWest() - lngPad &&
            grid.west <= viewBounds.getEast() + lngPad &&
            grid.south <= viewBounds.getNorth() + latPad &&
            grid.north >= viewBounds.getSouth() - latPad
          ) {
            visibleKeys.add(grid.key);
          }
        }
        // 같은 타일·크기 + 현재 화면이 캔버스 안에 들어오면 다시 그리지 않는다.
        // 타일 집합이 늘기만 했어도(부분 표시) 기존 그림을 유지하고 새 타일만 덧붙인다.
        const bounds = map.getBounds();
        const insetLat = (canvasNorth - canvasSouth) * 0.05;
        const insetLng = (canvasEast - canvasWest) * 0.05;
        const inCanvas =
          bounds.getNorth() <= canvasNorth - insetLat &&
          bounds.getSouth() >= canvasSouth + insetLat &&
          bounds.getWest() >= canvasWest + insetLng &&
          bounds.getEast() <= canvasEast - insetLng;
        const newKeys = new Set(tiles.map((grid) => grid.key));
        let coversDrawn = drawnTilesSig !== null;
        if (coversDrawn) {
          for (const key of drawnKeys) {
            if (!newKeys.has(key)) {
              coversDrawn = false;
              break;
            }
          }
        }
        if (
          drawnSize === sizeSig &&
          coversDrawn &&
          zoom !== drawnZoom &&
          canvasOriginLL
        ) {
          // 줌 변경: 기존 비트맵을 CSS로 스케일해 지도와 동기화하고,
          // 선명한 다시그리기는 줌이 멈춘 뒤 1회만 한다 (틱마다 전체 리셋 방지).
          // 캔버스 밖으로 나가도 위치는 유지되며, crisp에서 다시 그린다.
          const scale = 2 ** (zoom - (drawnZoom ?? zoom));
          canvas.style.width = `${drawnCssW * scale}px`;
          canvas.style.height = `${drawnCssH * scale}px`;
          try {
            const topLeft = map.latLngToLayerPoint([canvasOriginLL.lat, canvasOriginLL.lng]);
            L.DomUtil.setPosition(canvas, topLeft);
          } catch {
            // 투영 실패 시 다음 리셋에서 복구된다.
          }
          if (crispTimer !== null) {
            clearTimeout(crispTimer);
          }
          crispTimer = setTimeout(() => {
            crispTimer = null;
            self._fullReset();
          }, 250);
          return;
        }
        const ready = getReadyTileImages(tiles, () => {
          self._paint();
        }, visibleKeys, true);
        const reusable =
          coversDrawn &&
          drawnZoom === zoom &&
          drawnSize === sizeSig &&
          inCanvas;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }
        const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
        if (!reusable) {
          self._fullReset();
          return;
        }
        drawnTilesSig = tilesSig;
        const originX = (canvas as HTMLCanvasElement & { _originX?: number })._originX ?? 0;
        const originY = (canvas as HTMLCanvasElement & { _originY?: number })._originY ?? 0;
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.translate(-originX, -originY);
        for (const { grid, fill, border } of ready) {
          if (drawnKeys.has(grid.key)) {
            continue;
          }
          try {
            const nw = map.latLngToContainerPoint([grid.north, grid.west]);
            const se = map.latLngToContainerPoint([grid.south, grid.east]);
            const dw = se.x - nw.x;
            const dh = se.y - nw.y;
            if (dw <= 0 || dh <= 0) {
              continue;
            }
            // 화면 밖 타일은 건너뛴다.
            if (se.x < originX || se.y < originY || nw.x > originX + canvas.width / dpr || nw.y > originY + canvas.height / dpr) {
              continue;
            }
            ctx.globalAlpha = fillOpacity;
            ctx.drawImage(fill, nw.x, nw.y, dw, dh);
            if (border) {
              ctx.globalAlpha = borderOpacity;
              ctx.drawImage(border, nw.x, nw.y, dw, dh);
            }
            drawnKeys.add(grid.key);
          } catch {
            // 투영 실패 타일은 건너뛴다.
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
        logPaint(ready.length);
      });
    },
    // 선명한 전체 다시그리기 (줌 정지 후 1회, 또는 타일·크기 변경 시).
    _fullReset(this: { _map: unknown }) {
      const map = this._map as {
        getSize: () => { x: number; y: number };
        getZoom: () => number;
        getBounds: () => { getNorth: () => number; getSouth: () => number; getWest: () => number; getEast: () => number };
        containerPointToLayerPoint: (point: [number, number]) => { x: number; y: number };
        containerPointToLatLng: (point: [number, number]) => { lat: number; lng: number };
        latLngToContainerPoint: (latlng: [number, number]) => { x: number; y: number };
      };
      if (!canvas || !map) {
        return;
      }
      if (crispTimer !== null) {
        clearTimeout(crispTimer);
        crispTimer = null;
      }
      const tiles = getTiles();
      const tilesSig = tiles.map((grid) => grid.key).sort().join(",");
      const size = map.getSize();
      const sizeSig = `${size.x}x${size.y}`;
      const zoom = map.getZoom();
      const self = this as unknown as { _paint: () => void; _fullReset: () => void };
      const viewBounds = map.getBounds();
      const latPad = (viewBounds.getNorth() - viewBounds.getSouth()) * 0.3;
      const lngPad = (viewBounds.getEast() - viewBounds.getWest()) * 0.3;
      const visibleKeys = new Set<string>();
      for (const grid of tiles) {
        if (
          grid.east >= viewBounds.getWest() - lngPad &&
          grid.west <= viewBounds.getEast() + lngPad &&
          grid.south <= viewBounds.getNorth() + latPad &&
          grid.north >= viewBounds.getSouth() - latPad
        ) {
          visibleKeys.add(grid.key);
        }
      }
      const ready = getReadyTileImages(tiles, () => {
        self._paint();
      }, visibleKeys, true);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
      // 화면보다 70% 크게 잡아 보통 팬에서는 전체 다시그리기 없이 증분으로 버틴다.
      const marginX = Math.round(size.x * 0.35);
      const marginY = Math.round(size.y * 0.35);
      const wantW = Math.max(1, Math.round((size.x + marginX * 2) * dpr));
      const wantH = Math.max(1, Math.round((size.y + marginY * 2) * dpr));
      // 같은 크기면 재할당하지 않는다 (width 대입은 버퍼 제로필 + 컨텍스트 리셋이라 비싸다).
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }
      canvas.style.width = `${size.x + marginX * 2}px`;
      canvas.style.height = `${size.y + marginY * 2}px`;
      drawnCssW = size.x + marginX * 2;
      drawnCssH = size.y + marginY * 2;
      const topLeft = map.containerPointToLayerPoint([-marginX, -marginY]);
      L.DomUtil.setPosition(canvas, topLeft);
      (canvas as HTMLCanvasElement & { _originX?: number; _originY?: number })._originX = -marginX;
      (canvas as HTMLCanvasElement & { _originX?: number; _originY?: number })._originY = -marginY;
      const nwLL = map.containerPointToLatLng([-marginX, -marginY]);
      const seLL = map.containerPointToLatLng([size.x + marginX, size.y + marginY]);
      canvasNorth = nwLL.lat;
      canvasWest = nwLL.lng;
      canvasSouth = seLL.lat;
      canvasEast = seLL.lng;
      canvasOriginLL = { lat: nwLL.lat, lng: nwLL.lng };
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawnKeys = new Set<string>();
      drawnTilesSig = tilesSig;
      drawnZoom = zoom;
      drawnSize = sizeSig;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(marginX, marginY);
      for (const { grid, fill, border } of ready) {
        if (drawnKeys.has(grid.key)) {
          continue;
        }
        try {
          const nw = map.latLngToContainerPoint([grid.north, grid.west]);
          const se = map.latLngToContainerPoint([grid.south, grid.east]);
          const dw = se.x - nw.x;
          const dh = se.y - nw.y;
          if (dw <= 0 || dh <= 0) {
            continue;
          }
          if (se.x < -marginX || se.y < -marginY || nw.x > -marginX + canvas.width / dpr || nw.y > -marginY + canvas.height / dpr) {
            continue;
          }
          ctx.globalAlpha = fillOpacity;
          ctx.drawImage(fill, nw.x, nw.y, dw, dh);
          if (border) {
            ctx.globalAlpha = borderOpacity;
            ctx.drawImage(border, nw.x, nw.y, dw, dh);
          }
          drawnKeys.add(grid.key);
        } catch {
          // 투영 실패 타일은 건너뛴다.
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      try {
        if (typeof window !== "undefined" && window.sessionStorage.getItem("map-perf-enabled") === "1") {
          console.log(`[perf] overlay fullReset tiles:${ready.length} size:${canvas.width}x${canvas.height}`);
        }
      } catch {}
    },
  });
  return new LayerClass();
};
