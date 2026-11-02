"use client";

import { useEffect, useMemo, useState } from "react";

import {
  fetchBoundary,
  getDisplayName,
  normalizeProperties,
  type AdminLevel,
} from "@/lib/admin-boundaries";

/** 영토전 시작 위치 (시-도/군-구/동-읍 선택). 미션별 로컬 저장. */
export interface TerritoryStart {
  lat: number;
  lon: number;
  sido: string;
  sigungu: string;
  dong: string;
}

interface RegionItem {
  code: string;
  name: string;
  lat: number;
  lon: number;
  parentCode: string | null;
}

type LonLat = [number, number];

const eachPosition = (
  coords: unknown,
  visit: (lon: number, lat: number) => void,
): void => {
  if (!Array.isArray(coords)) {
    return;
  }
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    visit(coords[0] as number, coords[1] as number);
    return;
  }
  for (const part of coords as unknown[]) {
    eachPosition(part, visit);
  }
};

const ringAreaCentroid = (
  ring: LonLat[],
): { area: number; cx: number; cy: number } => {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0] ?? 0;
    const yi = ring[i]?.[1] ?? 0;
    const xj = ring[j]?.[0] ?? 0;
    const yj = ring[j]?.[1] ?? 0;
    const cross = xj * yi - xi * yj;
    a2 += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (a2 === 0) {
    return { area: 0, cx: 0, cy: 0 };
  }
  return { area: Math.abs(a2) / 2, cx: cx / (3 * a2), cy: cy / (3 * a2) };
};

// bbox 중심이 바다에 떨어지는 섬·해안 지역이 많아 면적 중심점을 쓴다.
// bbox 중심은 상위 연결도 틀리게 하고 시작 마커를 바다에 찍는다.
const geometryCenter = (geometry: unknown): { lat: number; lon: number } | null => {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) {
    return null;
  }
  const polys: LonLat[][][] =
    g.type === "Polygon"
      ? [g.coordinates as LonLat[][]]
      : g.type === "MultiPolygon"
        ? (g.coordinates as LonLat[][][])
        : [];
  let best: { area: number; cx: number; cy: number } | null = null;
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || outer.length < 3) {
      continue;
    }
    const c = ringAreaCentroid(outer);
    if (c.area > 0 && (!best || c.area > best.area)) {
      best = c;
    }
  }
  if (!best) {
    return null;
  }
  return { lat: best.cy, lon: best.cx };
};

const ringContains = (ring: LonLat[], lon: number, lat: number): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0] ?? 0;
    const yi = ring[i]?.[1] ?? 0;
    const xj = ring[j]?.[0] ?? 0;
    const yj = ring[j]?.[1] ?? 0;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

const geometryContains = (geometry: unknown, lon: number, lat: number): boolean => {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) {
    return false;
  }
  if (g.type === "Polygon") {
    const rings = g.coordinates as LonLat[][];
    return rings.length > 0 && !!rings[0] && ringContains(rings[0], lon, lat);
  }
  if (g.type === "MultiPolygon") {
    for (const poly of g.coordinates as LonLat[][][]) {
      if (poly.length > 0 && poly[0] && ringContains(poly[0], lon, lat)) {
        return true;
      }
    }
  }
  return false;
};

interface LoadedRegions {
  sido: RegionItem[];
  sigungu: RegionItem[];
  dong: RegionItem[];
}

