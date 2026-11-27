import { GRID_TILE_CELLS, type GridFull } from "@/lib/walkable-client";
import { buildWalkableSurface, type SurfaceInput, type WalkableSurface } from "@/lib/walkable-surface";

// The original 2.5 m boundary occupies about 0.65 CSS pixels at zoom 15 in Korea.
export const WALKABLE_BORDER_WIDTH_PX = 0.65;
export const WALKABLE_BORDER_COLOR = "#1491ff";
export const WALKABLE_FILL_COLOR = "#a78bfa";

export function loadWalkableSurface(grids: GridFull[], signal: AbortSignal): Promise<WalkableSurface | null> {
  const input: SurfaceInput = {
    tiles: grids.map(({ tileColumn, tileRow, nx, ny, filled }) => ({ tileColumn, tileRow, nx, ny, filled })),
    tileSize: GRID_TILE_CELLS,
    cellLon: grids[0].cellLon,
    cellLat: grids[0].cellLat,
  };
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(null);
    let worker: Worker | undefined;
    function cleanup(): void {
      worker?.terminate();
      signal.removeEventListener("abort", abort);
    }
    function abort(): void {
      cleanup();
      resolve(null);
    }
    function fallback(): void {
      cleanup();
      try {
        resolve(buildWalkableSurface(input));
      } catch (error) {
        reject(error);
      }
    }
    try {
      worker = new Worker(new URL("./walkable-surface.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WalkableSurface>): void => {
        cleanup();
        resolve(event.data);
      };
      worker.onerror = fallback;
      signal.addEventListener("abort", abort, { once: true });
      worker.postMessage(input);
    } catch {
      fallback();
    }
  });
}
