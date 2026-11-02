import { NextResponse } from "next/server";
import prisma from "@/lib/prismadb";

/** 무법자 일시정지 유지 시간 (클라이언트가 다이얼로그 표시 중 60초마다 연장한다). */
const HOLD_TTL_MS = 120_000;

const lerpNow = (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  startedAt: number,
  endsAt: number,
  now: number,
): { lat: number; lon: number } => {
  if (now >= endsAt || endsAt <= startedAt) {
    return { lat: toLat, lon: toLon };
  }
  const t = (now - startedAt) / (endsAt - startedAt);
  return { lat: fromLat + (toLat - fromLat) * t, lon: fromLon + (toLon - fromLon) * t };
};

/** 무법자 일시정지/재개. 다이얼로그가 열린 동안 해당 개체를 멈춘다.
 * hold=true: 현재 보간 위치에 고정하고 legEndsAt를 TTL 뒤로 민다 (틱이 건너뛴다).
 * hold=false: legEndsAt를 현재로 당겨 다음 틱부터 바로 이동을 재개한다.
 * 행이 없으면(공격 등으로 삭제됨) 조용히 성공으로 응답한다.
 */
export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const id = typeof rec.id === "number" && Number.isInteger(rec.id) ? rec.id : NaN;
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
    }
    const hold = rec.hold !== false;
    const now = Date.now();
    const row = await prisma.territoryNeutralUnit.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ ok: true, resumed: false });
    }
    const pos = lerpNow(
      Number(row.lat),
      Number(row.lon),
      Number(row.destLat),
      Number(row.destLon),
      Number(row.legStartedAt),
      Number(row.legEndsAt),
      now,
    );
    await prisma.territoryNeutralUnit.update({
      where: { id },
      data: {
        lat: pos.lat,
        lon: pos.lon,
        destLat: pos.lat,
        destLon: pos.lon,
        legStartedAt: BigInt(now),
        legEndsAt: BigInt(hold ? now + HOLD_TTL_MS : now),
        updatedAt: BigInt(now),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[neutral] hold failed", e);
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
};