const loadRegions = async (): Promise<LoadedRegions> => {
  const [sidoFc, sigunguFc, dongFc, korNamesRaw, sigunguSidoRaw] = await Promise.all([
    fetchBoundary("KOR", "sido"),
    fetchBoundary("KOR", "sigungu"),
    fetchBoundary("KOR", "dong"),
    fetch("/boundaries/kor_name_ko.json", { credentials: "omit" }).then((res) =>
      res.ok ? (res.json() as Promise<unknown>) : null,
    ),
    fetch("/boundaries/sigungu_sido.json", { credentials: "omit" }).then((res) =>
      res.ok ? (res.json() as Promise<unknown>) : null,
    ),
  ]);
  const korNames = (korNamesRaw as Record<string, Record<string, string>> | null) ?? {};
  const toItems = (
    fc: { features?: Array<{ properties?: unknown; geometry?: unknown }> },
    level: AdminLevel,
  ): Array<RegionItem & { geometry: unknown }> => {
    const out: Array<RegionItem & { geometry: unknown }> = [];
    const nameMap: Record<string, string> = korNames[level] ?? {};
    for (const feature of fc.features ?? []) {
      const norm = normalizeProperties(feature.properties, "KOR", level);
      const rawRec = feature.properties as Record<string, unknown> | null;
      const shapeId =
        typeof rawRec?.shapeID === "string" && rawRec.shapeID ? rawRec.shapeID : null;
      // kor_name_ko.json은 shapeID 기준 — 코드도 shapeID로 통일한다.
      const code = shapeId ?? norm.code;
      const name = (shapeId && nameMap[shapeId]) || getDisplayName({ ...norm });
      const center = geometryCenter(feature.geometry);
      if (!center) {
        continue;
      }
      out.push({
        code,
        name,
        lat: center.lat,
        lon: center.lon,
        parentCode: null,
        geometry: feature.geometry,
      });
    }
    return out;
  };
  const sido = toItems(sidoFc, "sido");
  const sigungu = toItems(sigunguFc, "sigungu");
  const dong = toItems(dongFc, "dong");
  // bbox 사전 필터 후 포함 판정으로 상하위 연결.
  // 단순화된 경계가 겹칠 수 있어 포함된 후보 중 면적이 가장 작은 상위를 택한다
  // (파일 순서 첫 매칭은 연수구→경기도 같은 오연결을 만든다).
  const linkParents = (
    children: Array<RegionItem & { geometry: unknown }>,
    parents: Array<RegionItem & { geometry: unknown }>,
  ): void => {
    const parentInfos = parents.map((p) => {
      let minLon = Number.POSITIVE_INFINITY;
      let minLat = Number.POSITIVE_INFINITY;
      let maxLon = Number.NEGATIVE_INFINITY;
      let maxLat = Number.NEGATIVE_INFINITY;
      let sx = 0;
      let sy = 0;
      let n = 0;
      eachPosition(
        (p.geometry as { coordinates?: unknown })?.coordinates,
        (lon, lat) => {
          if (lon < minLon) minLon = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLon) maxLon = lon;
          if (lat > maxLat) maxLat = lat;
          sx += lon;
          sy += lat;
          n += 1;
        },
      );
      const area = Math.max(0, maxLon - minLon) * Math.max(0, maxLat - minLat);
      return { p, minLon, minLat, maxLon, maxLat, cx: n > 0 ? sx / n : 0, cy: n > 0 ? sy / n : 0, area };
    });
    const bboxDist = (
      info: (typeof parentInfos)[number],
      lon: number,
      lat: number,
    ): number => {
      const dx = lon < info.minLon ? info.minLon - lon : lon > info.maxLon ? lon - info.maxLon : 0;
      const dy = lat < info.minLat ? info.minLat - lat : lat > info.maxLat ? lat - info.maxLat : 0;
      return dx * dx + dy * dy;
    };
    for (const child of children) {
      let best: string | null = null;
      let bestArea = Number.POSITIVE_INFINITY;
      for (const info of parentInfos) {
        if (
          child.lon < info.minLon ||
          child.lon > info.maxLon ||
          child.lat < info.minLat ||
          child.lat > info.maxLat
        ) {
          continue;
        }
        if (geometryContains(info.p.geometry, child.lon, child.lat) && info.area < bestArea) {
          bestArea = info.area;
          best = info.p.code;
        }
      }
      if (best !== null) {
        child.parentCode = best;
        continue;
      }
      // 포함 실패(섬·해안 경계 등)는 bbox 중심 포함 → 정점 다수결 순으로 재시도한다.
      // 정점 수집 (표본 상한 80점).
      const childVerts: LonLat[] = [];
      eachPosition(
        (child.geometry as { coordinates?: unknown })?.coordinates,
        (lon, lat) => {
          childVerts.push([lon, lat]);
        },
      );
      const tryPoint = (lon: number, lat: number): string | null => {
        let pb: string | null = null;
        let pbArea = Number.POSITIVE_INFINITY;
        for (const info of parentInfos) {
          if (
            lon < info.minLon ||
            lon > info.maxLon ||
            lat < info.minLat ||
            lat > info.maxLat
          ) {
            continue;
          }
          if (geometryContains(info.p.geometry, lon, lat) && info.area < pbArea) {
            pbArea = info.area;
            pb = info.p.code;
          }
        }
        return pb;
      };
      let rescued: string | null = null;
      if (childVerts.length > 0) {
        let cminLon = Number.POSITIVE_INFINITY;
        let cminLat = Number.POSITIVE_INFINITY;
        let cmaxLon = Number.NEGATIVE_INFINITY;
        let cmaxLat = Number.NEGATIVE_INFINITY;
        for (const [lon, lat] of childVerts) {
          if (lon < cminLon) cminLon = lon;
          if (lat < cminLat) cminLat = lat;
          if (lon > cmaxLon) cmaxLon = lon;
          if (lat > cmaxLat) cmaxLat = lat;
        }
        rescued = tryPoint((cminLon + cmaxLon) / 2, (cminLat + cmaxLat) / 2);
        if (rescued === null) {
          const step = Math.max(1, Math.floor(childVerts.length / 80));
          const votes = new Map<string, number>();
          for (let vi = 0; vi < childVerts.length; vi += step) {
            const vp = childVerts[vi];
            if (!vp) {
              continue;
            }
            const hit = tryPoint(vp[0] ?? 0, vp[1] ?? 0);
            if (hit !== null) {
              votes.set(hit, (votes.get(hit) ?? 0) + 1);
            }
          }
          let top: string | null = null;
          let topN = 0;
          for (const [code, n] of votes) {
            if (n > topN) {
              topN = n;
              top = code;
            }
          }
          rescued = top;
        }
      }
      if (rescued !== null) {
        child.parentCode = rescued;
        continue;
      }
      // 포함 실패(섬·해안 경계 등)는 bbox 거리 최근접 상위를 붙인다 (선택 불가 방지).
      // 동점(겹치는 bbox)은 면적이 작은 쪽을 택한다.
      // (경계선 정밀 거리는 단순화된 경계에서 이웃을 오선택하므로 쓰지 않는다.)
      let fb: string | null = null;
      let fbD = Number.POSITIVE_INFINITY;
      let fbArea = Number.POSITIVE_INFINITY;
      for (const info of parentInfos) {
        const d = bboxDist(info, child.lon, child.lat);
        if (d < fbD || (d === fbD && info.area < fbArea)) {
          fbD = d;
          fbArea = info.area;
          fb = info.p.code;
        }
      }
      child.parentCode = fb;
    }
  };
  linkParents(sigungu, sido);
  linkParents(dong, sigungu);
  // 시군구 → 시도 확정 매핑 (조악한 시도 경계로는 기하 연결이 불가 — 연제구 누락·부산진구 중복 등).
  const sigunguSidoMap = (sigunguSidoRaw as Record<string, string> | null) ?? {};
  const sidoCodes = new Set(sido.map((s) => s.code));
  for (const s of sigungu) {
    const fix = sigunguSidoMap[s.code];
    if (typeof fix === "string" && fix && sidoCodes.has(fix)) {
      s.parentCode = fix;
    }
  }
  // 단순화된 경계로는 판정 불가한 확정 오연결 교정표 (동 shapeID → 시군구 shapeID).
  const dongParentFix: Record<string, string> = {
    "71637012B31806892542725": "91817680B43546326994356", // 만석동 → 인천 동구
    "71637012B82924812210531": "91817680B43546326994356", // 화수2동 → 인천 동구
    "71637012B15863739486533": "91817680B43546326994356", // 송현3동 → 인천 동구
    "71637012B42647023019691": "91817680B37911583032119", // 정왕3동 → 시흥시
    "71637012B42588270049068": "91817680B53321453404308", // 개포3동 → 강남구
    "71637012B86478030676600": "91817680B53321453404308", // 수서동 → 강남구
    "71637012B73195636030109": "91817680B53321453404308", // 신사동 → 강남구
    "71637012B19167350807075": "91817680B53321453404308", // 압구정동 → 강남구
    "71637012B27573373099108": "91817680B53321453404308", // 일원1동 → 강남구
    "71637012B6369002784303": "91817680B53321453404308", // 청담동 → 강남구
    "71637012B80309355348975": "91817680B92844029998138", // 번1동 → 강북구
    "71637012B29291305120551": "91817680B92844029998138", // 번3동 → 강북구
    "71637012B44702766635796": "91817680B92844029998138", // 수유3동 → 강북구
    "71637012B27937910305956": "91817680B94833670639499", // 효성1동 → 계양구
    "71637012B62126657955635": "91817680B94833670639499", // 효성1동 → 계양구
    "71637012B16745978774531": "91817680B99536699865294", // 남현동 → 관악구
    "71637012B82144398034424": "91817680B99536699865294", // 미성동 → 관악구
    "71637012B41919620064771": "91817680B99536699865294", // 성현동 → 관악구
    "71637012B57110126984403": "91817680B99536699865294", // 신림동 → 관악구
    "71637012B14636706776282": "91817680B99536699865294", // 신사동 → 관악구
    "71637012B63405046889434": "91817680B99536699865294", // 은천동 → 관악구
    "71637012B98778928206905": "91817680B99536699865294", // 인헌동 → 관악구
    "71637012B68804420810735": "91817680B99536699865294", // 조원동 → 관악구
    "71637012B31989139640646": "91817680B99536699865294", // 중앙동 → 관악구
    "71637012B20564876123541": "91817680B99536699865294", // 청림동 → 관악구
    "71637012B73132848744663": "91817680B3942656644244", // 광명1동 → 광명시
    "71637012B3642698190940": "91817680B3942656644244", // 광명2동 → 광명시
    "71637012B41144187723143": "91817680B3942656644244", // 광명3동 → 광명시
    "71637012B22046002521310": "91817680B3942656644244", // 광명4동 → 광명시
    "71637012B37754098753990": "91817680B3942656644244", // 광명5동 → 광명시
    "71637012B45360766812357": "91817680B3942656644244", // 광명6동 → 광명시
    "71637012B7282037645051": "91817680B3942656644244", // 철산1동 → 광명시
    "71637012B20171696411827": "91817680B3942656644244", // 철산2동 → 광명시
    "71637012B67831803136674": "91817680B16538338684661", // 신창동 → 광산구
    "71637012B13157885866575": "91817680B16538338684661", // 양산동 → 광산구
    "71637012B28410843906417": "91817680B16538338684661", // 우산동 → 광산구
    "71637012B91516291633834": "91817680B16538338684661", // 우산동 → 광산구
    "71637012B45348248943598": "91817680B49246193334347", // 자양4동 → 광진구
    "71637012B12542994148010": "91817680B49246193334347", // 중곡1동 → 광진구
    "71637012B56070770860465": "91817680B1968034056748", // 고척1동 → 구로구
    "71637012B6071786315250": "91817680B1968034056748", // 고척2동 → 구로구
    "71637012B77713455348608": "91817680B1968034056748", // 고척2동 → 구로구
    "71637012B36526679242406": "91817680B1968034056748", // 신도림동 → 구로구
    "71637012B75774098847153": "91817680B5684950588758", // 갈매동 → 구리시
    "71637012B31223040759225": "91817680B11476058556898", // 대연3동 → 남구
    "71637012B42156876879517": "91817680B65451529480853", // 무거동 → 남구
    "71637012B57471256505669": "91817680B68494559899558", // 월산4동 → 남구
    "71637012B83157330127645": "91817680B68494559899558", // 월산5동 → 남구
    "71637012B69041889545308": "91817680B68494559899558", // 월산동 → 남구
    "71637012B70505916835461": "91817680B68494559899558", // 주월2동 → 남구
    "71637012B50329467168256": "91817680B6950995223857", // 상계8동 → 노원구
    "71637012B55837830676965": "91817680B6950995223857", // 월계2동 → 노원구
    "71637012B69216303931314": "91817680B55050579859044", // 방학3동 → 도봉구
    "71637012B47963685221384": "91817680B53543824194985", // 가양2동 → 동구
    "71637012B9880784939358": "91817680B24548286345957", // 범일1동 → 동구
    "71637012B78146902595718": "91817680B89733153975870", // 사직동 → 동구
    "71637012B42056241316513": "91817680B43546326994356", // 송림4동 → 동구
    "71637012B78956338197856": "91817680B24548286345957", // 초량1동 → 동구
    "71637012B28772557347228": "91817680B24548286345957", // 초량2동 → 동구
    "71637012B28826854824193": "91817680B24548286345957", // 초량6동 → 동구
    "71637012B51195962032142": "91817680B89733153975870", // 충장동 → 동구
    "71637012B9948858249994": "91817680B25965069984368", // 이문1동 → 동대문구
    "71637012B10803794792529": "91817680B25965069984368", // 이문2동 → 동대문구
    "71637012B77032327426448": "91817680B25965069984368", // 제기동 → 동대문구
    "71637012B75670582645709": "91817680B25965069984368", // 청량리동 → 동대문구
    "71637012B6807811999928": "91817680B25965069984368", // 회기동 → 동대문구
    "71637012B22177687439127": "91817680B72690271662871", // 노량진1동 → 동작구
    "71637012B96558037049500": "91817680B72690271662871", // 노량진2동 → 동작구
    "71637012B82778598410936": "91817680B72690271662871", // 대방동 → 동작구
    "71637012B52103180299438": "91817680B72690271662871", // 신대방1동 → 동작구
    "71637012B34726861497693": "91817680B72690271662871", // 신대방2동 → 동작구
    "71637012B57052275321590": "91817680B14643286354390", // 공덕동 → 마포구
    "71637012B3895708158043": "91817680B14643286354390", // 대흥동 → 마포구
    "71637012B83432438648270": "91817680B14643286354390", // 아현동 → 마포구
    "71637012B79801830185890": "91817680B14643286354390", // 연남동 → 마포구
    "71637012B59550591103296": "91817680B14643286354390", // 염리동 → 마포구
    "71637012B44540642675334": "91817680B16033238555875", // 주안5동 → 미추홀구
    "71637012B88361924934808": "91817680B16033238555875", // 주안6동 → 미추홀구
    "71637012B35853758438888": "91817680B32751924176777", // 가야2동 → 부산진구
    "71637012B61720730975010": "91817680B32751924176777", // 개금2동 → 부산진구
    "71637012B87332909288454": "91817680B32751924176777", // 당감4동 → 부산진구
    "71637012B37252991102845": "91817680B32751924176777", // 연지동 → 부산진구
    "71637012B20221292862564": "91817680B41928523553758", // 수궁동 → 부천시
    "71637012B14988834399585": "91817680B41928523553758", // 원종2동 → 부천시
    "71637012B32745128397513": "91817680B45509654992593", // 십정1동 → 부평구
    "71637012B86616007290913": "91817680B45509654992593", // 청천1동 → 부평구
    "71637012B49056040406732": "91817680B50207003035", // 주례2동 → 사상구
    "71637012B79888278609557": "91817680B15590775835688", // 감천2동 → 사하구
    "71637012B52105627999380": "91817680B65126245655882", // 남가좌2동 → 서대문구
    "71637012B83056891299": "91817680B65126245655882", // 북가좌1동 → 서대문구
    "71637012B41336589470134": "91817680B65126245655882", // 북가좌2동 → 서대문구
    "71637012B74382678010770": "91817680B65126245655882", // 홍은1동 → 서대문구
    "71637012B42717938904747": "91817680B65126245655882", // 홍은2동 → 서대문구
    "71637012B44443693730594": "91817680B5725333816693", // 반포2동 → 서초구
    "71637012B22350299113742": "91817680B5725333816693", // 반포3동 → 서초구
    "71637012B50477731516813": "91817680B5725333816693", // 반포본동 → 서초구
    "71637012B44071520227417": "91817680B5725333816693", // 방배본동 → 서초구
    "71637012B42595907744357": "91817680B5725333816693", // 서초2동 → 서초구
    "71637012B92552685378940": "91817680B5725333816693", // 잠원동 → 서초구
    "71637012B90297315686695": "91817680B63185877293812", // 금호2·3가동 → 성동구
    "71637012B27141423987822": "91817680B63185877293812", // 마장동 → 성동구
    "71637012B71915968834145": "91817680B63185877293812", // 옥수동 → 성동구
    "71637012B69493722884131": "91817680B63185877293812", // 왕십리2동 → 성동구
    "71637012B99499462816755": "91817680B63185877293812", // 왕십리도선동 → 성동구
    "71637012B73040572031633": "91817680B63185877293812", // 용답동 → 성동구
    "71637012B5021584383507": "91817680B63185877293812", // 용답동 → 성동구
    "71637012B11768672932807": "91817680B19736947579274", // 길음1동 → 성북구
    "71637012B73205351162012": "91817680B19736947579274", // 길음2동 → 성북구
    "71637012B58173279510960": "91817680B19736947579274", // 석관동 → 성북구
    "71637012B69978741851758": "91817680B19736947579274", // 월곡1동 → 성북구
    "71637012B56902490898713": "91817680B19736947579274", // 장위1동 → 성북구
    "71637012B90243799908112": "91817680B19736947579274", // 장위3동 → 성북구
    "71637012B32804621831268": "91817680B10131618900015", // 오륜동 → 송파구
    "71637012B89597367637249": "91817680B10131618900015", // 잠실2동 → 송파구
    "71637012B51042789200459": "91817680B10131618900015", // 잠실3동 → 송파구
    "71637012B52932937513724": "91817680B10131618900015", // 잠실6동 → 송파구
    "71637012B79621885934391": "91817680B10131618900015", // 풍납1동 → 송파구
    "71637012B7206513395168": "91817680B10131618900015", // 풍납2동 → 송파구
    "71637012B30915438676955": "91817680B49679347075852", // 범어3동 → 수성구
    "71637012B30077753420964": "91817680B55707549130569", // 광안3동 → 수영구
    "71637012B83401133928929": "91817680B8017156108400", // 목2동 → 양천구
    "71637012B26366576030300": "91817680B8017156108400", // 목4동 → 양천구
    "71637012B15572539423150": "91817680B8017156108400", // 신월1동 → 양천구
    "71637012B67504342196701": "91817680B8017156108400", // 신월2동 → 양천구
    "71637012B4723476113635": "91817680B8017156108400", // 신월3동 → 양천구
    "71637012B56744837864331": "91817680B8017156108400", // 신월5동 → 양천구
    "71637012B82140999102677": "91817680B8017156108400", // 신정1동 → 양천구
    "71637012B17674512632206": "91817680B8017156108400", // 신정4동 → 양천구
    "71637012B36683108255976": "91817680B14745943099772", // 연수1동 → 연수구
    "71637012B65642908485137": "91817680B14745943099772", // 옥련1동 → 연수구
    "71637012B94543994910139": "91817680B14745943099772", // 옥련2동 → 연수구
    "71637012B51060251772501": "91817680B14745943099772", // 청학동 → 연수구
    "71637012B54832521185911": "91817680B90297389150949", // 거제1동 → 연제구
    "71637012B85379809344915": "91817680B90297389150949", // 망미2동 → 연제구
    "71637012B47560545438056": "91817680B90297389150949", // 부암1동 → 연제구
    "71637012B64820029687719": "91817680B90297389150949", // 연산1동 → 연제구
    "71637012B68362077080003": "91817680B90297389150949", // 연산8동 → 연제구
    "71637012B99457873545241": "91817680B5490200958143", // 양평1동 → 영등포구
    "71637012B33463817192712": "91817680B5490200958143", // 양평2동 → 영등포구
    "71637012B50679134830040": "91817680B50347392057391", // 남영동 → 용산구
    "71637012B82935443779696": "91817680B50347392057391", // 원효로1동 → 용산구
    "71637012B88956199833674": "91817680B50347392057391", // 원효로2동 → 용산구
    "71637012B6628493670174": "91817680B50347392057391", // 이태원2동 → 용산구
    "71637012B23679405565092": "91817680B50347392057391", // 청파동 → 용산구
    "71637012B70130212275407": "91817680B50347392057391", // 한남동 → 용산구
    "71637012B78532341429733": "91817680B50347392057391", // 효창동 → 용산구
    "71637012B19140925674489": "91817680B50347392057391", // 후암동 → 용산구
    "71637012B99842179201087": "91817680B55576639555152", // 가회동 → 종로구
    "71637012B33566413410810": "91817680B55576639555152", // 숭인1동 → 종로구
    "71637012B93054337353525": "91817680B55576639555152", // 숭인2동 → 종로구
    "71637012B23791073377731": "91817680B55576639555152", // 이화동 → 종로구
    "71637012B62925532461928": "91817680B55576639555152", // 창신1동 → 종로구
    "71637012B76919224824992": "91817680B55576639555152", // 창신2동 → 종로구
    "71637012B14887008827224": "91817680B55576639555152", // 창신3동 → 종로구
    "71637012B41401492824938": "91817680B55576639555152", // 혜화동 → 종로구
    "71637012B46540650349267": "91817680B29418542168397", // 동화동 → 중구
    "71637012B45635793034635": "91817680B29418542168397", // 명동 → 중구
    "71637012B79022039558889": "91817680B85909931268472", // 부평동 → 중구
    "71637012B35581065341078": "91817680B29418542168397", // 신당5동 → 중구
    "71637012B32777111674615": "91817680B29418542168397", // 을지로동 → 중구
    "71637012B18516545615910": "91817680B29418542168397", // 을지로동 → 중구
    "71637012B88375003353780": "91817680B29418542168397", // 중림동 → 중구
    "71637012B421558319134": "91817680B30301323398004", // 태평1동 → 중구
    "71637012B89649178875604": "91817680B30301323398004", // 태평2동 → 중구
    "71637012B3974376303030": "91817680B29418542168397", // 황학동 → 중구
    "71637012B86565937302530": "91817680B66829558888986", // 망우본동 → 중랑구
    "71637012B20105837109153": "91817680B66829558888986", // 신내2동 → 중랑구
  };
  for (const d of dong) {
    const fix = dongParentFix[d.code];
    if (fix) {
      d.parentCode = fix;
    }
  }
  // 시군구 → 시도의 확정 오연결 교정표 (시군구 shapeID → 시도 shapeID).
  const sigunguParentFix: Record<string, string> = {
    "91817680B73279111808647": "68945753B50642023031709", // 인천 서구 → 인천광역시
  };
  for (const s of sigungu) {
    const fix = sigunguParentFix[s.code];
    if (fix) {
      s.parentCode = fix;
    }
  }
  const strip = (items: Array<RegionItem & { geometry: unknown }>): RegionItem[] =>
    items.map(({ code, name, lat, lon, parentCode }) => ({ code, name, lat, lon, parentCode }));
  return { sido: strip(sido), sigungu: strip(sigungu), dong: strip(dong) };
};

