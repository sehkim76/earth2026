import { buildWalkableContours, type ContourPoint, type ContourTile, type WalkableContour } from "@/lib/walkable-contours";

export interface SurfaceInput {
  tiles: ContourTile[];
  tileSize: number;
  cellLon: number;
  cellLat: number;
}

export type WalkableSurface = GeoJSON.FeatureCollection<GeoJSON.Polygon>;

/** Use local coordinates for the area calculation; global grid indices are in the millions. */
function signedArea(points: ContourPoint[]): number {
  const [x0, y0] = points[0];
  let area = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    const [x, y] = points[i];
    const [nextX, nextY] = points[i + 1];
    area += (x - x0) * (nextY - y0) - (nextX - x0) * (y - y0);
  }
  return area;
}

function containsPoint(ring: ContourPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

export function buildWalkableSurface({ tiles, tileSize, cellLon, cellLat }: SurfaceInput): WalkableSurface {
  const shells: { contour: WalkableContour; area: number; rings: ContourPoint[][] }[] = [];
  const holes: WalkableContour[] = [];
  for (const contour of buildWalkableContours(tiles, tileSize)) {
    const area = signedArea(contour.points);
    if (area > 0) shells.push({ contour, area, rings: [contour.points] });
    if (area < 0) holes.push(contour);
  }
  // Outlines have the occupied cells on their left. A clockwise ring encloses a hole.
  // Assign it to the smallest enclosing shell so islands in holes stay filled.
  shells.sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const [a, b] = hole.points;
    const x = (a[0] + b[0]) / 2;
    const y = (a[1] + b[1]) / 2;
    const shell = shells.find(({ contour }) => contour.west <= hole.west && contour.east >= hole.east &&
      contour.south <= hole.south && contour.north >= hole.north && containsPoint(contour.points, x, y));
    shell?.rings.push(hole.points);
  }
  return {
    type: "FeatureCollection",
    features: shells.map(({ rings }) => ({
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: rings.map(points => {
          const ring = points.map(([x, y]) => [x * cellLon, y * cellLat]);
          return [...ring, ring[0]];
        }),
      },
    })),
  };
}
