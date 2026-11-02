import { NextResponse } from "next/server";
import { listNeutralUnits, setNeutralRasterBaseUrl } from "@/lib/neutral-units";

/** 중립 부대 조회. GET=단일 동, POST=화면 내 복수 동. 스폰·배회는 읽기 시점에 lazy 처리된다. */
export const GET = async (request: Request): Promise<NextResponse> => {
  try {
    const url = new URL(request.url);
    setNeutralRasterBaseUrl(url.origin);
    const dong = (url.searchParams.get("dong") ?? "").trim();
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    if (!dong || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
    }
    const units = await listNeutralUnits(dong, lat, lon);
    return NextResponse.json({ ok: true, units });
  } catch (e) {
    console.error("[neutral-units] GET failed", e);
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
};

type Seed = { dong: string; lat: number; lon: number };

export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    setNeutralRasterBaseUrl(new URL(request.url).origin);
    const body = (await request.json().catch(() => null)) as { seeds?: unknown } | null;
    const raw = Array.isArray(body?.seeds) ? (body?.seeds as unknown[]) : [];
    const seeds: Seed[] = [];
    for (const s of raw.slice(0, 12)) {
      if (typeof s !== "object" || s === null) {
        continue;
      }
      const r = s as Record<string, unknown>;
      if (typeof r.dong !== "string" || !r.dong.trim()) {
        continue;
      }
      if (typeof r.lat !== "number" || !Number.isFinite(r.lat)) {
        continue;
      }
      if (typeof r.lon !== "number" || !Number.isFinite(r.lon)) {
        continue;
      }
      if (seeds.some((v) => v.dong === r.dong)) {
        continue;
      }
      seeds.push({ dong: r.dong.trim(), lat: r.lat, lon: r.lon });
    }
    if (seeds.length === 0) {
      return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
    }
    const all = [];
    for (const seed of seeds) {
      const units = await listNeutralUnits(seed.dong, seed.lat, seed.lon);
      all.push(...units);
    }
    return NextResponse.json({ ok: true, units: all });
  } catch (e) {
    console.error("[neutral-units] POST failed", e);
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
};
