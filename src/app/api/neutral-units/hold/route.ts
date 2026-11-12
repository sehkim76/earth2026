import { NextResponse } from "next/server";
import prisma from "@/lib/prismadb";
import { NEUTRAL_PATH_SNAP_MAX_M, neutralPositionAt, projectOntoPath } from "@/lib/neutral-leg";

const parsePath = (raw: string | null): Array<{ lat: number; lon: number }> | null => {
  if (!raw) {
    return null;
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) {
      return null;
    }
    const pts: Array<{ lat: number; lon: number }> = [];
    for (const p of arr) {
      const rec = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
      if (typeof rec.lat !== "number" || typeof rec.lon !== "number" || !Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) {
        return null;
      }
      pts.push({ lat: rec.lat, lon: rec.lon });
    }
    return pts.length >= 2 ? pts : null;
  } catch {
    return null;
  }
};

/** 무법자 일시정지 유지 시간 (클라이언트가 다이얼로그 표시 중 30초마다 연장한다).
 * 백그라운드 탭 타이머 지연(1분 단위)에도 풀리지 않도록 연장 주기의 10배로 둔다. */
const HOLD_TTL_MS = 300_000;

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
    // 경로를 따라 보간한 위치에 고정한다 (직선 보간은 꺾인 길에서 이동가능영역 밖을 가리킨다).
    const path = parsePath(row.path);
    const pos = neutralPositionAt(
      {
        fromLat: Number(row.lat),
        fromLon: Number(row.lon),
        destLat: Number(row.destLat),
        destLon: Number(row.destLon),
        startedAt: Number(row.legStartedAt),
        endsAt: Number(row.legEndsAt),
        path,
        pathIdx: row.pathIdx,
      },
      now,
    );
    // 과거 직선 보간으로 경로 밖에 고정된 개체는 경로 위로 되돌린다 (멈춘 채로 숲 속에 남지 않게).
    let pathIdx = row.pathIdx;
    const onPath = projectOntoPath(pos.lat, pos.lon, path, row.pathIdx >= 1 ? row.pathIdx - 1 : null);
    if (onPath && onPath.distM > 1 && onPath.distM <= NEUTRAL_PATH_SNAP_MAX_M) {
      pos.lat = onPath.lat;
      pos.lon = onPath.lon;
      pathIdx = onPath.pathIdx;
    }
    console.log(
      `[neutral] hold id=${id} on=${hold} elapsed=${((now - Number(row.legStartedAt)) / 1000).toFixed(1)}s legSec=${((Number(row.legEndsAt) - Number(row.legStartedAt)) / 1000).toFixed(0)} moving=${!pos.arrived} from=(${Number(row.lat).toFixed(6)},${Number(row.lon).toFixed(6)}) pos=(${pos.lat.toFixed(6)},${pos.lon.toFixed(6)}) idx=${row.pathIdx}->${pathIdx} snap=${onPath ? onPath.distM.toFixed(1) : "-"}`,
    );
    await prisma.territoryNeutralUnit.update({
      where: { id },
      data: {
        lat: pos.lat,
        lon: pos.lon,
        destLat: pos.lat,
        destLon: pos.lon,
        pathIdx,
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
