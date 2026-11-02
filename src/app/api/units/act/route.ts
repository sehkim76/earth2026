import { NextResponse } from "next/server";

import {
  UNIT_SPEED_MPS,
  loadUnits,
  movePathLengthM,
  positionAtMoveTarget,
  settleExpiredMoveTarget,
  withUnits,
  type Unit,
} from "@/lib/units";
import {
  SIEGE_DAILY_CAP,
  applyUnitTouch,
  ensureCastleSeason,
  getSiegeAttemptsLast24h,
  getSiegeCooldownRemainingSecTx,
  haversineM,
  parseLatLon,
  performJoin,
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
  type Tx,
} from "@/lib/territory";

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type ActAction = "move" | "scout" | "siege" | "defend" | "join";

/** 단말·서버 시계 오차 유예 (stale 판정용). */
const STALE_SKEW_MS = 30_000;

type ActBody = {
  unitId?: unknown;
  servantId?: unknown;
  toLat?: unknown;
  toLon?: unknown;
  destLat?: unknown;
  destLon?: unknown;
  durationMs?: unknown;
  orderStartedAt?: unknown;
  reorder?: unknown;
  via?: unknown;
  path?: unknown;
  action?: unknown;
  castleKey?: unknown;
};

/** 만료된 주문서를 정산한다 (서버 권위: 위치는 시각의 함수).
 *  반환 null = 정산 불필요. path 주문서는 정확히 도착, 구 주문서는 500m 규칙 유지. */
function settleExpiredMove(
  unit: Unit,
  now: number,
): { lat: number; lon: number; lastMoveAt: number; moveTarget: Unit["moveTarget"] } | null {
  if (!unit.moveTarget) {
    return null;
  }
  return settleExpiredMoveTarget(unit.moveTarget, unit.lat, unit.lon, now);
}

/** 주문서 검증된 경로 파싱 (path 우선, 없으면 via). 상한 5000점. */
function parseOrderPath(via: unknown, path: unknown): Array<{ lat: number; lon: number }> | null {
  const pick = (v: unknown): Array<{ lat: number; lon: number }> | null => {
    if (!Array.isArray(v)) {
      return null;
    }
    const pts = v
      .filter(
        (point): point is { lat: number; lon: number } =>
          typeof point === "object" &&
          point !== null &&
          Number.isFinite((point as { lat?: unknown }).lat) &&
          Number.isFinite((point as { lon?: unknown }).lon),
      )
      .slice(0, 5000)
      .map((point) => ({ lat: point.lat, lon: point.lon }));
    return pts.length > 0 ? pts : null;
  };
  return pick(path) ?? pick(via);
}

