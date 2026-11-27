interface RoutePoint { lat: number; lon: number }
interface RouteSample extends RoutePoint { dir: 1 | -1 }

/** Reuse segment lengths while sampling the same road at display-frame frequency. */
export function createRouteSampler(points: RoutePoint[], metres: (a: RoutePoint, b: RoutePoint) => number): (fraction: number) => RouteSample {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + metres(points[i - 1]!, points[i]!));
  const total = lengths[lengths.length - 1]!;
  return (fraction: number): { lat: number; lon: number; dir: 1 | -1 } => {
    const distance = Math.max(0, Math.min(1, fraction)) * total;
    let lo = 1, hi = Math.max(1, points.length - 1);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lengths[mid]! < distance) lo = mid + 1;
      else hi = mid;
    }
    const a = points[lo - 1]!, b = points[lo] ?? a;
    const span = lengths[lo]! - lengths[lo - 1]!;
    const t = span > 0 ? (distance - lengths[lo - 1]!) / span : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, dir: b.lon < a.lon ? -1 : 1 };
  };
}