interface TerritoryStartPickerProps {
  required: boolean;
  initial: TerritoryStart | null;
  onPick: (start: TerritoryStart) => void;
  onClose?: () => void;
}

export default function TerritoryStartPicker({
  required,
  initial,
  onPick,
  onClose,
}: TerritoryStartPickerProps) {
  const [regions, setRegions] = useState<LoadedRegions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [sidoCode, setSidoCode] = useState<string | null>(null);
  const [sigunguCode, setSigunguCode] = useState<string | null>(null);
  const [dongCode, setDongCode] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadRegions()
      .then((loaded) => {
        if (!cancelled) {
          setRegions(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sigunguList = useMemo(() => {
    if (!regions) {
      return [];
    }
    const list = sidoCode
      ? regions.sigungu.filter((s) => s.parentCode === sidoCode)
      : regions.sigungu;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [regions, sidoCode]);

  const dongList = useMemo(() => {
    if (!regions) {
      return [];
    }
    const q = query.trim();
    if (q.length > 0) {
      return regions.dong
        .filter((d) => d.name.includes(q))
        .sort((a, b) => a.name.localeCompare(b.name, "ko"))
        .slice(0, 200);
    }
    const list = sigunguCode
      ? regions.dong.filter((d) => d.parentCode === sigunguCode)
      : sidoCode
        ? regions.dong.filter((d) => {
            const parent = regions.sigungu.find((s) => s.code === d.parentCode);
            return parent?.parentCode === sidoCode;
          })
        : regions.dong;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko")).slice(0, 500);
  }, [regions, sidoCode, sigunguCode, query]);

  const selectedDong = regions?.dong.find((d) => d.code === dongCode) ?? null;
  const selectedSigungu = regions?.sigungu.find((s) =>
    selectedDong ? s.code === selectedDong.parentCode : s.code === sigunguCode,
  );
  const selectedSido = regions?.sido.find((s) =>
    selectedSigungu
      ? s.code === selectedSigungu.parentCode
      : s.code === sidoCode,
  );

  const listClass =
    "min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-2";

  return (
    <div className="pointer-events-auto fixed inset-0 z-[3000] flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-slate-50 p-4 shadow-2xl">
        <h2 className="text-lg font-black text-slate-900">영토전 시작 위치</h2>
        <p className="mt-1 text-xs text-slate-500">
          영토전에서는 GPS를 사용하지 않습니다. 시작 동네를 선택해 주세요.
          {initial ? ` (현재: ${initial.sido} ${initial.sigungu} ${initial.dong})` : null}
        </p>
        {!regions && !loadError ? (
          <p className="py-8 text-center text-sm text-slate-500">행정구역 불러오는 중…</p>
        ) : loadError || !regions ? (
          <div className="py-8 text-center">
            <p className="text-sm text-slate-600">행정구역을 불러오지 못했습니다.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white"
            >
              다시 시도
            </button>
          </div>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="동 이름 검색 (예: 사직동)"
              className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            />
            <div className="mt-2 flex min-h-0 flex-1 gap-2">
              <div className={listClass}>
                <p className="px-1 text-[11px] font-bold text-slate-400">시·도</p>
                {regions.sido.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    onClick={() => {
                      setSidoCode(s.code);
                      setSigunguCode(null);
                      setDongCode(null);
                    }}
                    className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm ${
                      sidoCode === s.code
                        ? "bg-slate-900 font-bold text-white"
                        : "text-slate-700"
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <div className={listClass}>
                <p className="px-1 text-[11px] font-bold text-slate-400">시·군·구</p>
                {sigunguList.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    onClick={() => {
                      setSigunguCode(s.code);
                      setDongCode(null);
                    }}
                    className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm ${
                      (selectedSigungu?.code ?? sigunguCode) === s.code
                        ? "bg-slate-900 font-bold text-white"
                        : "text-slate-700"
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <div className={listClass}>
                <p className="px-1 text-[11px] font-bold text-slate-400">동·읍·면</p>
                {dongList.map((d) => (
                  <button
                    key={d.code}
                    type="button"
                    onClick={() => setDongCode(d.code)}
                    className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm ${
                      dongCode === d.code
                        ? "bg-slate-900 font-bold text-white"
                        : "text-slate-700"
                    }`}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              disabled={!selectedDong}
              onClick={() => {
                if (!selectedDong || !selectedSigungu || !selectedSido) {
                  return;
                }
                onPick({
                  lat: selectedDong.lat,
                  lon: selectedDong.lon,
                  sido: selectedSido.name,
                  sigungu: selectedSigungu.name,
                  dong: selectedDong.name,
                });
              }}
              className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40"
            >
              {selectedDong
                ? `${selectedSido?.name ?? ""} ${selectedSigungu?.name ?? ""} ${selectedDong.name}에서 시작`
                : "동을 선택해 주세요"}
            </button>
            {!required && onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700"
              >
                닫기
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