/**
 * 부대 조작. 속도 10km/h 검증 후 행동 수행 (목적지 거리 제한 없음, 행동력 없음).
 * - move: 이동のみ / scout: 500m 내 성 정찰 / siege: 3타=1데미지
 * - defend: 소속성 수성 가담(시간당 1회, 공헌 +10) / join: 부대 위치로 입성
 */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: ActBody;
  try {
    body = (await request.json()) as ActBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const requestedUnitId = typeof body.unitId === "string" ? body.unitId : body.servantId;
  const unitId = typeof requestedUnitId === "string" ? requestedUnitId.trim() : "";
  const toLat = parseNumber(body.toLat);
  const toLon = parseNumber(body.toLon);
  const action: ActAction | null =
    body.action === "move" ||
    body.action === "scout" ||
    body.action === "siege" ||
    body.action === "defend" ||
    body.action === "join"
      ? body.action
      : null;
  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  if (!unitId || toLat === null || toLon === null || !action) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  if (Math.abs(toLat) > 90 || Math.abs(toLon) > 180) {
    return NextResponse.json({ ok: false, code: "invalid_coordinates" }, { status: 400 });
  }
  const destLat = parseNumber(body.destLat) ?? toLat;
  const destLon = parseNumber(body.destLon) ?? toLon;
  if (Math.abs(destLat) > 90 || Math.abs(destLon) > 180) {
    return NextResponse.json({ ok: false, code: "invalid_coordinates" }, { status: 400 });
  }
  if ((action === "siege" || action === "defend" || action === "join") && !castleKey) {
    return NextResponse.json({ ok: false, code: "castle_required" }, { status: 400 });
  }

  let lastMoveDistM = -1;
  let lastMoveDtSec = -1;

  try {
    const result = await withNamedLock(`unit:${userId}`, async (tx: Tx) => {
      const row = await tx.missionUser.findUnique({
        where: { userId },
        select: { data: true },
      });
      const units = loadUnits(row?.data);
      const unit = units.find((s) => s.id === unitId);
      if (!unit) {
        throw new Error("unit_not_found");
      }
      if (unit.state === "dead") {
        throw new Error("unit_dead");
      }
      if (unit.state === "garrisoned") {
        throw new Error("unit_garrisoned");
      }

      const now = Date.now();
      // 만료 주문서 먼저 정산 (서버 권위 위치의 기준점 확정).
      const settled = settleExpiredMove(unit, now);
      if (settled) {
        unit.lat = settled.lat;
        unit.lon = settled.lon;
        unit.lastMoveAt = settled.lastMoveAt;
        unit.moveTarget = settled.moveTarget;
        await tx.missionUser.update({
          where: { userId },
          data: { data: withUnits(row?.data, units) },
        });
      }
      // 권위 위치: 이동 중이면 시각 보간, 아니면 마지막 확정 위치.
      // 클라이언트 주장(toLat/toLon)은 신규 주문의 목적지로만 쓰고 위치로는 신뢰하지 않는다.
      const activeTarget =
        unit.moveTarget && unit.moveTarget.endsAt > now ? unit.moveTarget : null;
      const effPos = activeTarget
        ? positionAtMoveTarget(activeTarget, now)
        : { lat: unit.lat, lon: unit.lon, arrived: false };
      const dist = haversineM(effPos.lat, effPos.lon, toLat, toLon);
      const dtSec = Math.max(1, (now - unit.lastMoveAt) / 1000);
      lastMoveDistM = dist;
      lastMoveDtSec = dtSec;
      // 진행 중인 이동의 하트비트(위치 전진 없음)는 순간이동 감시 대상이 아니다.
      const hasActiveMove = action === "move" && !!activeTarget;
      // 지연된 이동 동기화가 취소된 주문서를 되살리는 것을 막는다.
      // (주문 없음 + 도착/중지 확정 아님 + 주문 시작이 마지막 기록보다 이전 = 무효)
      // 도착/중지 확정 호출은 orderStartedAt을 보내지 않으므로 영향 없다.
      // 단말·서버 시계 오차를 감안해 30초 유예를 둔다 (신규 주문의 오인 거부 방지).
      const orderStartedAt = parseNumber(body.orderStartedAt);
      if (
        !hasActiveMove &&
        orderStartedAt !== null &&
        orderStartedAt < unit.lastMoveAt - STALE_SKEW_MS
      ) {
        console.error(`[unit-act] stale_order unit=${unitId} action=${action} orderStartedAt=${orderStartedAt} lastMoveAt=${unit.lastMoveAt}`);
        return { stale: true as const, code: "stale_order" };
      }
      // 도착·이동중지 확정은 권위 위치 기준 300m 이내면 허용한다.
      // 장거리 이동은 서버가 경로 길이로 소요시간을 산정하므로 Rift가 생기지 않는다.
      const arrivedNoMove =
        action === "move" && haversineM(toLat, toLon, destLat, destLon) < 1 && dist <= 300;
      // 30m 이내 미세 이동은 허용 (파견 직후·GPS 지터). 그 이상은 10km/h 검증.
      if (!hasActiveMove && !arrivedNoMove && dist > 30 && dist / dtSec > UNIT_SPEED_MPS) {
        console.error(`[unit-act] too_fast unit=${unitId} action=${action} dist=${Math.round(dist)} dtSec=${Math.round(dtSec)}`);
        throw new Error("too_fast");
      }
      // HQ 반경 제한은 폐지했다. 반경을 넘긴 행군·주둔도 정상으로 취급한다.
      // 순간이동 치트는 위 속도 검증이 막는다.

      const persist = async (): Promise<void> => {
        // 행동 위치는 권위 위치로 확정하고 이동 주문은 종료한다 (기존 의미 유지).
        const next = units.map((s) =>
          s.id === unitId
            ? { ...s, lat: effPos.lat, lon: effPos.lon, lastMoveAt: now, moveTarget: null }
            : s,
        );
        await tx.missionUser.update({
          where: { userId },
          data: { data: withUnits(row?.data, next) },
        });
      };

      if (action === "move") {
        // 서버 권위 이동: 주문서만 저장하고 위치 전진은 positionAtMoveTarget()이 담당한다.
        // - 신규/재지시: from=권위위치, 경로는 클라이언트 제출 검증 후 저장, 소요=경로길이/속도.
        // - 하트비트(진행 중 + 같은 목적지 + reorder 없음): 위치 전진 없이 권위위치 반환.
        // - 도착/중지(to==dest): 권위위치 기준 300m 이내면 확정.
        const tripDist = haversineM(effPos.lat, effPos.lon, destLat, destLon);
        const arrived = haversineM(toLat, toLon, destLat, destLon) < 1;
        // 진행 중 주문과 다른 목적지를 가진 호출은 이전 행군의 지연 도착분이다.
        // 목적지 납치를 막기 위해 버린다 (명시적 재지시 reorder만 목적지 변경 허용).
        // 중지/도착 확정(to==dest)은 항상 인정한다.
        if (
          hasActiveMove &&
          activeTarget &&
          !arrived &&
          body.reorder !== true &&
          haversineM(destLat, destLon, activeTarget.lat, activeTarget.lon) >= 1
        ) {
          console.error(`[unit-act] stale_order_hijack unit=${unitId} action=${action} reorder=${String(body.reorder)}`);
          return { stale: true as const, code: "stale_order" };
        }
        if (arrived) {
          console.error(`[unit-act] arrived unit=${unitId} action=${action} reorder=${String(body.reorder)} dist=${Math.round(dist)} effPos=${effPos.lat.toFixed(4)},${effPos.lon.toFixed(4)} dest=${destLat.toFixed(4)},${destLon.toFixed(4)}`);
          // 확정 위치: 목적지가 권위위치와 동떨어지면(>300m) 권위위치를 쓴다.
          const near = haversineM(destLat, destLon, effPos.lat, effPos.lon) <= 300;
          const fixLat = near ? destLat : effPos.lat;
          const fixLon = near ? destLon : effPos.lon;
          const moved = units.map((s) =>
            s.id === unitId
              ? { ...s, lat: fixLat, lon: fixLon, lastMoveAt: now, moveTarget: null }
              : s,
          );
          await tx.missionUser.update({
            where: { userId },
            data: { data: withUnits(row?.data, moved) },
          });
          return { action, lat: fixLat, lon: fixLon, moveEndsAt: null, moveTarget: null };
        }
        const sameDest =
          hasActiveMove &&
          !!activeTarget &&
          haversineM(destLat, destLon, activeTarget.lat, activeTarget.lon) < 1;
        const submittedPath = parseOrderPath(body.via, body.path);
        // path(확정 경로)와 via(구 경유점 joints)를 구분해 저장한다.
        const submittedVia = Array.isArray(body.via)
          ? body.via
              .filter(
                (point): point is { lat: number; lon: number } =>
                  typeof point === "object" &&
                  point !== null &&
                  Number.isFinite((point as { lat?: unknown }).lat) &&
                  Number.isFinite((point as { lon?: unknown }).lon),
              )
              .slice(0, 200)
              .map((point) => ({ lat: point.lat, lon: point.lon }))
          : null;
        if (sameDest && body.reorder !== true && !submittedPath) {
          // 하트비트: 주문 변경 없이 현재 권위위치만 반환한다.
          return {
            action,
            lat: effPos.lat,
            lon: effPos.lon,
            moveEndsAt: activeTarget ? activeTarget.endsAt : null,
            moveTarget: activeTarget,
          };
        }
        // 신규 주문 (또는 경로 승격). 출발지는 항상 현재 권위위치.
        const fromLat = effPos.lat;
        const fromLon = effPos.lon;
        // 제출 경로 검증: 양 끝이 출발지·목적지 근처(100m)여야 채택, 아니면 직선 fallback.
        let orderPath = submittedPath;
        let hasRealPath = Array.isArray(body.path);
        if (orderPath && orderPath.length > 0) {
          const first = orderPath[0];
          const last = orderPath[orderPath.length - 1];
          const endsOk =
            !!first &&
            !!last &&
            haversineM(fromLat, fromLon, first.lat, first.lon) <= 100 &&
            haversineM(destLat, destLon, last.lat, last.lon) <= 100;
          if (!endsOk) {
            orderPath = null;
            hasRealPath = false;
          }
        }
        // 같은 목적지 재주문인데 새 경로가 없으면 기존 확정 경로를 계승한다 (버리지 않음).
        if (!orderPath && sameDest && activeTarget?.path && activeTarget.path.length > 0) {
          orderPath = activeTarget.path;
          hasRealPath = true;
        }
        const straightFloorMs = Math.max(1000, (tripDist / UNIT_SPEED_MPS) * 1000);
        const pathFloorMs = orderPath
          ? Math.max(
              1000,
              (movePathLengthM({
                fromLat,
                fromLon,
                lat: destLat,
                lon: destLon,
                via: null,
                path: orderPath,
              }) /
                UNIT_SPEED_MPS) *
                1000,
            )
          : 0;
        const clientDurationRaw = parseNumber(body.durationMs);
        const clientDurationMs =
          clientDurationRaw !== null && Number.isFinite(clientDurationRaw)
            ? Math.min(Math.max(clientDurationRaw, 0), 3 * 24 * 3600 * 1000)
            : null;
        // 지름길 치트 방지: 소요시간은 경로 길이 하한보다 짧을 수 없다.
        // 검증된 경로가 없으면 클라이언트 주장 소요시간은 직선의 3배로 상한을 둔다
        // (쓰레기 경로 기반 47시간 주문 같은 폭주 방지 — 실제 우회는 3배 안에 든다).
        const clientCappedMs =
          hasRealPath && orderPath
            ? (clientDurationMs ?? 0)
            : Math.min(clientDurationMs ?? 0, 3 * straightFloorMs);
        const durationMs = Math.max(straightFloorMs, pathFloorMs, clientCappedMs);
        const startedAt = now;
        const endsAt = now + durationMs;
        const newTarget = {
          fromLat,
          fromLon,
          lat: destLat,
          lon: destLon,
          startedAt,
          endsAt,
          via: hasRealPath ? null : (submittedVia ?? activeTarget?.via ?? null),
          path: hasRealPath ? orderPath : null,
        };
        const moved = units.map((s) =>
          s.id === unitId
            ? { ...s, lat: fromLat, lon: fromLon, lastMoveAt: now, moveTarget: newTarget }
            : s,
        );
        await tx.missionUser.update({
          where: { userId },
          data: { data: withUnits(row?.data, moved) },
        });
        console.error(`[unit-act] order unit=${unitId} action=${action} hasRealPath=${hasRealPath} pathLen=${orderPath ? orderPath.length : 0} durH=${(durationMs / 3600000).toFixed(1)} tripKm=${(tripDist / 1000).toFixed(1)}`);
        return {
          action,
          lat: fromLat,
          lon: fromLon,
          moveEndsAt: newTarget ? newTarget.endsAt : null,
          moveTarget: newTarget,
        };
      }

      if (action === "scout") {
        const gpsRows = await tx.aRMissionGPS.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { EventKey: true, location: true, locationname: true },
        });
        const events = await tx.aRMissionEvent.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { EventKey: true, string_param1: true },
        });
        const ownerByKey = new Map<string, string | null>();
        for (const e of events) {
          try {
            const meta = JSON.parse(e.string_param1 ?? "") as { owner?: unknown };
            ownerByKey.set(
              e.EventKey ?? "",
              typeof meta.owner === "string" ? meta.owner : null,
            );
          } catch {
            ownerByKey.set(e.EventKey ?? "", null);
          }
        }
        const found = gpsRows.flatMap((g) => {
          const coords = parseLatLon(g.location);
          if (!coords) {
            return [];
          }
          const d = haversineM(effPos.lat, effPos.lon, coords.lat, coords.lon);
          if (d > 500) {
            return [];
          }
          const owner = ownerByKey.get(g.EventKey ?? "");
          return [
            {
              castleKey: g.EventKey ?? "",
              name: g.locationname?.trim() || (g.EventKey ?? ""),
              distance: Math.round(d),
              mine: owner === userId,
            },
          ];
        });
        await persist();
        return {
          action,
          castles: found,
        };
      }

      // siege / defend / join: 성 필요
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.status !== "active") {
        throw new Error("castle_pending");
      }
      if (haversineM(effPos.lat, effPos.lon, castle.lat, castle.lon) > 100) {
        throw new Error("out_of_range");
      }

      if (action === "siege") {
        if (castle.meta.owner === userId) {
          throw new Error("own_castle");
        }
        const [cooldownSec, attempts] = await Promise.all([
          getSiegeCooldownRemainingSecTx(tx, userId, castleKey, ctx.missionKey),
          getSiegeAttemptsLast24h(tx, userId, castleKey),
        ]);
        if (cooldownSec > 0) {
          throw new Error("cooldown");
        }
        if (attempts >= SIEGE_DAILY_CAP) {
          throw new Error("daily_cap");
        }
        const damage = await applyUnitTouch(tx, ctx.missionKey, castle, userId, unitId);
        await persist();
        return {
          action,
          touches: damage.touches,
          hp: damage.hp,
          maxHp: damage.maxHp,
          conquered: damage.conquered,
        };
      }

      if (action === "defend") {
        const membership = await tx.missionTeam.findFirst({
          where: { userId, teamId: castleKey },
          select: { id: true },
        });
        if (!membership) {
          throw new Error("not_member");
        }
        const lastDefend = await tx.aRMissionUserScore.findFirst({
          where: {
            UserId: userId,
            EventKey: castleKey,
            answer: { startsWith: `defend:${castleKey}:${unitId}` },
          },
          orderBy: { scoredate: "desc" },
          select: { scoredate: true },
        });
        if (
          lastDefend?.scoredate instanceof Date &&
          now - lastDefend.scoredate.getTime() < 3600 * 1000
        ) {
          throw new Error("defend_cooldown");
        }
        await tx.aRMissionUserScore.create({
          data: {
            UserId: userId,
            EventKey: castleKey,
            ARMissionKey: ctx.missionKey,
            answer: `defend:${castleKey}:${unitId}`.slice(0, 120),
            score: 10,
            scoredate: new Date(),
            islastscore: 1,
          },
        });
        await persist();
        return {
          action,
          contribution: 10,
        };
      }

      // join: 부대 위치로 입성 (소속 없을 때만. 이적은 지도 join UI에서)
      const klass = await refreshUserClass(tx, userId, ctx.missionKey);
      if (klass === "slave") {
        throw new Error("class_ineligible");
      }
      const membership = await tx.missionTeam.findFirst({
        where: { userId },
        select: { teamId: true },
      });
      if (membership?.teamId) {
        throw new Error("already_member");
      }
      const joined = await performJoin(tx, ctx.missionKey, userId, klass, castle, {
        transfer: false,
        fromCastle: null,
      });
      await persist();
      return {
        action,
        ...joined,
      };
    });

    if (result && typeof result === "object" && "recalled" in result) {
      return NextResponse.json({ ok: false, code: "recall" }, { status: 400 });
    }
    if (result && typeof result === "object" && "stale" in result) {
      // 무효 동기화는 성공으로 응답해 실패 카운터를 올리지 않는다 (이동 재개 없음).
      return NextResponse.json({ ok: true, unitId, servantId: unitId, ...result });
    }
    return NextResponse.json({ ok: true, unitId, servantId: unitId, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "unit_not_found",
        "unit_dead",
        "unit_garrisoned",
        "too_fast",
        "recall",
        "castle_not_found",
        "castle_pending",
        "out_of_range",
        "own_castle",
        "cooldown",
        "daily_cap",
        "not_member",
        "defend_cooldown",
        "class_ineligible",
        "already_member",
        "transfer_cooldown",
        "funds",
        "capacity",
      ].includes(error.message)
        ? error.message
        : "act_failed";
    const status =
      code === "unit_not_found" || code === "castle_not_found"
        ? 404
        : code === "daily_cap"
          ? 429
          : code === "funds"
            ? 402
            : ["already_member", "defend_cooldown", "cooldown", "transfer_cooldown"].includes(code)
              ? 409
              : 400;
    if (code === "act_failed") {
      console.error("[units/act] failed", error);
    } else {
      console.warn("[units/act] rejected", {
        action,
        code,
        unitId,
        distM: Math.round(lastMoveDistM * 10) / 10,
        dtSec: Math.round(lastMoveDtSec * 10) / 10,
      });
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
