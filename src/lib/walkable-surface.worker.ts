import { buildWalkableSurface, type SurfaceInput } from "@/lib/walkable-surface";

self.onmessage = (event: MessageEvent<SurfaceInput>): void => {
  self.postMessage(buildWalkableSurface(event.data));
};
