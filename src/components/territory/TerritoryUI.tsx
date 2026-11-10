"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { UNIT_TRAINING_DURATION_MS, UNIT_SPEED_MPS, movePolyline, positionAtMoveTarget } from "@/lib/units";
import type { UnitMoveTarget } from "@/lib/units";
import {
  ensureWalkableData,
  findWalkablePathRecursive,
  isWalkableGridSync,
  smoothPathLatLon,
  snapToNearestWalkableLocation,
} from "@/lib/walkable-client";

export interface TerritoryCastlePoint {
  eventKey: string;
  lat: number;
  lon: number;
  label: string;
}

interface TerritoryUIProps {
  castleKey: string | null;
  onCloseCastle: () => void;
  onOpenCastle: (key: string) => void;
  castlePoints: TerritoryCastlePoint[];
  myLocation: { lat: number; lon: number; accuracy?: number } | null;
  getMapCenter: () => { lat: number; lon: number } | null;
  panToLocation: (lat: number, lon: number) => void;
  getPlayerLocation: () => { lat: number; lon: number } | null;
  isLocationVisible: (lat: number, lon: number) => boolean;
  onUnitMarks: (marks: { id: string; name: string; lat: number; lon: number; mine: boolean; moving: boolean; selected: boolean; quizTitle?: string; moveTarget: { fromLat: number; fromLon: number; lat: number; lon: number; startedAt: number; endsAt: number; via: Array<{ lat: number; lon: number }> | null } | null }[]) => void;
  unitMarkerSelection: { id: string; nonce: number } | null;
  onUnitMarkerSelectionHandled: () => void;
  targetMarkerUrl: string | null;
  onMovePath: (path: Array<{ lat: number; lon: number }> | null) => void;
  onMoveDestination: (dest: { lat: number; lon: number } | null) => void;
  /** 이동 목표 지정 중 지도 중앙 좌표 (이동가능영역 표시용). */
  onMoveTargetCenter: (center: { lat: number; lon: number } | null) => void;
  /** 지도에서 선택된 행정구역 코드 (축성 동 자동 지정용). */
  dongCode: string | null;
  /** 플레이어가 위치한 동 코드 (중립 부대 스폰·조회 기준). */
  playerDongCode?: string | null;
  /** 화면에 보이는 동 시드 (동 코드 + 대표 좌표). */
  wildSeeds?: Array<{ dong: string; lat: number; lon: number }>;
  /** 축성 2단계: 위치 지정 모드 시작. */
  onStartPlacement: (draft: CastleBuildDraft) => void;
  /** 위치 지정 완료/실패 알림 (표시용). */
  placementNotice: { id: number; message: string } | null;
  /** 나가기(로그아웃). */
  onExit: () => void;
  /** 점수 리셋. */
  onResetScore: () => void;
  /** 영주(플레이어) 이동 주문 상태 (부대와 동일한 이동 지시 방식). */
  lordMoveTarget?: UnitMoveTarget | null;
  /** 영주 이동 주문 등록. */
  onLordMoveOrder?: (target: UnitMoveTarget) => void;
  /** 영주 이동 중지. */
  onLordMoveStop?: () => void;
  /** 영주 시작 위치 지정 (위치 미확인 시 지도 중앙을 기점으로 삼는다). */
  onLordSetBase?: (pos: { lat: number; lon: number }) => void;
  /** 영토전 시작 위치 (시작지점 버튼용). */
  territoryStart?: { lat: number; lon: number; sido: string; sigungu: string; dong: string } | null;
  /** 내가 주인인 성 키 (성 메뉴 "나의 성" 목록용). */
  ownedCastleKeys?: string[];
  /** 성 키 → 이름 (목록 표시용). */
  castleNames?: Record<string, string>;
  /** 마커 다이얼로그가 열려 있으면 하단 기능 UI를 숨긴다 (상태는 유지). */
  markerDialogOpen: boolean;
  /** 영주 선택 상태 변경 알림 (플레이어 마커 선택 테두리용). */
  onLordSelectedChange?: (selected: boolean) => void;
}

interface UnitInfo {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: "training" | "field" | "garrisoned" | "dead";
  castleKey: string | null;
  reviveAt: number | null;
  trainingCompleteAt?: number | null;
  moveTarget?: {
    lat: number;
    lon: number;
    startedAt: number;
    endsAt: number;
    fromLat?: number;
    fromLon?: number;
    via?: Array<{ lat: number; lon: number }> | null;
    path?: Array<{ lat: number; lon: number }> | null;
  } | null;
}

interface TrainingCastle {
  castleKey: string;
  kind: string;
  name: string;
}

interface CastleMember {
  userId: string;
  nickname: string;
  classId: string | null;
  isOwner: boolean;
}

interface PoolItem {
  id: string;
  description: string;
  uri: string;
}

export interface CastleBuildDraft {
  name: string;
  kind: "lord" | "noble";
  poolId: string;
  hp: number;
  dong: string;
}

function SearchableDropdown(props: {
  label: string;
  items: PoolItem[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  loading: boolean;
  emptyText: string;
}) {
  const { label, items, value, onChange, placeholder, loading, emptyText } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find((item) => item.id === value) ?? null;
  const filtered = query.trim()
    ? items.filter((item) =>
        item.description.toLowerCase().includes(query.trim().toLowerCase())
      )
    : items;
  return (
    <div>
      <p className="mb-1.5 text-xs font-black tracking-widest text-slate-500">{label}</p>
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-[14px] border px-3 py-1 text-left ${
          selected ? "border-[#a77b35] bg-[#e7ddc6]" : "border-[#8e7954]/50 bg-[#fffaf0]"
        }`}
      >
        <span className={`truncate text-sm font-black ${selected ? "text-slate-900" : "text-slate-400"}`}>
          {selected ? selected.description : loading ? "불러오는 중…" : placeholder}
        </span>
        <span className="shrink-0 text-xs text-slate-400">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="닫기"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[1250] cursor-default bg-transparent"
          />
          <div className="relative z-[1260]">
            <div className="absolute inset-x-0 top-1 max-h-56 overflow-hidden rounded-xl border border-[#8e7954]/50 bg-[#fffaf0]">
              <div className="bg-[#e7ddc6] p-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="검색…"
                  className={inputStyle}
                />
              </div>
              <ul className="max-h-40 overflow-y-auto overflow-x-hidden p-1.5">
                {filtered.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-slate-500">{emptyText}</li>
                ) : (
                  filtered.slice(0, 100).map((item) => (
                    <li key={item.id} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => {
                          onChange(item.id);
                          setOpen(false);
                        }}
                        className={`block w-full truncate rounded-lg px-3 py-1.5 text-left text-sm font-bold active:bg-slate-100 ${
                          item.id === value
                             ? "bg-[#e7ddc6] text-[#263b31]"
                            : "text-slate-700"
                        }`}
                      >
                        {item.id === value ? "선택 · " : ""}
                        {item.description}
                      </button>
                    </li>
                  ))
                )}
              </ul>
              {filtered.length > 100 ? (
                <p className="bg-[#e7ddc6] px-3 py-1.5 text-[11px] text-slate-600">
                  상위 100개만 표시됩니다. 검색어를 입력하세요.
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface CastleDetail {  castleKey: string;
  name: string;
  lat: number;
  lon: number;
  kind: "lord" | "noble";
  hp: number;
  maxHp: number;
  owner: string | null;
  status: string;
  garrison: number;
  joinMode: "auto" | "manual";
  difficulty: [number, number];
  members: CastleMember[];
  capacity: number;
  isOwner: boolean;
  myMemberCastle: string | null;
  myPending: boolean;
  myClass: string;
  cooldownSec: number;
}

type Sheet = null | "castles" | "units" | "move" | "build" | "manage";

/** 부대 목록에 표시되는 영주(플레이어) 가상 ID. 서버 부대가 아니라 이동 지시용이다. */
export const LORD_UNIT_ID = "__lord__";

const CODE_MESSAGE: Record<string, string> = {
  login: "로그인이 필요합니다.",
  territory_disabled: "지원하지 않는 미션입니다.",
  accuracy: "GPS 정확도가 낮습니다. 실외로 이동하세요.",
  invalid_coordinates: "GPS 위치를 확인할 수 없습니다.",
  stale_location: "최근 GPS 기록이 없습니다. 위치를 켜고 잠시 걸어주세요.",
  training_active: "이미 부대를 훈련 중입니다.",
  training_failed: "부대 훈련을 시작하지 못했습니다.",
  training_castle_required: "훈련할 보유 성을 선택해 주세요.",
  training_castle_not_owned: "직접 보유한 성에서만 부대를 훈련할 수 있습니다.",
  training_castle_unavailable: "현재 훈련할 수 없는 성입니다. 활성화된 보유 성을 선택해 주세요.",
  funds: "영향력이 부족합니다.",
  limit: "축성 상한을 초과했습니다.",
  distance: "성과의 간격 조건을 만족하지 않습니다.",
  no_lord: "영주성이 없어 귀족성을 지을 수 없습니다.",
  class_ineligible: "평민 이상부터 부대를 훈련할 수 있습니다.",
  capacity: "정원이 가득 찼습니다.",
  out_of_range: "너무 멉니다. 가까이 이동하세요.",
  stale_order: "이동 중 상태가 바뀌었습니다. 다시 시도하세요.",
  order_failed: "주문 등록에 실패했습니다. 다시 시도하세요.",
  already_member: "이미 소속된 성이 있습니다.",
  join_pending: "승인 대기 중입니다.",
  transfer_cooldown: "이적 쿨다운 중입니다.",
  cooldown: "공성 쿨다운 중입니다.",
  daily_cap: "오늘의 공성 상한을 썼습니다.",
  recall: "파견 반경을 벗어났습니다. 자동 귀환했습니다.",
  recall_dest: "목적지가 파견 반경(3km)을 벗어났습니다. 가까운 목적지를 선택해 주세요.",
  too_fast: "너무 빠릅니다. 천천히 이동하세요.",
  unit_full: "부대 상한입니다.",
  unit_dead: "사망한 부대입니다.",
  unit_garrisoned: "주둔 중입니다. 해제 후 조작하세요.",
  castle_not_found: "성을 찾을 수 없습니다.",
  castle_pending: "승인 대기 중인 성입니다.",
  own_castle: "자기 성은 공격할 수 없습니다.",
  not_owner: "성 주인만 가능합니다.",
  not_member: "소속원이 아닙니다.",
  checkin_required: "이번 주 GPS 체크인이 필요합니다.",
};

async function callApi<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok || !payload || (payload as { ok?: unknown }).ok !== true) {
    const code =
      payload && typeof (payload as { code?: unknown }).code === "string"
        ? (payload as { code: string }).code
        : `http_${res.status}`;
    throw new Error(code);
  }
  return payload as T;
}

const messageOf = (error: unknown): string => {
  const code = error instanceof Error ? error.message : "";
  if (code in CODE_MESSAGE) {
    return CODE_MESSAGE[code] as string;
  }
  // 서버 상태 코드 뭉개기 금지 — 다음 원인 특정용으로 노출한다.
  if (/^http_\d+$/.test(code)) {
    return `서버 오류(${code.slice(5)})가 발생했습니다. 다시 시도하세요.`;
  }
  return CODE_MESSAGE[code] ?? "실패했습니다. 다시 시도하세요.";
};

const sheetStyle =
  "fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-[1200] mx-auto max-h-[min(64dvh,620px)] w-auto max-w-xl overflow-y-auto rounded-[20px] border border-[#a77b35]/75 bg-[#f2ead8] p-2 text-[#202821]";

const buttonPrimary =
  "min-h-[33px] rounded-xl bg-[#263b31] px-4 py-1 text-sm font-black tracking-wide text-[#fff4d8] active:translate-y-0.5 active:bg-[#344a3d] disabled:opacity-40";
const buttonGhost =
  "min-h-[33px] rounded-xl border border-[#8e7954]/55 bg-[#e5dac3] px-3 py-1 text-sm font-black tracking-wide text-[#26352d] active:translate-y-0.5 active:bg-[#d9c9a8] disabled:opacity-40";
const buttonOriginal =
  "min-h-[33px] rounded-[16px] border border-slate-300 bg-white px-4 py-1 text-sm font-black tracking-wide text-slate-700 active:translate-y-0.5 disabled:opacity-40";
const inputStyle =
  "min-h-[33px] w-full rounded-xl border border-[#8e7954]/50 bg-[#fffaf0] px-3 py-1 text-sm font-bold text-[#202821] outline-none focus:border-[#a77b35]";

type TerritoryActionIconName = "castle" | "unit" | "build" | "harvest";

function TerritoryActionIcon({ name }: { name: TerritoryActionIconName }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
    >
      {name === "castle" ? (
        <>
          <path d="M3 21h18M5 21V8h4V5h3v5h3V7h4v14" />
          <path d="M8 13h1m3 0h1m3 0h1M8 17h1m3 0h1m3 0h1M10 5V3h4v2" />
        </>
      ) : name === "unit" ? (
        <>
          <path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z" />
          <circle cx="12" cy="9" r="2" />
          <path d="M8.5 16c.6-1.8 1.8-2.7 3.5-2.7s2.9.9 3.5 2.7" />
        </>
      ) : name === "build" ? (
        <>
          <path d="m14 6 4 4M4 20l9.5-9.5M11 5l2-2 6 6-2 2M3 21h8" />
          <path d="M15 13v8m-4-4h8" />
        </>
      ) : (
        <>
          <path d="M12 21V4m0 4c-3 0-5-1.5-5-4 3 0 5 1.5 5 4Zm0 4c3 0 5-1.5 5-4-3 0-5 1.5-5 4Zm0 4c-3 0-5-1.5-5-4 3 0 5 1.5 5 4Zm0 4c3 0 5-1.5 5-4-3 0-5 1.5-5 4Z" />
        </>
      )}
    </svg>
  );
}

export default function TerritoryUI(props: TerritoryUIProps) {
  const {
    castleKey,
    onCloseCastle,
    onOpenCastle,
    onUnitMarks,
    unitMarkerSelection,
    onUnitMarkerSelectionHandled,
    getMapCenter,
    onMoveTargetCenter,
    onMovePath,
    onMoveDestination,
    panToLocation,
    isLocationVisible,
  } = props;
  // 이동 경로·목적지 표시는 부대별로 유지한다. 지도에는 한 부대분만 표시되며,
  // 다른 부대가 끝나도 표시 중인 부대의 것은 지우지 않는다.
  const routeCacheRef = useRef(
    new Map<string, { path: Array<{ lat: number; lon: number }> | null; dest: { lat: number; lon: number } | null }>(),
  );
  const displayedRouteOwnerRef = useRef<string | null>(null);
  const cacheRoute = useCallback(
    (
      unitId: string,
      path: Array<{ lat: number; lon: number }> | null,
      dest: { lat: number; lon: number } | null,
    ): void => {
      routeCacheRef.current.set(unitId, { path, dest });
    },
    [],
  );
  const publishRoute = useCallback(
    (unitId: string): void => {
      const cached = routeCacheRef.current.get(unitId);
      if (!cached) {
        return;
      }
      displayedRouteOwnerRef.current = unitId;
      onMovePath(cached.path ? [...cached.path] : null);
      onMoveDestination(cached.dest ? { ...cached.dest } : null);
    },
    [onMovePath, onMoveDestination],
  );
  const publishRouteLive = useCallback(
    (
      unitId: string,
      path: Array<{ lat: number; lon: number }>,
      dest: { lat: number; lon: number },
      force = false,
    ): void => {
      cacheRoute(unitId, [...path], { ...dest });
      const owner = displayedRouteOwnerRef.current;
      // 다른 부대 표시를 가로채지 않는다 (선택 시 해당 부대 것으로 복원된다).
      // 단, 사용자가 직접 이동을 명령한 부대는 즉시 표시한다.
      if (!force && owner !== null && owner !== unitId && movingUnitIdsRef.current.has(owner)) {
        return;
      }
      displayedRouteOwnerRef.current = unitId;
      onMovePath([...path]);
      onMoveDestination({ ...dest });
    },
    [cacheRoute, onMovePath, onMoveDestination],
  );
  const clearRoute = useCallback(
    (unitId: string): void => {
      routeCacheRef.current.delete(unitId);
      if (displayedRouteOwnerRef.current === unitId) {
        displayedRouteOwnerRef.current = null;
        onMovePath(null);
        onMoveDestination(null);
      }
    },
    [onMovePath, onMoveDestination],
  );
  const [sheet, setSheet] = useState<Sheet>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  const [actionDialog, setActionDialog] = useState<{ title: string; message: string } | null>(null);
  const [scoutResult, setScoutResult] = useState<{
    unitName: string;
    castles: { castleKey: string; name: string; distance: number; mine: boolean }[];
  } | null>(null);
  const [units, setUnits] = useState<UnitInfo[]>([]);
  const [unitCap, setUnitCap] = useState(0);
  const [unitTrainingName, setUnitTrainingName] = useState("");
  const [trainingCastles, setTrainingCastles] = useState<TrainingCastle[]>([]);
  const [selectedTrainingCastle, setSelectedTrainingCastle] = useState("");
  const [trainingCastlesLoading, setTrainingCastlesLoading] = useState(true);
  const [trainingCastlesError, setTrainingCastlesError] = useState(false);
  const [trainingNow, setTrainingNow] = useState<number | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  // 이동 다이얼로그가 열려 있는 동안 1초마다 부대 화면 이탈 여부를 갱신한다.
  const [unitOffscreenTick, setUnitOffscreenTick] = useState(0);
  useEffect(() => {
    if (sheet !== "move" || !selectedUnit) {
      return;
    }
    const timerId = window.setInterval(() => {
      setUnitOffscreenTick((tick) => tick + 1);
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [sheet, selectedUnit]);
  const [otherUnitMarks, setOtherUnitMarks] = useState<
    Array<{ id: string; name: string; lat: number; lon: number; mine: false; moving: boolean; selected: false; moveTarget: { fromLat: number; fromLon: number; lat: number; lon: number; startedAt: number; endsAt: number; via: Array<{ lat: number; lon: number }> | null } | null }>
  >([]);
  const [movingUnitIds, setMovingUnitIds] = useState<string[]>([]);
  const resumedMoveIdsRef = useRef<Set<string>>(new Set());
  const resumeUnitMovementRef = useRef<(unit: UnitInfo) => Promise<void>>(
    async () => {},
  );
  // refreshUnits를 units/movingUnitIds에 의존시키면 콜백 identity가 바뀌어
  // 마운트 effect가 반복 실행되는 순환이 생기므로 ref로 최신값을 참조한다.
  const unitsRef = useRef<UnitInfo[]>([]);
  const movingUnitIdsRef = useRef<Set<string>>(new Set());
  const selectedUnitRef = useRef<string | null>(null);
  const moveSheetOpenRef = useRef(false);
  useEffect(() => {
    unitsRef.current = units;
  }, [units]);
  useEffect(() => {
    selectedUnitRef.current = selectedUnit;
  }, [selectedUnit]);
  useEffect(() => {
    moveSheetOpenRef.current = sheet === "move" && selectedUnit !== null;
    props.onLordSelectedChange?.(sheet === "move" && selectedUnit === LORD_UNIT_ID);
  }, [sheet, selectedUnit]);
  // 선택 테두리는 해당 부대의 이동 다이얼로그가 열린 동안에만 표시한다.
  const isDialogSelected = useCallback(
    (unitId: string): boolean =>
      selectedUnitRef.current === unitId && moveSheetOpenRef.current,
    [],
  );
  const addMovingUnit = useCallback((unitId: string): void => {
    movingUnitIdsRef.current.add(unitId);
    setMovingUnitIds([...movingUnitIdsRef.current]);
  }, []);
  const removeMovingUnit = useCallback((unitId: string): void => {
    movingUnitIdsRef.current.delete(unitId);
    setMovingUnitIds([...movingUnitIdsRef.current]);
  }, []);
  const [moveProgressMap, setMoveProgressMap] = useState<
    Record<
      string,
      {
        startedAt: number;
        durationMs: number;
        destLat: number;
        destLon: number;
        // 장거리 청크 행군 표시용 (현재 구간 라벨 + 최종 목적지).
        legLabel?: string;
        finalLat?: number;
        finalLon?: number;
      }
    >
  >({});
  const [findingPathUnitId, setFindingPathUnitId] = useState<string | null>(null);
  // 길찾기 진행률 (다리 단위 — 장거리에서 멈춘 것처럼 보이지 않게).
  const [findingProgress, setFindingProgress] = useState<{ done: number; total: number } | null>(null);
  // 사용자가 이동중지를 눌렀는지 (조용한 중단 vs 오류 메시지 구분용).
  const stopRequestedRef = useRef<Set<string>>(new Set());
  // 길찾기 전체 시간 예산 (초과 시 풀린 앞부분까지만 부분 행군한다).
  const ROUTE_BUDGET_MS = 25000;
  // 다구간 이동의 전체 소요시간 추정치 (구간 확정마다 정교화, 동기화 시 서버에 전달).
  // 단일 체인 구간 길이 상한 (m). 초과분은 다음 구간으로 넘긴다.
  const CHAIN_LEG_M = 5000;
  const [moveNow, setMoveNow] = useState<number | null>(null);
  const [detail, setDetail] = useState<CastleDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [buildName, setBuildName] = useState("");
  const [buildKind, setBuildKind] = useState<"lord" | "noble">("noble");
  const [buildPoolId, setBuildPoolId] = useState<string | null>(null);
  const [quizPools, setQuizPools] = useState<PoolItem[]>([]);
  const [webEvents, setWebEvents] = useState<PoolItem[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [buildHp, setBuildHp] = useState(2);
  const [myClass, setMyClass] = useState<string | null>(null);
  const [manageDiff, setManageDiff] = useState<[number, number]>([1, 3]);
  const [manageJoinMode, setManageJoinMode] = useState<"auto" | "manual">("auto");
  const [pendingList, setPendingList] = useState<
    { userId: string; nickname: string; requestedAt: number }[]
  >([]);
  const [appointTarget, setAppointTarget] = useState("");
  const [duelBattle, setDuelBattle] = useState<{ id: string; preview: string } | null>(null);
  const lastMoveRef = useRef(0);
  const hasUnitTraining = units.some((unit) => unit.state === "training");
  const trainingUnit = units.find((unit) => unit.state === "training") ?? null;

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
    }, 4000);
  }, []);

  useEffect(() => {
    if (props.placementNotice) {
      flash(props.placementNotice.message);
    }
  }, [props.placementNotice, flash]);

  const refreshUnits = useCallback(async () => {
    try {
      const [own, others] = await Promise.all([
        callApi<{
          cap: number;
          units: UnitInfo[];
        }>("/api/units") as Promise<{ cap: unknown; units: unknown }>,
        callApi<{ units?: unknown }>("/api/units/visible").catch(() => null),
      ]);
      const data = own as { cap: unknown; units: unknown };
      setUnitCap(typeof data.cap === "number" ? data.cap : 0);
      const nextUnits = Array.isArray(data.units) ? (data.units as UnitInfo[]) : [];
      const movingIds = movingUnitIdsRef.current;
      // 이동 애니메이션 중인 부대는 서버 스냅샷으로 로컬 위치를 덮어쓰지 않는다.
      if (movingIds.size === 0) {
        setUnits(nextUnits);
        unitsRef.current = nextUnits;
      } else {
        const serverById = new Map(nextUnits.map((unit) => [unit.id, unit]));
        const merged = unitsRef.current.map((unit) =>
          movingIds.has(unit.id) ? unit : (serverById.get(unit.id) ?? unit),
        );
        for (const unit of nextUnits) {
          if (!merged.some((existing) => existing.id === unit.id)) {
            merged.push(unit);
          }
        }
        setUnits(merged);
        unitsRef.current = merged;
      }
      setTrainingNow(nextUnits.some((unit) => unit.state === "training") ? Date.now() : null);
      // 새로고침 후에도 진행 중 이동이 있으면 이어받는다 (서버 도착시각 기준).
      if (movingUnitIdsRef.current.size === 0) {
        const activeIds = new Set<string>();
        for (const unit of nextUnits) {
          if (unit.moveTarget && unit.moveTarget.endsAt > Date.now()) {
            activeIds.add(unit.id);
          }
        }
        for (const id of [...resumedMoveIdsRef.current]) {
          if (!activeIds.has(id)) {
            resumedMoveIdsRef.current.delete(id);
          }
        }
        const resumables = nextUnits.filter(
          (unit) =>
            unit.state === "field" &&
            unit.moveTarget &&
            unit.moveTarget.endsAt > Date.now() &&
            !resumedMoveIdsRef.current.has(unit.id),
        );
        for (const resumable of resumables) {
          void resumeUnitMovementRef.current(resumable);
        }
      }
      const otherRows = others && Array.isArray(others.units) ? (others.units as Record<string, unknown>[]) : [];
      const otherMarks = otherRows
        .filter(
          (row) =>
            typeof row.id === "string" &&
            typeof row.name === "string" &&
            typeof row.lat === "number" &&
            typeof row.lon === "number" &&
            Number.isFinite(row.lat) &&
            Number.isFinite(row.lon),
        )
        .map((row) => {
          const rawTarget = row.moveTarget as Record<string, unknown> | null | undefined;
        const rawVia = Array.isArray(rawTarget?.via) ? rawTarget.via : null;
          const via = rawVia
            ? (
                rawVia.filter(
                  (point: unknown): point is { lat: number; lon: number } =>
                    typeof point === "object" &&
                    point !== null &&
                    typeof (point as { lat?: unknown }).lat === "number" &&
                    typeof (point as { lon?: unknown }).lon === "number",
                ) as Array<{ lat: number; lon: number }>
              ).slice(0, 200)
            : null;
          const rawPath = Array.isArray(rawTarget?.path) ? rawTarget.path : null;
          const path = rawPath
            ? (
                rawPath.filter(
                  (point: unknown): point is { lat: number; lon: number } =>
                    typeof point === "object" &&
                    point !== null &&
                    typeof (point as { lat?: unknown }).lat === "number" &&
                    typeof (point as { lon?: unknown }).lon === "number",
                ) as Array<{ lat: number; lon: number }>
              ).slice(0, 2000)
            : null;
          const moveTarget =
            rawTarget &&
            typeof rawTarget.fromLat === "number" &&
            typeof rawTarget.fromLon === "number" &&
            typeof rawTarget.lat === "number" &&
            typeof rawTarget.lon === "number" &&
            typeof rawTarget.startedAt === "number" &&
            typeof rawTarget.endsAt === "number"
              ? {
                  fromLat: rawTarget.fromLat,
                  fromLon: rawTarget.fromLon,
                  lat: rawTarget.lat,
                  lon: rawTarget.lon,
                  startedAt: rawTarget.startedAt,
                  endsAt: rawTarget.endsAt,
                  via,
                  path,
                }
              : null;
          return {
            id: row.id as string,
            name: row.name as string,
            lat: row.lat as number,
            lon: row.lon as number,
            mine: false as const,
            selected: false as const,
            moving: !!moveTarget && moveTarget.endsAt > Date.now(),
            moveTarget,
          };
        });
      setOtherUnitMarks(otherMarks);
      const ownSource = movingIds.size === 0 ? nextUnits : unitsRef.current;
      const ownMarks = ownSource
        .filter((unit) => unit.state === "field" || unit.state === "garrisoned")
        .map((unit) => ({
          id: unit.id,
          name: unit.name,
          lat: unit.lat,
          lon: unit.lon,
          mine: true as const,
          moving: movingIds.has(unit.id),
          selected: isDialogSelected(unit.id),
          moveTarget: null,
        }));
      onUnitMarks([...ownMarks, ...otherMarks, ...toNeutralMarks(neutralUnitsRef.current)]);
    } catch {
      // 조회 실패 시 기존 목록 유지
    }
  }, [isDialogSelected, onUnitMarks]);

  interface NeutralUnitRow {
    id: number;
    lat: number;
    lon: number;
    fromLat: number;
    fromLon: number;
    destLat: number;
    destLon: number;
    startedAt: number;
    endsAt: number;
    moving: boolean;
    quizKey: string;
    quizTitle: string;
    path?: Array<{ lat: number; lon: number }> | null;
  }
  const [neutralUnits, setNeutralUnits] = useState<NeutralUnitRow[]>([]);
  const neutralUnitsRef = useRef<NeutralUnitRow[]>([]);
  const toNeutralMarks = (rows: NeutralUnitRow[]): Parameters<TerritoryUIProps["onUnitMarks"]>[0] =>
    rows.map((row) => ({
      id: `neutral-${row.id}`,
      name: "무법자",
      lat: row.lat,
      lon: row.lon,
      mine: false as const,
      moving: row.moving,
      selected: false as const,
      quizTitle: row.quizTitle || undefined,
      moveTarget: {
        fromLat: row.fromLat,
        fromLon: row.fromLon,
        lat: row.destLat,
        lon: row.destLon,
        startedAt: row.startedAt,
        endsAt: row.endsAt,
        via: null,
        path: row.path && row.path.length >= 2 ? row.path : null,
      },
    }));
  const refreshNeutralUnits = useCallback(async () => {
    try {
      const loc = props.getPlayerLocation();
      const seeds = (props.wildSeeds ?? []).filter(
        (s) => s && typeof s.dong === "string" && s.dong.length > 0 && Number.isFinite(s.lat) && Number.isFinite(s.lon),
      );
      let data: { units?: unknown };
      if (seeds.length > 0) {
        // 화면 내 복수 동 일괄 조회 (보이는 모든 동의 방랑부대 표시).
        data = await callApi<{ units?: unknown }>("/api/neutral-units", { seeds });
      } else {
        const dong = props.playerDongCode ?? props.dongCode;
        if (!dong || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
          return;
        }
        data = await callApi<{ units?: unknown }>(
          `/api/neutral-units?dong=${encodeURIComponent(dong)}&lat=${loc.lat}&lon=${loc.lon}`,
        );
      }
      const rows = (Array.isArray(data.units) ? data.units : []).flatMap((u): NeutralUnitRow[] => {
        if (typeof u !== "object" || u === null) {
          return [];
        }
        const r = u as Record<string, unknown>;
        if (
          typeof r.id !== "number" ||
          typeof r.lat !== "number" ||
          typeof r.lon !== "number" ||
          typeof r.fromLat !== "number" ||
          typeof r.fromLon !== "number" ||
          typeof r.destLat !== "number" ||
          typeof r.destLon !== "number" ||
          typeof r.startedAt !== "number" ||
          typeof r.endsAt !== "number"
        ) {
          return [];
        }
        const rawPath = (r as Record<string, unknown>).path;
        const path = Array.isArray(rawPath)
          ? (rawPath as unknown[]).flatMap((pt): Array<{ lat: number; lon: number }> => {
              if (typeof pt !== "object" || pt === null) {
                return [];
              }
              const { lat, lon } = pt as { lat?: unknown; lon?: unknown };
              return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon)
                ? [{ lat, lon }]
                : [];
            })
          : null;
        return [
          {
            id: r.id,
            lat: r.lat,
            lon: r.lon,
            fromLat: r.fromLat,
            fromLon: r.fromLon,
            destLat: r.destLat,
            destLon: r.destLon,
            startedAt: r.startedAt,
            endsAt: r.endsAt,
            moving: r.moving === true,
            quizKey: typeof r.quizKey === "string" ? r.quizKey : "",
            quizTitle: typeof r.quizTitle === "string" ? r.quizTitle : "",
            path,
          },
        ];
      });
      neutralUnitsRef.current = rows;
      setNeutralUnits(rows);
      try {
        if (window.sessionStorage.getItem("map-perf-enabled") === "1") {
          // eslint-disable-next-line no-console
          console.log(`[perf] neutral fetch seeds=${seeds.length} got=${rows.length}`);
        }
      } catch {}
    } catch {
      // 조회 실패 시 기존 목록 유지
    }
  }, [props.wildSeeds, props.playerDongCode, props.dongCode, props.getPlayerLocation]);

  const refreshTrainingCastles = useCallback(async () => {
    setTrainingCastlesLoading(true);
    try {
      const data = await callApi<{ castles?: unknown }>("/api/castles/list");
      const rows = Array.isArray(data.castles) ? (data.castles as Record<string, unknown>[]) : [];
      const next = rows
        .filter(
          (row) =>
            row.availableForTraining === true &&
            typeof row.castleKey === "string" &&
            typeof row.kind === "string" &&
            typeof row.name === "string",
        )
        .map((row) => ({
          castleKey: row.castleKey as string,
          kind: row.kind as string,
          name: row.name as string,
        }));
      setTrainingCastles(next);
      setSelectedTrainingCastle((current) =>
        next.some((castle) => castle.castleKey === current)
          ? current
          : next[0]?.castleKey ?? "",
      );
      setTrainingCastlesError(false);
    } catch {
      setTrainingCastlesError(true);
    } finally {
      setTrainingCastlesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUnits();
    void refreshTrainingCastles();
    setPoolsLoading(true);
    let cancelled = false;
    void fetch("/api/territory/pools")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") {
          return;
        }
        const payload = data as {
          quizPools?: unknown;
          webEvents?: unknown;
        };
        const toItems = (value: unknown): PoolItem[] => {
          if (!Array.isArray(value)) {
            return [];
          }
          return (value as Record<string, unknown>[])
            .filter(
              (row) =>
                typeof row.id === "string" &&
                typeof row.description === "string" &&
                typeof row.uri === "string"
            )
            .map((row) => ({
              id: row.id as string,
              description: row.description as string,
              uri: row.uri as string,
            }));
        };
        if (!cancelled) {
          setQuizPools(toItems(payload.quizPools));
          setWebEvents(toItems(payload.webEvents));
          setPoolsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPoolsLoading(false);
        }
      });
    void fetch("/api/territory/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") {
          return;
        }
        const klass = (data as { class?: unknown }).class;
        if (typeof klass === "string") {
          setMyClass(klass);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshUnits, refreshTrainingCastles]);

  useEffect(() => {
    // DB 커넥션 고갈(1040) 방지: 폴링은 15초 간격으로 제한한다.
    const timerId = window.setInterval(() => {
      void refreshUnits();
    }, 15_000);
    return () => window.clearInterval(timerId);
  }, [refreshUnits]);

  useEffect(() => {
    if (!hasUnitTraining) {
      return;
    }
    const timerId = window.setInterval(() => {
      void refreshUnits();
    }, 15_000);
    return () => window.clearInterval(timerId);
  }, [hasUnitTraining, refreshUnits]);

  useEffect(() => {
    // 중립 부대 폴링 (선택 동 기준, 15초). 스폰·배회는 서버가 lazy 처리한다.
    void refreshNeutralUnits();
    const timerId = window.setInterval(() => {
      void refreshNeutralUnits();
    }, 15_000);
    return () => window.clearInterval(timerId);
  }, [refreshNeutralUnits]);

  useEffect(() => {
    if (movingUnitIds.length === 0) {
      return;
    }
    const timerId = window.setInterval(() => {
      setMoveNow(Date.now());
    }, 500);
    return () => window.clearInterval(timerId);
  }, [movingUnitIds]);

  useEffect(() => {
    if (!hasUnitTraining) {
      return;
    }
    const timerId = window.setInterval(() => {
      setTrainingNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [hasUnitTraining]);

  const CLASS_ORDER: Record<string, number> = {
    slave: 0,
    commoner: 1,
    knight: 2,
    noble: 3,
    lord: 4,
  };
  // 서버 규칙과 동일: 귀족성은 귀족 이상, 영주성은 평민 이상(창시 가능).
  // 계급 미확인(로딩 중) 상태에서는 막지 않고 서버가 최종 검증한다.
  const canBuildNoble = myClass === null || myClass === "noble" || myClass === "lord";
  const canBuildLord = myClass === null || (CLASS_ORDER[myClass] ?? -1) >= 1;

  useEffect(() => {
    if (myClass === null) {
      return;
    }
    if (buildKind === "noble" && !canBuildNoble && canBuildLord) {
      setBuildKind("lord");
    } else if (buildKind === "lord" && !canBuildLord && canBuildNoble) {
      setBuildKind("noble");
    }
  }, [myClass, buildKind, canBuildNoble, canBuildLord]);

  // 이동 버튼을 누른 시점에만 목적지 주변 이동가능영역을 표시한다 (재병합 1회).
  // 다이얼로그가 닫히면 표시를 해제한다.
  useEffect(() => {
    if (sheet !== "move") {
      onMoveTargetCenter(null);
    }
  }, [sheet, onMoveTargetCenter]);

  // 이동 애니메이션 중 60fps setUnits가 지도 마커 전체를 매 프레임 재설정하면
  // 깜빡임이 생기므로 마커 전달은 200ms로 스로틀한다.
  const lastMarksEmitRef = useRef(0);
  const pendingMarksEmitRef = useRef<number | null>(null);
  useEffect(() => {
    const emit = (): void => {
      pendingMarksEmitRef.current = null;
      lastMarksEmitRef.current = Date.now();
      onUnitMarks([
        ...units
          .filter((s) => s.state === "field" || s.state === "garrisoned")
          .map((s) => ({
            id: s.id,
            name: s.name,
            lat: s.lat,
            lon: s.lon,
            mine: true as const,
            moving: movingUnitIds.includes(s.id),
            selected: s.id === selectedUnit && sheet === "move",
            moveTarget: null,
          })),
        ...otherUnitMarks,
        ...toNeutralMarks(neutralUnitsRef.current),
      ]);
    };
    const elapsed = Date.now() - lastMarksEmitRef.current;
    if (elapsed >= 200) {
      if (pendingMarksEmitRef.current !== null) {
        window.clearTimeout(pendingMarksEmitRef.current);
        pendingMarksEmitRef.current = null;
      }
      emit();
      return;
    }
    if (pendingMarksEmitRef.current !== null) {
      window.clearTimeout(pendingMarksEmitRef.current);
    }
    pendingMarksEmitRef.current = window.setTimeout(emit, 200 - elapsed);
    return () => {
      if (pendingMarksEmitRef.current !== null) {
        window.clearTimeout(pendingMarksEmitRef.current);
        pendingMarksEmitRef.current = null;
      }
    };
  }, [units, otherUnitMarks, neutralUnits, movingUnitIds, selectedUnit, sheet, onUnitMarks]);

  // 마지막 선택 우선: 성이 새로 열리면 시트를 닫는다 (상태는 유지).
  const prevCastleKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (castleKey && castleKey !== prevCastleKeyRef.current) {
      setSheet(null);
    }
    prevCastleKeyRef.current = castleKey;
  }, [castleKey]);

  const refreshDetail = useCallback(
    async (key: string) => {
      setDetailLoading(true);
      try {
        const data = await callApi<CastleDetail>(
          `/api/castles?castleKey=${encodeURIComponent(key)}`,
        );
        setDetail(data);
        setManageDiff(data.difficulty);
        setManageJoinMode(data.joinMode);
      } catch (error) {
        flash(messageOf(error));
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [flash],
  );

  useEffect(() => {
    if (castleKey) {
      void refreshDetail(castleKey);
      setSheet(null);
    } else {
      setDetail(null);
    }
  }, [castleKey, refreshDetail]);

  // 성 다이얼로그가 열리면 지도 중앙을 해당 성으로 이동시킨다 (열릴 때 1회만).
  const pannedCastleKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!castleKey) {
      pannedCastleKeyRef.current = null;
      return;
    }
    if (detail && pannedCastleKeyRef.current !== castleKey) {
      pannedCastleKeyRef.current = castleKey;
      panToLocation(detail.lat, detail.lon);
    }
  }, [castleKey, detail, panToLocation]);

  const runAction = useCallback(
    async (fn: () => Promise<string | null>) => {
      if (busy) {
        setActionDialog({
          title: "요청을 처리할 수 없습니다",
          message: "다른 작업을 처리 중입니다. 잠시 후 다시 시도해 주세요.",
        });
        return;
      }
      setBusy(true);
      try {
        const message = await fn();
        if (message) {
          flash(message);
        }
      } catch (error) {
        setActionDialog({ title: "요청을 처리할 수 없습니다", message: messageOf(error) });
      } finally {
        setBusy(false);
      }
    },
    [busy, flash],
  );

  const playerLoc = props.getPlayerLocation();
  // 성 다이얼로그 거리 게이트 (서버 규칙과 동일: 입성 100m·결투 500m).
  // 수확/관리는 주인 원격 허용이라 제한 없음.
  const castleDistM =
    playerLoc && detail && Number.isFinite(detail.lat) && Number.isFinite(detail.lon)
      ? (() => {
          const rad = Math.PI / 180;
          const dLat = (detail.lat - playerLoc.lat) * rad;
          const dLon = (detail.lon - playerLoc.lon) * rad;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(playerLoc.lat * rad) *
              Math.cos(detail.lat * rad) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);
          return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
        })()
      : null;
  const canJoinHere = castleDistM !== null && castleDistM <= 100;
  const canDuelHere = castleDistM !== null && castleDistM <= 500;

  const doJoin = (transfer: boolean): Promise<void> =>
    runAction(async () => {
      if (!castleKey || !playerLoc) {
        throw new Error("stale_location");
      }
      const data = (await callApi<{ pending?: unknown }>("/api/castles/join", {
        castleKey,
        lat: playerLoc.lat,
        lon: playerLoc.lon,
        transfer,
      })) as { pending?: unknown };
      await refreshDetail(castleKey);
      await refreshUnits();
      return data.pending === true ? "승인 요청을 보냈습니다." : "입성했습니다.";
    });

  const doHarvest = (key?: string): Promise<void> =>
    runAction(async () => {
      const data = (await callApi<{
        harvested: { castleKey: string; yield: number }[];
        skipped: string[];
      }>("/api/territory/harvest", key ? { castleKey: key } : {})) as {
        harvested: { castleKey: string; yield: number }[];
      };
      const total = data.harvested.reduce((sum, h) => sum + h.yield, 0);
      if (castleKey) {
        await refreshDetail(castleKey);
      }
      return data.harvested.length > 0
        ? `수확 +${total} (성 ${data.harvested.length}곳)`
        : "수확할 성이 없습니다.";
    });

  const doUnitAct = (
    unitId: string,
    action: "move" | "scout" | "siege" | "defend" | "join",
    toLat: number,
    toLon: number,
  ): Promise<void> =>
    runAction(async () => {
      if (action === "move") {
        const now = Date.now();
        if (now - lastMoveRef.current < 3000) {
          return null;
        }
        lastMoveRef.current = now;
      }
      const data = (await callApi<Record<string, unknown>>("/api/units/act", {
        unitId,
        toLat,
        toLon,
        action,
        castleKey: castleKey ?? undefined,
      })) as Record<string, unknown>;
      await refreshUnits();
      if (action === "siege" && typeof data.hp === "number") {
        if (castleKey) {
          await refreshDetail(castleKey);
        }
        return data.conquered === true
          ? "함락! 성을 차지했습니다."
          : `적중! HP ${String(data.hp)}`;
      }
      if (action === "scout" && Array.isArray(data.castles)) {
        const castles = (data.castles as unknown[]).flatMap((c) => {
          if (typeof c !== "object" || c === null) {
            return [];
          }
          const row = c as Record<string, unknown>;
          if (typeof row.castleKey !== "string" || typeof row.name !== "string") {
            return [];
          }
          return [
            {
              castleKey: row.castleKey,
              name: row.name,
              distance: typeof row.distance === "number" ? row.distance : -1,
              mine: row.mine === true,
            },
          ];
        });
        const unitName = units.find((u) => u.id === unitId)?.name ?? "부대";
        setScoutResult({ unitName, castles });
        return null;
      }
      if (action === "defend") {
        return "수성 가담 완료 (+10)";
      }
      if (action === "join") {
        return data.pending === true ? "승인 요청을 보냈습니다." : "입성했습니다.";
      }
      return null;
    });

  const startUnitTraining = async (castleKeyArg?: string, castleNameArg?: string): Promise<void> => {
    const targetCastle = castleKeyArg ?? selectedTrainingCastle;
    if (!targetCastle) {
      setActionDialog({
        title: "훈련할 성을 선택해 주세요",
        message: "부대는 선택한 보유 성에서 훈련을 시작하고, 완성된 뒤 그곳에서 활동합니다.",
      });
      return;
    }
    setBusy(true);
    try {
      await callApi("/api/units/train", {
        name: unitTrainingName.trim() || "부대",
        castleKey: targetCastle,
      });
      setUnitTrainingName("");
      await refreshUnits();
      const castleName =
        castleNameArg ??
        trainingCastles.find((castle) => castle.castleKey === targetCastle)?.name;
      flash(`${castleName ?? "보유 성"}에서 부대 훈련을 시작했습니다. 30분 후 성에 배치됩니다.`);
    } catch (error) {
      setActionDialog({ title: "부대 훈련을 시작할 수 없습니다", message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const moveSelectedToCenter = (): void => {
    if (selectedUnit === LORD_UNIT_ID) {
      void moveLordToCenter();
      return;
    }
    const center = getMapCenter();
    const unit = units.find((item) => item.id === selectedUnit);
    if (!selectedUnit || !center || !unit) {
      flash("지도를 움직여 목적지를 가운데에 두세요.");
      return;
    }
    if (movingUnitIdsRef.current.has(selectedUnit)) {
      return;
    }
    // 스피너를 먼저 그리고, 무거운 재병합·탐색은 페인트 이후에 시작한다.
    void moveUnitGradually(selectedUnit, unit.lat, unit.lon, center.lat, center.lon, center);
  };

  const isLordSelected = selectedUnit === LORD_UNIT_ID;

  // useCallback이 아닌 일반 함수로 둔다 (호출 시점의 최신 props를 읽기 위해).
  const openLordMovement = (): void => {
    // 부대와 달리 플레이어는 위치가 없을 수 있다. 없으면 지도 중앙을 기점으로 삼는다.
    const playerPos = props.getPlayerLocation() ?? getMapCenter();
    if (!playerPos) {
      flash("플레이어 위치를 확인할 수 없습니다.");
      return;
    }
    props.onLordSetBase?.({ lat: playerPos.lat, lon: playerPos.lon });
    setSelectedUnit(LORD_UNIT_ID);
    panToLocation(playerPos.lat, playerPos.lon);
    setSheet("move");
  };

  const stopLordMovement = (): void => {
    clearRoute(LORD_UNIT_ID);
    props.onLordMoveStop?.();
  };

  // 영주 이동 주문 (부대와 동일한 방식: 목적지 스냅 → 경로 → 소요시간 → 주문 등록).
  // 서버 주문 없이 클라이언트 권위로 즉시 이동한다.
  // useCallback이 아닌 일반 함수로 둔다 (호출 시점의 최신 props를 읽기 위해).
  // 경로의 불필요한 왕복(루프)을 잘라낸다: 이전 점을 15m 안으로 되밟으면 그 구간을 제거한다.
  const removePathLoops = (pts: Array<{ lat: number; lon: number }>): Array<{ lat: number; lon: number }> => {
    const kxOf = (lat: number): number => 111320 * Math.cos((lat * Math.PI) / 180);
    const out: Array<{ lat: number; lon: number }> = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last) {
        const kx = kxOf(p.lat);
        if (Math.hypot((p.lon - last.lon) * kx, (p.lat - last.lat) * 110540) < 1) {
          continue;
        }
      }
      let cut = -1;
      for (let k = 0; k < out.length - 1; k += 1) {
        const q = out[k];
        if (!q) {
          continue;
        }
        const kx = kxOf(p.lat);
        if (Math.hypot((p.lon - q.lon) * kx, (p.lat - q.lat) * 110540) < 15) {
          cut = k;
          break;
        }
      }
      if (cut >= 0) {
        out.length = cut + 1;
      } else {
        out.push(p);
      }
    }
    return out;
  };
  const moveLordToCenter = async (): Promise<void> => {
    const center = getMapCenter();
    const from = props.getPlayerLocation() ?? getMapCenter();
    if (!center || !from) {
      flash("지도를 움직여 목적지를 가운데에 두세요.");
      return;
    }
    if (busy) {
      return;
    }
    setBusy(true);
    setFindingPathUnitId(LORD_UNIT_ID);
    onMovePath(null);
    onMoveDestination(center);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    try {
      ensureWalkableData(center.lat, center.lon);
      ensureWalkableData(from.lat, from.lon);
      // 출발지도 도로 위로 스냅한다 (GPS 오차·지도 중앙 지정 대비).
      const snappedFrom =
        (await snapToNearestWalkableLocation(from.lat, from.lon, 200)) ?? null;
      const startLat = snappedFrom?.lat ?? from.lat;
      const startLon = snappedFrom?.lon ?? from.lon;
      const snapped =
        (await snapToNearestWalkableLocation(center.lat, center.lon, 500)) ??
        (await snapToNearestWalkableLocation(center.lat, center.lon, 3000));
      if (snapped && (Math.abs(snapped.lat - center.lat) > 1e-9 || Math.abs(snapped.lon - center.lon) > 1e-9)) {
        const km = snapped.distanceM >= 1000
          ? `${(snapped.distanceM / 1000).toFixed(1)}km`
          : `${Math.round(snapped.distanceM)}m`;
        flash(`목적지가 길에서 벗어나 가장 가까운 길로 보정했습니다 (${km})`);
      }
      const toLat = snapped?.lat ?? center.lat;
      const toLon = snapped?.lon ?? center.lon;
      const kx = 111320 * Math.cos((startLat * Math.PI) / 180);
      const distM = Math.hypot((toLon - startLon) * kx, (toLat - startLat) * 110540);
      if (distM < 1) {
        props.onLordMoveOrder?.({
          fromLat: startLat,
          fromLon: startLon,
          lat: toLat,
          lon: toLon,
          startedAt: Date.now(),
          endsAt: Date.now(),
          via: null,
          path: null,
        });
        setSelectedUnit(LORD_UNIT_ID);
        setSheet("move");
        return;
      }
      // 부대와 동일한 클라이언트 길찾기 (이동가능영역 그래프).
      let path: Array<{ lat: number; lon: number }> | null = null;
      try {
        const deadlineMs = Date.now() + Math.min(ROUTE_BUDGET_MS, 8000);
        const found = await findWalkablePathRecursive(startLat, startLon, toLat, toLon, 8000, deadlineMs);
        if (found && found.length >= 2) {
          const smoothed = smoothPathLatLon(found);
          const trimmed = removePathLoops(smoothed.length >= 2 ? smoothed : found);
          if (trimmed.length >= 2) {
            path = trimmed;
          }
        }
      } catch {
        path = null;
      }
      if (!path && distM > 20000) {
        try {
          const routed = (await callApi<{
            path?: Array<{ lat?: unknown; lon?: unknown }>;
            reason?: unknown;
            totalMs?: unknown;
          }>("/api/route", {
            fromLat: startLat,
            fromLon: startLon,
            toLat,
            toLon,
          })) as { path?: Array<{ lat?: unknown; lon?: unknown }> };
          if (Array.isArray(routed.path)) {
            const pts = routed.path.flatMap((p) => {
              const plat = typeof p?.lat === "number" ? p.lat : Number(p?.lat);
              const plon = typeof p?.lon === "number" ? p.lon : Number(p?.lon);
              return Number.isFinite(plat) && Number.isFinite(plon) ? [{ lat: plat, lon: plon }] : [];
            });
            const trimmed = removePathLoops(pts);
            if (trimmed.length >= 2) {
              path = trimmed;
            }
          }
        } catch {
          path = null;
        }
      }
      if (!path) {
        setActionDialog({
          title: "영주를 이동할 수 없습니다",
          message: "길이 막혔습니다. 이동가능 영역으로 연결된 목적지를 선택해 주세요.",
        });
        return;
      }
      const startedAt = Date.now();
      const order: UnitMoveTarget = {
        fromLat: startLat,
        fromLon: startLon,
        lat: toLat,
        lon: toLon,
        startedAt,
        endsAt: startedAt,
        via: null,
        path,
      };
      const line = movePolyline(order);
      let totalLen = 0;
      for (let i = 1; i < line.length; i += 1) {
        const a = line[i - 1];
        const b = line[i];
        if (!a || !b) {
          continue;
        }
        const segKx = 111320 * Math.cos((a.lat * Math.PI) / 180);
        totalLen += Math.hypot((b.lon - a.lon) * segKx, (b.lat - a.lat) * 110540);
      }
      const durationMs = Math.max(1000, (totalLen / UNIT_SPEED_MPS) * 1000);
      order.endsAt = startedAt + durationMs;
      props.onLordMoveOrder?.(order);
      publishRouteLive(LORD_UNIT_ID, line, { lat: toLat, lon: toLon }, true);
      setSelectedUnit(LORD_UNIT_ID);
      setSheet("move");
      setMoveNow(Date.now());
    } catch (error) {
      setActionDialog({ title: "영주 이동을 시작할 수 없습니다", message: messageOf(error) });
    } finally {
      setBusy(false);
      setFindingPathUnitId((current) => (current === LORD_UNIT_ID ? null : current));
    }
  };

  // 다구간 이동 체인: 구간별로 경로를 풀면서 이동한다 (초장거리 대응).
  // 단일 구간이면 길 없을 때 차단하고, 다구간이면 데이터 없는 구간은 직선으로 메운다.
  const runMoveChain = async (args: {
    unitId: string;
    fromLat: number;
    fromLon: number;
    destLat: number;
    destLon: number;
    via: Array<{ lat: number; lon: number }>;
    tripStartedAt: number;
    register: boolean;
    // 체인 중간 청크용: 부분 행군이어도 실제 도착점을 반환해 다음 청크가 이어간다.
    // strictEnd면 중간 부분행군 안내 다이얼로그를 억제한다 (마지막 청크만 표시).
    strictEnd?: boolean;
    // 장거리 청크 행군 표시용: 빨간 마커·진행 문구에 쓰는 최종 목적지와 구간 라벨.
    displayDest?: { lat: number; lon: number };
    legLabel?: string;
    // 길찾기 예산 오버라이드 (없으면 ROUTE_BUDGET_MS).
    budgetMs?: number;
    // 서버 통합 그래프 경로 (있으면 클라이언트 라우팅 1~2단계를 스킵한다).
    presetPath?: Array<{ lat: number; lon: number }>;
  }): Promise<{ ok: boolean; endLat: number; endLon: number; partial: boolean }> => {
    const { unitId, fromLat, fromLon, destLat, destLon, via, tripStartedAt, register, strictEnd = false, displayDest, legLabel, budgetMs, presetPath } = args;
    const routeBudgetMs = budgetMs ?? ROUTE_BUDGET_MS;
    const fail = { ok: false, endLat: fromLat, endLon: fromLon, partial: false };
    // 서버 주문 시각 (등록 후 서버 응답으로 확정 — 애니메이션·진행률 기준).
    let orderStartedAt = tripStartedAt;
    let orderEndsAt = tripStartedAt;
    const kx = 111320 * Math.cos((fromLat * Math.PI) / 180);
    const straightOf = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
      Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 110540);
    // 이미 지난 경유지는 잘라낸다 (재개 시 출발점 방향 역행 방지).
    // via는 출발지→목적지 직선 위 점들이므로, 현재 위치 투영보다
    // 100m 이상 뒤에 있는 앞부분은 이미 지난 것으로 간주한다.
    // 신규 주문이면 아무것도 잘리지 않는다 (전부 앞에 있음).
    let chainVia = via;
    {
      const dx = destLon - fromLon;
      const dy = destLat - fromLat;
      const len2 = dx * dx + dy * dy;
      if (len2 > 0 && via.length > 0) {
        const axisM = Math.hypot(dx * kx, dy * 110540) || 1;
        const eps = 100 / axisM;
        let cut = 0;
        while (cut < via.length) {
          const v = via[cut];
          if (!v) {
            break;
          }
          const t = ((v.lon - fromLon) * dx + (v.lat - fromLat) * dy) / len2;
          if (t >= -eps) {
            break;
          }
          cut += 1;
        }
        if (cut > 0) {
          chainVia = via.slice(cut);
        }
      }
    }
    const joints: Array<{ lat: number; lon: number }> = [
      { lat: fromLat, lon: fromLon },
      ...chainVia,
      { lat: destLat, lon: destLon },
    ];
    const usePreset = !!presetPath && presetPath.length >= 2;
    let marchSegs: Array<Array<{ lat: number; lon: number }>> | null = null;
    let partial = false;
    let totalEst = 0;
    if (usePreset) {
      // 서버 경로: 그대로 단일 구간으로 쓴다.
      marchSegs = [presetPath as Array<{ lat: number; lon: number }>];
      setFindingPathUnitId((current) => (current === unitId ? null : current));
      setFindingProgress(null);
    } else {
    totalEst = Math.max(1000, (straightOf(fromLat, fromLon, destLat, destLon) / UNIT_SPEED_MPS) * 1000);
    setMoveProgressMap((prev) => ({ ...prev, [unitId]: { startedAt: tripStartedAt, durationMs: totalEst, destLat, destLon } }));
    setMoveNow(Date.now());
    // 서버 권위: 경로는 먼저 계산하고 주문서는 확정 경로와 함께 1회만 등록한다.
    // (등록 후 재계산·재동기화 없음 — 리로드 후 A* 재실행의 원인이었음)
      // 1단계: 경유지 스냅 + 무도로(void) 경유지 제거. 스냅 반경은 좁게 잡는다.
      // (넓게 잡으면 물 위 경유지가 수 km 밖 해안으로 끌려가 강제 왕복·대우회를 만든다.
      //  실제 46km 주문에서 5곳의 막다른 왕복이 이 때문이었음)
      // 스냅 실패한 내부 경유지는 빼고 양옆을 잇는다 (재귀 분할이 긴 다리를 처리).
      // 스냅 거리도 기록한다 (실패 다리 병합 시 멀리 끌려간 쪽을 먼저 버린다).
      const snappedJoints = await Promise.all(
        joints.map(async (joint, ji) => {
          if (!joint || ji === 0 || ji === joints.length - 1) {
            return joint ? { ...joint, snapM: 0 } : null;
          }
          const snapped = await snapToNearestWalkableLocation(joint.lat, joint.lon, 300, true);
          if (!snapped) {
            return null;
          }
          return { lat: snapped.lat, lon: snapped.lon, snapM: snapped.distanceM };
        }),
      );
      if (!movingUnitIdsRef.current.has(unitId)) {
        return fail;
      }
      const keptJoints = snappedJoints.filter(
        (joint): joint is { lat: number; lon: number; snapM: number } => joint !== null,
      );
      // 2단계: 다리 단위 탐색. 경유지가 고정되어 있어 다리끼리 독립적이다.
      // (기존 전경/백그라운드 공유 캐시는 시작점 불일치로 어긋난 경로를 재사용해서 제거)
      // 실패한 다리는 이웃과 합쳐 더 긴 다리로 재시도한다 (최대 4회).
      // 나쁜 경유지(고립 조각 등)를 건너뛰면 뚫리는 경우가 많다.
      // 40개 넘는 다리를 Promise.all 한 번에 묶으면 첫 라운드 하나가 수 분 걸리므로
      // 4개씩 배치로 끊고 배치마다 예산을 확인한다 (초장거리 무응답 방지).
      const LEG_BATCH = 8;
      const routeSpan = async (
        a: { lat: number; lon: number },
        b: { lat: number; lon: number },
        deadlineMs: number,
      ): Promise<Array<{ lat: number; lon: number }> | null> => {
        if (!movingUnitIdsRef.current.has(unitId)) {
          return null;
        }
        const seg = await findWalkablePathRecursive(a.lat, a.lon, b.lat, b.lon, 8000, deadlineMs);
        if (!seg || seg.length === 0) {
          return null;
        }
        if (!movingUnitIdsRef.current.has(unitId)) {
          return null;
        }
        return seg;
      };
      let spanJoints = [...keptJoints];
      const spanCache = new Map<string, Array<{ lat: number; lon: number }>>();
      const spanKey = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): string =>
        `${a.lat.toFixed(6)},${a.lon.toFixed(6)}-${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
      let spanPaths: Array<Array<{ lat: number; lon: number }> | null> | null = null;
      const routeStart = Date.now();
      let budgetHit = false;
      for (let round = 0; round < 5; round += 1) {
        // 시간 예산 초과 시 새 라운드를 열지 않고 풀린 앞부분까지만 쓴다 (부분 행군).
        if (round > 0 && Date.now() - routeStart > routeBudgetMs) {
          budgetHit = true;
          break;
        }
        const legCount = spanJoints.length - 1;
        const results: Array<Array<{ lat: number; lon: number }> | null> = new Array(legCount).fill(null);
        const deadlineMs = routeStart + routeBudgetMs;
        for (let bi = 0; bi < legCount; bi += LEG_BATCH) {
          // 배치마다 예산 확인 — 초과 시 지금까지 풀린 앞부분으로 부분 행군한다.
          if (Date.now() > deadlineMs) {
            budgetHit = true;
            break;
          }
          const batchEnd = Math.min(legCount, bi + LEG_BATCH);
          const batchOutcomes = await Promise.all(
            spanJoints.slice(bi + 1, batchEnd + 1).map(async (rawEnd, offset) => {
              const index = bi + offset;
              const a = spanJoints[index];
              if (!rawEnd || !a) {
                return null;
              }
              const cached = spanCache.get(spanKey(a, rawEnd));
              if (cached) {
                return cached;
              }
              const seg = await routeSpan(a, rawEnd, deadlineMs);
              if (seg && seg.length > 0) {
                spanCache.set(spanKey(a, rawEnd), seg);
              }
              return seg;
            }),
          );
          batchOutcomes.forEach((seg, offset) => {
            results[bi + offset] = seg;
          });
          setFindingProgress({
            done: results.filter((seg) => seg && seg.length > 0).length,
            total: results.length,
          });
          if (!movingUnitIdsRef.current.has(unitId)) {
            break;
          }
        }
        if (results.every((seg) => seg && seg.length > 0)) {
          spanPaths = results as Array<Array<{ lat: number; lon: number }>>;
          break;
        }
        // 예산 소진(배치 도중 중단)이면 병합 라운드를 열지 않고 풀린 앞부분으로 간다.
        if (budgetHit || !movingUnitIdsRef.current.has(unitId)) {
          break;
        }
        if (spanJoints.length <= 2 || !movingUnitIdsRef.current.has(unitId)) {
          break;
        }
        // 실패 다리의 양쪽 끝 중 스냅이 멀리 끌려간 쪽(고립 가능성)을 버리고 이웃과 합친다.
        // 첫 다리는 끝점을, 마지막 다리는 시작점을, 나머지는 스냅이 먼 쪽을 버린다.
        const failed = new Set<number>();
        results.forEach((seg, i) => {
          if (!seg || seg.length === 0) {
            failed.add(i + 1);
          }
        });
        const drop = new Set<number>();
        failed.forEach((li) => {
          const a = spanJoints[li - 1];
          const b = spanJoints[li];
          if (!a || !b) {
            return false;
          }
          if (li <= 1) {
            drop.add(li);
          } else if (li >= spanJoints.length - 1) {
            drop.add(li - 1);
          } else if ((a.snapM ?? 0) >= (b.snapM ?? 0)) {
            drop.add(li - 1);
          } else {
            drop.add(li);
          }
        });
        const next: Array<{ lat: number; lon: number; snapM: number }> = [];
        spanJoints.forEach((joint, ji) => {
          if (ji === 0 || ji === spanJoints.length - 1 || !drop.has(ji)) {
            if (joint) {
              next.push(joint);
            }
          }
        });
        if (next.length >= spanJoints.length) {
          break;
        }
        spanJoints = next;
      }
      const legPaths = spanPaths;
      setFindingPathUnitId((current) => (current === unitId ? null : current));
      setFindingProgress(null);
      // 전부 풀리면 그대로, 아니면 시작부터 연속으로 풀린 다리까지만 부분 행군한다.
      // (직선 폴백 없음. 부분 행군도 실제 길만 걷는다)
      marchSegs =
        legPaths && legPaths.every((seg) => seg && seg.length > 0)
          ? (legPaths as Array<Array<{ lat: number; lon: number }>>)
          : null;
      if (!marchSegs && movingUnitIdsRef.current.has(unitId)) {
        const prefix: Array<Array<{ lat: number; lon: number }>> = [];
        for (let li = 1; li < keptJoints.length; li += 1) {
          const a = keptJoints[li - 1];
          const b = keptJoints[li];
          if (!a || !b) {
            break;
          }
          const seg = spanCache.get(spanKey(a, b));
          if (!seg || seg.length === 0) {
            break;
          }
          prefix.push(seg);
        }
        if (prefix.length > 0) {
          marchSegs = prefix;
          partial = true;
        }
      }
      if (!marchSegs || !movingUnitIdsRef.current.has(unitId)) {
        // 사용자 중지가 아니면(예외·예상 밖 중단 포함) 반드시 사유를 알린다.
        if (movingUnitIdsRef.current.has(unitId) || !stopRequestedRef.current.has(unitId)) {
          setActionDialog(
            budgetHit
              ? {
                  title: "길찾기가 시간 안에 끝나지 않았습니다",
                  message:
                    "장거리라 경로 계산이 길어지고 있습니다. 이동가능영역 데이터는 저장되어 다음 시도가 빨라지니 잠시 후 다시 시도해 주세요.",
                }
              : {
                  title: "부대를 이동할 수 없습니다",
                  message: "길이 막혔습니다. 이동가능 영역으로 연결된 목적지를 선택해 주세요.",
                },
          );
        }
        return fail;
      }
      if (partial && !strictEnd) {
        setActionDialog({
          title: "갈 수 있는 곳까지만 이동합니다",
          message: "목적지까지 연결된 길이 없어 이동가능한 마지막 지점에서 멈춥니다.",
        });
      }
    }
    // 2단계: 연결 + 전체 스무딩. 다리 고정 경유지가 강제하는 우회·왕복을 여기서 제거한다.
    const full: Array<{ lat: number; lon: number }> = [];
    for (const seg of marchSegs) {
      for (const point of seg as Array<{ lat: number; lon: number }>) {
        const last = full[full.length - 1];
        if (!last || last.lat !== point.lat || last.lon !== point.lon) {
          full.push(point);
        }
      }
    }
    // 서버 경로도 스무딩으로 막다른·우회를 제거한다.
    // lineOpen은 격자 true 구간만 단축하므로 미로드 구간은 원본 유지(안전)한다.
    const smoothed = smoothPathLatLon(full);
    if (smoothed.length === 0 || !movingUnitIdsRef.current.has(unitId)) {
      if (movingUnitIdsRef.current.has(unitId) || !stopRequestedRef.current.has(unitId)) {
        setActionDialog({
          title: "부대를 이동할 수 없습니다",
          message: "길이 막혔습니다. 이동가능 영역으로 연결된 목적지를 선택해 주세요.",
        });
      }
      return fail;
    }
    // 검증-복원-세분화: 저장·표시되는 모든 현(hypotenuse)을 격자로 보증한다.
    // 스무딩 점프·솎아내기로 생긴 미검증 현은 원본(full) 점으로 되돌리고,
    // 그래프 곡선 구간의 짧은 이탈은 walkable 중간점으로 쪼갠다.
    // 되돌릴 길도 쪼갤 길도 없으면 그 지점에서 잘라 부분 행군한다 (직선 현 저장 금지).
    // 격자 판정: 확정 비도로(false)는 탈락, 미로드(null)는 서버 경로일 때만 통과.
    // 서버 경로는 도로 그래프 검증済み이라 미로드 구간도 실제 길이다.
    // 클라이언트 자체 라우팅은 검증 전 격자를 로드하므로 null이 거의 없어 동작 변화 없음.
    const gridOk = (lat: number, lon: number): boolean => {
      const v = isWalkableGridSync(lat, lon);
      if (v === false) {
        return false;
      }
      if (v === true) {
        return true;
      }
      return usePreset;
    };
    const chordWalkable = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean => {
      const ckx = 111320 * Math.cos((a.lat * Math.PI) / 180);
      const total = Math.hypot((b.lon - a.lon) * ckx, (b.lat - a.lat) * 110540);
      const steps = Math.max(1, Math.ceil(total / 5));
      for (let s = 0; s <= steps; s += 1) {
        const lat = a.lat + ((b.lat - a.lat) * s) / steps;
        const lon = a.lon + ((b.lon - a.lon) * s) / steps;
        if (!gridOk(lat, lon)) {
          return false;
        }
      }
      return true;
    };
    const subdivideChord = (
      a: { lat: number; lon: number },
      b: { lat: number; lon: number },
      depth: number,
    ): Array<{ lat: number; lon: number }> => {
      if (chordWalkable(a, b)) {
        return [b];
      }
      if (depth <= 0) {
        return [];
      }
      const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      if (!gridOk(mid.lat, mid.lon)) {
        return [];
      }
      return [...subdivideChord(a, mid, depth - 1), ...subdivideChord(mid, b, depth - 1)];
    };
    const finalPath: Array<{ lat: number; lon: number }> = [];
    let truncated = false;
    if (usePreset && presetPath) {
      // 서버 검증 경로 + 스무딩 결과를 그대로 쓴다 (격자 재검증 스킵).
      // 스무딩된 현은 lineOpen(격자 true)을 통과한 것만이라 저장 안전하다.
      finalPath.push(...smoothed);
    } else {
      {
        let cursor = 0;
        const indexInFull: number[] = [];
        for (const p of smoothed) {
          const at = full.indexOf(p, cursor);
          indexInFull.push(at);
          if (at !== -1) {
            cursor = at + 1;
          }
        }
        for (let k = 0; k < smoothed.length && !truncated; k += 1) {
          const p = smoothed[k];
          if (!p) {
            continue;
          }
          if (k > 0) {
            const a = smoothed[k - 1];
            const ia = indexInFull[k - 1] ?? -1;
            const ib = indexInFull[k] ?? -1;
            if (a && ia !== -1 && ib !== -1 && ib > ia && !chordWalkable(a, p)) {
              // 원본 중간점을 되돌리고, 그래도 벗어나면 중간점으로 쪼갠다.
              // 한 구간이라도 복원 불가면 거기서 잘라 부분 행군한다.
              let prev: { lat: number; lon: number } = a;
              for (let m = ia + 1; m <= ib; m += 1) {
                const mid = m === ib ? p : full[m];
                if (!mid) {
                  continue;
                }
                const qs = subdivideChord(prev, mid, 3);
                if (qs.length === 0) {
                  truncated = true;
                  break;
                }
                for (const q of qs) {
                  finalPath.push(q);
                }
                prev = mid;
              }
              continue;
            }
            if (!a) {
              truncated = true;
              continue;
            }
            const directQs = subdivideChord(a, p, 3);
            if (directQs.length === 0) {
              truncated = true;
              continue;
            }
            for (const q of directQs) {
              finalPath.push(q);
            }
            continue;
          }
          finalPath.push(p);
        }
      }
      if (truncated) {
        partial = true;
      }
    }
    // 부분 행군이면 실제 도착점(마지막 지점)을 목적지로 삼는다.
    const marchEnd = finalPath[finalPath.length - 1] ?? smoothed[smoothed.length - 1];
    const marchDestLat = partial && marchEnd ? marchEnd.lat : destLat;
    const marchDestLon = partial && marchEnd ? marchEnd.lon : destLon;
    // 3단계: 실제 길이로 소요시간 확정 (직선 추정치 대체).
    const totalLen = finalPath.reduce((sum, p, i) => {
      const prev = i === 0 ? { lat: fromLat, lon: fromLon } : finalPath[i - 1];
      if (!prev) {
        return sum;
      }
      return sum + straightOf(prev.lat, prev.lon, p.lat, p.lon);
    }, 0);
    console.debug("[walkable] final pts", finalPath.length, "truncated", truncated, "partial", partial, "usePreset", usePreset);
    {
      const kx = 111320 * Math.cos((fromLat * Math.PI) / 180);
      const longs: string[] = [];
      const waters: string[] = [];
      for (let i = 1; i < finalPath.length; i += 1) {
        const a = finalPath[i - 1] as { lat: number; lon: number };
        const b = finalPath[i] as { lat: number; lon: number };
        const m = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
        if (m > 150) {
          longs.push(`#${i}:${m.toFixed(0)}m(${a.lat.toFixed(4)},${a.lon.toFixed(4)}-${b.lat.toFixed(4)},${b.lon.toFixed(4)})`);
        }
      }
      // 표시 경로의 물 횡단 구간 (격자 false) — 위치 특정용.
      for (let i = 1; i < finalPath.length && waters.length < 10; i += 1) {
        const a = finalPath[i - 1] as { lat: number; lon: number };
        const b = finalPath[i] as { lat: number; lon: number };
        const total = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
        const steps = Math.max(1, Math.ceil(total / 25));
        for (let s = 0; s <= steps; s += 1) {
          const lat = a.lat + ((b.lat - a.lat) * s) / steps;
          const lon = a.lon + ((b.lon - a.lon) * s) / steps;
          if (isWalkableGridSync(lat, lon) === false) {
            waters.push(`#${i}:${lat.toFixed(4)},${lon.toFixed(4)}`);
            break;
          }
        }
      }
      if (longs.length > 0) {
        console.debug("[walkable] long chords", longs.slice(0, 20).join(" "));
      }
      if (waters.length > 0) {
        console.debug("[walkable] water chords", waters.join(" "));
      }
    }
    totalEst = Math.max(1000, (totalLen / UNIT_SPEED_MPS) * 1000);
    setMoveProgressMap((prev) => ({
      ...prev,
      [unitId]: {
        startedAt: tripStartedAt,
        durationMs: totalEst,
        destLat: marchDestLat,
        destLon: marchDestLon,
        ...(legLabel ? { legLabel } : null),
        ...(displayDest ? { finalLat: displayDest.lat, finalLon: displayDest.lon } : null),
      },
    }));
    setMoveNow(Date.now());
    // 확정 경로와 함께 주문서 1회 등록 (서버가 경로 길이로 소요시간 검증).
    // finalPath의 모든 현은 격자 검증済み — 인덱스 솎아내기(미검증 현 생성) 금지.
    // 상한 2000 초과 시 검증 기반 RDP 솎음: chordWalkable 통과 현만 건너뛴다.
    // 서버 경로는 이미 도로 추종이므로 기하 오차만 작게 잡아 솎음을 최소화한다.
    let orderPath = finalPath;
    if (finalPath.length > 5000) {
      const rdpEpsM = usePreset ? 5 : 15;
      const rdpKx = 111320 * Math.cos((fromLat * Math.PI) / 180);
      const perpM = (
        p: { lat: number; lon: number },
        a: { lat: number; lon: number },
        b: { lat: number; lon: number },
      ): number => {
        const ax = 0;
        const ay = 0;
        const bx = (b.lon - a.lon) * rdpKx;
        const by = (b.lat - a.lat) * 110540;
        const px = (p.lon - a.lon) * rdpKx;
        const py = (p.lat - a.lat) * 110540;
        const len2 = bx * bx + by * by;
        if (len2 === 0) {
          return Math.hypot(px - ax, py - ay);
        }
        const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
        return Math.hypot(px - bx * t, py - by * t);
      };
      const keep = new Set<number>([0, finalPath.length - 1]);
      const stack: Array<[number, number]> = [[0, finalPath.length - 1]];
      while (stack.length > 0) {
        const [s, e] = stack.pop() as [number, number];
        const a = finalPath[s];
        const b = finalPath[e];
        if (!a || !b) {
          continue;
        }
        let dmax = 0;
        let imax = -1;
        for (let i = s + 1; i < e; i += 1) {
          const p = finalPath[i];
          if (!p) {
            continue;
          }
          const d = perpM(p, a, b);
          if (d > dmax) {
            dmax = d;
            imax = i;
          }
        }
        // 직선 구간 + 현 검증 통과 시에만 중간점을 버린다.
        // preset은 기하 기준으로만 솎는다 (서버 검증 경로라 격자 재검증 불필요).
      if (imax !== -1 && (dmax > rdpEpsM || (!usePreset && !chordWalkable(a, b)))) {
          keep.add(imax);
          stack.push([s, imax], [imax, e]);
        }
      }
      orderPath = finalPath.filter((_, i) => keep.has(i));
      // 그래도 초과면 검증 기반 솎음: chord 실패 현은 중간점을 유지한다.
      // 균등 솎음은 물·비도로를 가로지르는 미검증 현을 만들 수 있어 금지한다.
      if (orderPath.length > 5000) {
        const step = Math.ceil(orderPath.length / 5000);
        const thin: Array<{ lat: number; lon: number }> = [orderPath[0] as { lat: number; lon: number }];
        let i = 0;
        while (i < orderPath.length - 1) {
          let j = Math.min(orderPath.length - 1, i + step);
          // chord 실패 시 한 점씩 좁혀 물 횡단을 방지한다.
          while (j > i + 1) {
            const a = thin[thin.length - 1] as { lat: number; lon: number };
            const b = orderPath[j] as { lat: number; lon: number };
            if (chordWalkable(a, b)) {
              break;
            }
            j -= 1;
          }
          thin.push(orderPath[j] as { lat: number; lon: number });
          i = j;
        }
        if (thin.length >= 2) {
          orderPath = thin;
        }
      }
    }
    if (register) {
      try {
        // orderStartedAt은 등록 시점 기준이다. 길찾기 시작(tripStartedAt)을 쓰면
        // 장거리 라우팅 중에 lastMoveAt가 바뀌어 stale_order로 오인 거부된다.
        const registered = (await callApi<Record<string, unknown>>("/api/units/act", {
          unitId,
          toLat: fromLat,
          toLon: fromLon,
          destLat: marchDestLat,
          destLon: marchDestLon,
          path: orderPath,
          durationMs: totalEst,
          orderStartedAt: Date.now(),
          reorder: true,
          action: "move",
        })) as Record<string, unknown>;
        // 서버가 무효 동기화로 판단하면 ok:true + stale로 응답한다 (moveTarget 없음).
        // 이를 order_failed로 뭉뚱그리지 않고 사유 코드 그대로 전달한다.
        if (registered.stale === true) {
          throw new Error(typeof registered.code === "string" ? registered.code : "stale_order");
        }
        const target = registered.moveTarget as
          | { startedAt?: unknown; endsAt?: unknown }
          | null
          | undefined;
        if (
          !target ||
          typeof target.startedAt !== "number" ||
          typeof target.endsAt !== "number"
        ) {
          // 서버가 도착 확정했으면(moveTarget null) 이동 완료로 취급한다.
          // 유닛이 이미 목적지 300m 안에 있을 때 등록 요청이 arrived로 처리되는 경우다.
          const rlat = registered.lat;
          const rlon = registered.lon;
          if (typeof rlat === "number" && typeof rlon === "number") {
            const gapKx = 111320 * Math.cos((marchDestLat * Math.PI) / 180);
            const gapM = Math.hypot((rlon - marchDestLon) * gapKx, (rlat - marchDestLat) * 110540);
            if (gapM <= 300) {
              await refreshUnits();
              clearRoute(unitId);
              return { ok: true, endLat: rlat, endLon: rlon, partial };
            }
          }
          throw new Error("order_failed");
        }
        // 서버 주문 시각을 기준으로 진행률·애니메이션을 맞춘다 (서버 권위와 일치).
        orderStartedAt = target.startedAt;
        orderEndsAt = target.endsAt;
      } catch (error) {
        await refreshUnits();
        setActionDialog({ title: "부대 이동을 시작할 수 없습니다", message: messageOf(error) });
        return fail;
      }
    }
    // 빨간 목적지 마커는 최종 목적지에 고정한다 (청크 끝이 아님).
    publishRouteLive(unitId, finalPath, displayDest ? { ...displayDest } : { lat: marchDestLat, lon: marchDestLon }, register);
    // 이동 명령 후에도 다이얼로그를 유지해 길찾기 스피너·진행률을 표시한다.
    // (닫으면 선택 테두리·진행률·이동중지 버튼이 함께 사라진다)
    setSelectedUnit(unitId);
    setSheet("move");
    // 4단계: 다듬어진 전체 경로를 단일 애니메이션으로 행군한다.
    // (서버 권위 위치와 동일한 수식으로 렌더링만 한다 — 중간 동기화 POST 없음)
    const lastPos = await animateUnitAlongPath(
      unitId,
      fromLat,
      fromLon,
      finalPath,
      orderEndsAt - orderStartedAt,
      orderStartedAt,
      orderEndsAt - orderStartedAt,
      marchDestLat,
      marchDestLon,
      true,
    );
    if (!movingUnitIdsRef.current.has(unitId)) {
      return fail;
    }
    clearRoute(unitId);
    // 실제 도착점을 반환한다 — 체인 모드는 다음 청크가 여기서 이어간다 (부분 행군 포함).
    return { ok: true, endLat: lastPos.lat, endLon: lastPos.lon, partial };
  };

  const moveUnitGradually = async (
    unitId: string,
    fromLat: number,
    fromLon: number,
    rawToLat: number,
    rawToLon: number,
    moveCenter?: { lat: number; lon: number },
  ): Promise<void> => {
    if (movingUnitIdsRef.current.has(unitId)) {
      return;
    }
    addMovingUnit(unitId);
    stopRequestedRef.current.delete(unitId);
    setFindingPathUnitId(unitId);
    // 길 찾는 동안 경로는 숨기고, 목적지 마커는 클릭 시점 중앙에 고정한다.
    onMovePath(null);
    onMoveDestination(moveCenter ? { lat: moveCenter.lat, lon: moveCenter.lon } : null);
    // 스피너가 확실히 그려진 뒤에 무거운 재병합·탐색을 시작한다.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    if (!movingUnitIdsRef.current.has(unitId)) {
      setFindingPathUnitId((current) => (current === unitId ? null : current));
    setFindingProgress(null);
      removeMovingUnit(unitId);
      return;
    }
    if (moveCenter) {
      // 이동 버튼 클릭 시점에만 목적지 주변 이동가능영역을 표시한다.
      onMoveTargetCenter(moveCenter);
    }
    try {
      ensureWalkableData(rawToLat, rawToLon);
      ensureWalkableData(fromLat, fromLon);
      // 목적지 보정: 오지여도 가장 가까운 이동가능영역 위로 끌어당긴다.
      // 500m를 먼저 시도하고(일반 케이스), 실패 시 3km까지 확대한다.
      // 그래프 스냅 반경(최대 3km) 안에 들어오므로 그래프 단계에서 끝난다.
      const snapped =
        (await snapToNearestWalkableLocation(rawToLat, rawToLon, 500)) ??
        (await snapToNearestWalkableLocation(rawToLat, rawToLon, 3000));
      if (
        snapped &&
        (Math.abs(snapped.lat - rawToLat) > 1e-9 || Math.abs(snapped.lon - rawToLon) > 1e-9)
      ) {
        const km = snapped.distanceM >= 1000
          ? `${(snapped.distanceM / 1000).toFixed(1)}km`
          : `${Math.round(snapped.distanceM)}m`;
        flash(`목적지가 길에서 벗어나 가장 가까운 길로 보정했습니다 (${km})`);
      }
      const toLat = snapped?.lat ?? rawToLat;
      const toLon = snapped?.lon ?? rawToLon;
      const kx = 111320 * Math.cos((fromLat * Math.PI) / 180);
      const distM = Math.hypot((toLon - fromLon) * kx, (toLat - fromLat) * 110540);
      if (distM < 1) {
        await doUnitAct(unitId, "move", toLat, toLon);
        return;
      }
      // 3km 초과는 다구간 체인으로 구간별 풀이한다 (구간당 2.5km).
      const via: Array<{ lat: number; lon: number }> = [];
      if (distM > 3000) {
        const legCount = Math.min(200, Math.max(2, Math.ceil(distM / CHAIN_LEG_M)));
        for (let i = 1; i < legCount; i += 1) {
          via.push({
            lat: fromLat + ((toLat - fromLat) * i) / legCount,
            lon: fromLon + ((toLon - fromLon) * i) / legCount,
          });
        }
      }
      // 장거리(20km 초과)는 서버 통합 그래프를 먼저 시도한다.
      // 성공하면 클라이언트 라우팅을 스킵하고 바로 주문·출발한다.
      // 실패하면 기존 클라이언트 라우팅으로 폴백한다.
      let presetPath: Array<{ lat: number; lon: number }> | undefined;
      if (distM > 20000) {
        try {
          const routed = (await callApi<{
            path?: Array<{ lat?: unknown; lon?: unknown }>;
            reason?: unknown;
            totalMs?: unknown;
          }>("/api/route", {
            fromLat,
            fromLon,
            toLat,
            toLon,
          })) as {
            path?: Array<{ lat?: unknown; lon?: unknown }>;
            reason?: unknown;
            totalMs?: unknown;
          };
          console.debug(
            "[walkable] server route",
            typeof routed.reason === "string" ? routed.reason : "ok",
            typeof routed.totalMs === "number" ? `${routed.totalMs}ms` : "",
          );
          const pts = Array.isArray(routed.path)
            ? routed.path.filter(
              (pt): pt is { lat: number; lon: number } =>
                !!pt &&
                typeof pt.lat === "number" &&
                typeof pt.lon === "number" &&
                Number.isFinite(pt.lat) &&
                Number.isFinite(pt.lon),
            )
            : [];
          if (pts.length >= 2) {
            presetPath = pts;
            console.debug("[walkable] preset pts", pts.length);
          }
        } catch {
          presetPath = undefined;
        }
      }
      // 전 구간을 한 번에 풀어 단일 주문으로 출발한다 (이전 방식).
      // 부분 행군이면 실제 도착점에서 멈추고 안내한다.
      await runMoveChain({
        unitId,
        fromLat,
        fromLon,
        destLat: toLat,
        destLon: toLon,
        via,
        tripStartedAt: Date.now(),
        register: true,
        displayDest: { lat: toLat, lon: toLon },
        ...(presetPath ? { presetPath } : null),
      });
    } catch (error) {
      // runMoveChain 내 예상 밖 예외는 finally로 조용히 사라지므로 여기서 반드시 알린다.
      if (!stopRequestedRef.current.has(unitId)) {
        setActionDialog({ title: "부대 이동 중 오류가 발생했습니다", message: messageOf(error) });
      }
    } finally {
      setFindingPathUnitId((current) => (current === unitId ? null : current));
    setFindingProgress(null);
      clearRoute(unitId);
      setMoveProgressMap((prev) => {
        const next = { ...prev };
        delete next[unitId];
        return next;
      });
      removeMovingUnit(unitId);
    }
  };

  const animateUnitAlongPath = async (
    unitId: string,
    fromLat: number,
    fromLon: number,
    path: Array<{ lat: number; lon: number }>,
    durationMs: number,
    progressStartedAt: number,
    progressDurationMs: number,
    destLat: number,
    destLon: number,
    finalize: boolean,
  ): Promise<{ lat: number; lon: number }> => {
    // 서버 권위 위치와 동일한 수식으로 렌더링만 한다 (위치 전진 POST 없음).
    const orderLike = {
      fromLat,
      fromLon,
      lat: destLat,
      lon: destLon,
      startedAt: progressStartedAt,
      endsAt: progressStartedAt + progressDurationMs,
      via: null,
      path,
    };
    setMoveProgressMap((prev) => ({
      ...prev,
      [unitId]: {
        startedAt: progressStartedAt,
        durationMs: progressDurationMs,
        destLat,
        destLon,
        ...(prev[unitId]?.legLabel ? { legLabel: prev[unitId]?.legLabel } : null),
        ...(prev[unitId]?.finalLat !== undefined
          ? { finalLat: prev[unitId]?.finalLat, finalLon: prev[unitId]?.finalLon }
          : null),
      },
    }));
    setMoveNow(Date.now());
    void durationMs;
    let lastPos = { lat: fromLat, lon: fromLon };
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        // 이동 중지되면 애니메이션을 즉시 중단한다.
        if (!movingUnitIdsRef.current.has(unitId)) {
          resolve();
          return;
        }
        const pos = positionAtMoveTarget(orderLike, Date.now());
        lastPos = { lat: pos.lat, lon: pos.lon };
        setUnits((prev) =>
          prev.map((u) => (u.id === unitId ? { ...u, lat: pos.lat, lon: pos.lon } : u)),
        );
        if (!pos.arrived) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
    const arrived = path[path.length - 1] ?? { lat: destLat, lon: destLon };
    if (finalize && movingUnitIdsRef.current.has(unitId)) {
      // 도착 확정은 runAction busy 게이트를 타지 않고 직접 기록한다 (동시 이동 허용).
      // 서버도 다음 조회 때 lazy 정산하므로 실패해도 어긋나지 않는다.
      try {
        await callApi("/api/units/act", {
          unitId,
          toLat: arrived.lat,
          toLon: arrived.lon,
          destLat: arrived.lat,
          destLon: arrived.lon,
          action: "move",
        });
        await refreshUnits();
      } catch {
        // 실패 시 다음 폴링에서 서버 상태로 동기화된다.
      }
    }
    return lastPos;
  };

  const stopUnitMovement = async (unitId: string): Promise<void> => {
    if (!movingUnitIdsRef.current.has(unitId)) {
      return;
    }
    const unit = unitsRef.current.find((item) => item.id === unitId);
    if (!unit) {
      return;
    }
    // 현재 위치에서 이동을 멈춘다 (목적지=현재 위치로 확정).
    try {
      await callApi("/api/units/act", {
        unitId,
        toLat: unit.lat,
        toLon: unit.lon,
        destLat: unit.lat,
        destLon: unit.lon,
        action: "move",
      });
    } catch (error) {
      setActionDialog({ title: "이동 중지를 실패했습니다", message: messageOf(error) });
      return;
    }
    clearRoute(unitId);
    setMoveProgressMap((prev) => {
      const next = { ...prev };
      delete next[unitId];
      return next;
    });
    stopRequestedRef.current.add(unitId);
    removeMovingUnit(unitId);
    resumedMoveIdsRef.current.delete(unitId);
    await refreshUnits();
  };

  const resumeUnitMovement = async (unit: UnitInfo): Promise<void> => {
    const target = unit.moveTarget;
    if (
      !target ||
      movingUnitIdsRef.current.has(unit.id) ||
      resumedMoveIdsRef.current.has(unit.id)
    ) {
      return;
    }
    addMovingUnit(unit.id);
    try {
      if (target.endsAt <= Date.now()) {
        await refreshUnits();
        return;
      }
      // 서버 권위: 주문서에 확정 경로가 있으므로 재탐색 없이 그대로 렌더링한다.
      // 리로드 후 A* 재실행(프리징 원인)이 여기서 사라진다.
      const fromLat = target.fromLat ?? unit.lat;
      const fromLon = target.fromLon ?? unit.lon;
      const storedPath = target.path && target.path.length > 0 ? target.path : [];
      // 경로 없는 구 주문서는 경유점 직선이라도 표시한다 (선택 시 빈 화면 방지).
      const displayLine =
        storedPath.length > 0
          ? storedPath
          : [...(target.via ?? []), { lat: target.lat, lon: target.lon }];
      const durationMs = Math.max(1000, target.endsAt - target.startedAt);
      setMoveProgressMap((prev) => ({
        ...prev,
        [unit.id]: { startedAt: target.startedAt, durationMs, destLat: target.lat, destLon: target.lon },
      }));
      setMoveNow(Date.now());
      publishRouteLive(
        unit.id,
        [{ lat: fromLat, lon: fromLon }, ...displayLine],
        { lat: target.lat, lon: target.lon },
        true,
      );
      await animateUnitAlongPath(
        unit.id,
        fromLat,
        fromLon,
        storedPath,
        durationMs,
        target.startedAt,
        durationMs,
        target.lat,
        target.lon,
        true,
      );
      resumedMoveIdsRef.current.delete(unit.id);
    } finally {
      setFindingPathUnitId((current) => (current === unit.id ? null : current));
      setFindingProgress(null);
      clearRoute(unit.id);
      setMoveProgressMap((prev) => {
        const next = { ...prev };
        delete next[unit.id];
        return next;
      });
      removeMovingUnit(unit.id);
    }
  };

  useEffect(() => {
    resumeUnitMovementRef.current = resumeUnitMovement;
  });

  // useCallback이 아닌 일반 함수로 둔다 (openLordMovement와 동일하게 최신 컨텍스트를 참조하기 위해).
  const openUnitMovement = (unitId: string): void => {
    if (unitId === LORD_UNIT_ID) {
      openLordMovement();
      return;
    }
    const unit = units.find((item) => item.id === unitId);
    if (!unit || unit.state !== "field") {
      setActionDialog({
        title: "부대를 이동할 수 없습니다",
        message: unit?.state === "garrisoned" ? "주둔 중인 부대는 먼저 주둔을 해제해야 이동할 수 있습니다." : "현재 이동 가능한 부대가 아닙니다.",
      });
      return;
    }
    setSelectedUnit(unitId);
    setSheet("move");
  };

  useEffect(() => {
    if (!unitMarkerSelection) {
      return;
    }
    openUnitMovement(unitMarkerSelection.id);
    onUnitMarkerSelectionHandled();
  }, [unitMarkerSelection, onUnitMarkerSelectionHandled, openUnitMovement]);

  // 이동 중인 부대를 선택하면 그 부대의 경로·목적지를 표시한다.
  useEffect(() => {
    if (selectedUnit && movingUnitIds.includes(selectedUnit)) {
      publishRoute(selectedUnit);
    }
  }, [selectedUnit, movingUnitIds, publishRoute]);

  const activeUnitCount = units.filter((unit) => unit.state !== "dead").length;
  const showUnitList = true;
  const trainingRemainingMs =
    trainingUnit?.trainingCompleteAt !== undefined && trainingUnit.trainingCompleteAt !== null && trainingNow !== null
      ? Math.max(0, trainingUnit.trainingCompleteAt - trainingNow)
      : null;
  const trainingProgress =
    trainingRemainingMs === null
      ? 0
      : Math.min(100, Math.max(0, (1 - trainingRemainingMs / UNIT_TRAINING_DURATION_MS) * 100));
  const trainingSecondsRemaining =
    trainingRemainingMs === null ? null : Math.ceil(trainingRemainingMs / 1000);
  const trainingCountdownLabel =
    trainingSecondsRemaining === null
      ? "남은 시간 확인 중"
      : trainingSecondsRemaining === 0
        ? "완료 처리 중"
        : `${Math.floor(trainingSecondsRemaining / 60)}:${String(trainingSecondsRemaining % 60).padStart(2, "0")} 남음`;

  // 선택된 부대의 이동 진행률 (동시 이동 가능하므로 부대별 map에서 조회).
  const selectedMoveProgress =
    selectedUnit !== null ? moveProgressMap[selectedUnit] : undefined;
  const movingUnitName = selectedMoveProgress
    ? units.find((unit) => unit.id === selectedUnit)?.name ?? "부대"
    : null;
  // 유효 분모: 저장된 추정치와 (경과 + 현 위치→목적지 직선 잔여) 중 큰 값.
  // 직선 잔여가 0이 되기 전에는 100%가 될 수 없어, 도착 전 100% 고착이 생기지 않는다.
  const effectiveMoveDurationMs = (
    unitId: string,
    progress: { startedAt: number; durationMs: number; destLat: number; destLon: number },
    nowMs: number,
  ): number => {
    const elapsed = Math.max(0, nowMs - progress.startedAt);
    const unit = unitsRef.current.find((item) => item.id === unitId);
    if (!unit) {
      return progress.durationMs;
    }
    const kx = 111320 * Math.cos((unit.lat * Math.PI) / 180);
    const straightRemainMs =
      (Math.hypot(
        (progress.destLon - unit.lon) * kx,
        (progress.destLat - unit.lat) * 110540,
      ) / UNIT_SPEED_MPS) * 1000;
    return Math.max(progress.durationMs, elapsed + straightRemainMs);
  };
  const moveElapsedMs =
    selectedMoveProgress && moveNow !== null
      ? Math.max(0, moveNow - selectedMoveProgress.startedAt)
      : null;
  const selectedEffDurationMs =
    selectedMoveProgress && moveNow !== null && selectedUnit !== null
      ? effectiveMoveDurationMs(selectedUnit, selectedMoveProgress, moveNow)
      : null;
  const moveRemainingMs =
    moveElapsedMs === null || selectedEffDurationMs === null
      ? null
      : Math.max(0, selectedEffDurationMs - moveElapsedMs);
  const moveProgressPct =
    moveRemainingMs === null || selectedEffDurationMs === null || selectedEffDurationMs <= 0
      ? 0
      : Math.min(100, Math.max(0, ((selectedEffDurationMs - moveRemainingMs) / selectedEffDurationMs) * 100));
  // 영주 이동 종료(도착/중지) 시 경로 표시를 지운다.
  useEffect(() => {
    if (!props.lordMoveTarget) {
      clearRoute(LORD_UNIT_ID);
    }
  }, [props.lordMoveTarget, clearRoute]);
  const lordTarget = props.lordMoveTarget ?? null;
  const [, setLordTick] = useState(0);
  useEffect(() => {
    if (!lordTarget || Date.now() >= lordTarget.endsAt) {
      return;
    }
    const id = window.setInterval(() => {
      setLordTick((t) => t + 1);
      setMoveNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [lordTarget]);
  const lordActive = lordTarget !== null && Date.now() < lordTarget.endsAt;
  const lordProgressPct = (() => {
    if (!lordTarget) {
      return 0;
    }
    const total = Math.max(1, lordTarget.endsAt - lordTarget.startedAt);
    const elapsed = Math.max(0, Math.min(total, Date.now() - lordTarget.startedAt));
    return Math.min(100, (elapsed / total) * 100);
  })();
  const lordCountdownLabel = (() => {
    if (!lordTarget) {
      return "";
    }
    const remainSec = Math.max(0, Math.ceil((lordTarget.endsAt - Date.now()) / 1000));
    return `${Math.floor(remainSec / 60)}:${String(remainSec % 60).padStart(2, "0")}`;
  })();
  // 이동 목표 지정 중 지도 중앙까지의 거리를 마커 아래에 표시한다.
  const [targetCenter, setTargetCenter] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    if (sheet !== "move" || selectedUnit === null) {
      setTargetCenter(null);
      return;
    }
    const update = (): void => {
      const center = getMapCenter();
      if (!center) {
        return;
      }
      setTargetCenter((prev) => {
        if (prev) {
          const kx = 111320 * Math.cos((prev.lat * Math.PI) / 180);
          const moved = Math.hypot((center.lon - prev.lon) * kx, (center.lat - prev.lat) * 110540);
          if (moved < 1) {
            return prev;
          }
        }
        return center;
      });
    };
    update();
    const timerId = window.setInterval(update, 500);
    return () => window.clearInterval(timerId);
  }, [sheet, selectedUnit, getMapCenter]);
  const formatTargetDistance = (meters: number): string => {
    if (meters < 100) {
      return `${meters.toFixed(1)}m`;
    }
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    if (meters < 10000) {
      return `${(meters / 1000).toFixed(2)}km`;
    }
    return `${(meters / 1000).toFixed(1)}km`;
  };
  const targetDistanceLabel = (() => {
    if (sheet !== "move" || !selectedUnit || !targetCenter) {
      return null;
    }
    const unit = units.find((item) => item.id === selectedUnit);
    if (!unit) {
      return null;
    }
    const kx = 111320 * Math.cos((unit.lat * Math.PI) / 180);
    const distM = Math.hypot(
      (targetCenter.lon - unit.lon) * kx,
      (targetCenter.lat - unit.lat) * 110540,
    );
    return formatTargetDistance(distM);
  })();
  const moveCountdownLabelFor = (unitId: string): string => {
    const progress = moveProgressMap[unitId];
    if (!progress || moveNow === null) {
      return "도착 시간 확인 중";
    }
    const effDuration = effectiveMoveDurationMs(unitId, progress, moveNow);
    const remaining = Math.max(0, effDuration - Math.max(0, moveNow - progress.startedAt));
    const seconds = Math.ceil(remaining / 1000);
    if (seconds === 0) {
      return "도착 처리 중";
    }
    if (seconds >= 3600) {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}시간 ${minutes}분 후 도착`;
    }
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 후 도착`;
  };
  const moveProgressPctFor = (unitId: string): number => {
    const progress = moveProgressMap[unitId];
    if (!progress || moveNow === null) {
      return 0;
    }
    const effDuration = effectiveMoveDurationMs(unitId, progress, moveNow);
    if (effDuration <= 0) {
      return 0;
    }
    const elapsed = Math.max(0, moveNow - progress.startedAt);
    return Math.min(100, Math.max(0, (elapsed / effDuration) * 100));
  };
  const moveCountdownLabel = moveCountdownLabelFor(selectedUnit ?? "");
  const isSelectedUnitMoving = selectedUnit !== null && movingUnitIds.includes(selectedUnit);
  const isFindingPath = findingPathUnitId !== null && findingPathUnitId === selectedUnit;

  const explainTrainingBlock = (castleKeyArg?: string): string | null => {
    if (busy) {
      return "다른 작업을 처리 중입니다. 잠시 후 다시 시도해 주세요.";
    }
    if (hasUnitTraining) {
      return "이미 부대를 훈련 중입니다. 완료된 뒤 새 훈련을 시작할 수 있습니다.";
    }
    if (unitCap <= 0 || myClass === "slave") {
      return "평민 이상부터 부대를 훈련할 수 있습니다.";
    }
    if (activeUnitCount >= unitCap) {
      return `현재 계급의 부대 보유 한도(${unitCap}명)에 도달했습니다.`;
    }
    if (trainingCastlesLoading) {
      return "보유 성 목록을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.";
    }
    if (trainingCastlesError) {
      return "보유 성 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (trainingCastles.length === 0) {
      return "훈련을 시작하려면 먼저 활성화된 성을 보유해야 합니다.";
    }
    if (!(castleKeyArg ?? selectedTrainingCastle)) {
      return "훈련을 시작할 보유 성을 선택해 주세요.";
    }
    return null;
  };

  // 마커 다이얼로그가 열려 있으면 하단 기능 UI를 숨긴다 (상태는 유지, 닫히면 복원).
  if (props.markerDialogOpen) {
    return null;
  }

  return (
    <>
      {notice ? (
        <div className="fixed left-1/2 top-4 z-[1300] w-max max-w-[90vw] -translate-x-1/2 rounded-[16px] bg-slate-900/95 px-4 py-1.5 text-center text-sm font-black text-white">
          {notice}
        </div>
      ) : null}

      {actionDialog ? (
        <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-[#101713]/70 p-4">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="territory-action-dialog-title"
            aria-describedby="territory-action-dialog-message"
            className="w-full max-w-sm rounded-2xl border border-[#a77b35] bg-[#f2ead8] p-4 text-[#202821]"
          >
            <h2 id="territory-action-dialog-title" className="text-base font-black">
              {actionDialog.title}
            </h2>
            <p id="territory-action-dialog-message" className="mt-1.5 text-sm leading-6 text-[#4c554d]">
              {actionDialog.message}
            </p>
            <button
              type="button"
              autoFocus
              onClick={() => setActionDialog(null)}
              className={`${buttonPrimary} mt-3 w-full`}
            >
              확인
            </button>
          </section>
        </div>
      ) : null}

      {scoutResult ? (
        <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-[#101713]/70 p-4">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="territory-scout-dialog-title"
            className="w-full max-w-sm rounded-2xl border border-[#a77b35] bg-[#f2ead8] p-4 text-[#202821]"
          >
            <h2 id="territory-scout-dialog-title" className="text-base font-black">
              {scoutResult.unitName} 정찰 결과
            </h2>
            {scoutResult.castles.length === 0 ? (
              <p className="mt-1.5 text-sm leading-6 text-[#4c554d]">
                500m 안에 성이 없습니다.
              </p>
            ) : (
              <ul className="mt-1.5 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {scoutResult.castles.map((c) => (
                  <li
                    key={c.castleKey}
                    className="flex items-center justify-between gap-2 rounded-xl border border-[#8e7954]/35 bg-[#fffaf0] px-3 py-1.5"
                  >
                    <span className="truncate text-sm font-black text-slate-900">
                      {c.name}
                      {c.mine ? <span className="ml-1 text-xs font-bold text-[#526c49]">(내 성)</span> : null}
                    </span>
                    <span className="shrink-0 text-xs font-bold tabular-nums text-slate-500">
                      {c.distance >= 0 ? `${c.distance}m` : c.castleKey}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              autoFocus
              onClick={() => setScoutResult(null)}
              className={`${buttonPrimary} mt-3 w-full`}
            >
              확인
            </button>
          </section>
        </div>
      ) : null}

      {sheet === "move" && selectedUnit ? (
        <>
          {!isSelectedUnitMoving && !isFindingPath && !(isLordSelected && lordActive) ? (
            <div className="pointer-events-none fixed left-1/2 top-1/2 z-[1300] -translate-x-1/2 -translate-y-1/2" aria-hidden="true">
              <div className="unit-target-center-pin" />
              {targetDistanceLabel ? (
                <div className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-900/85 px-2 py-0.5 text-xs font-bold tabular-nums text-white">
                  {targetDistanceLabel}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-[1200] mx-auto w-auto max-w-xl rounded-[20px] border border-[#a77b35]/75 bg-[#f2ead8] p-2 text-[#202821]" role="dialog" aria-modal="false" aria-labelledby="unit-movement-title">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div>
                <p id="unit-movement-title" className="text-base font-black text-slate-900">{isLordSelected ? "영주 이동" : "부대 이동"}</p>
                {!isSelectedUnitMoving && !isLordSelected ? (
                  <p className="text-xs font-bold text-slate-600">{isLordSelected ? "영주 (나)" : units.find((unit) => unit.id === selectedUnit)?.name ?? "부대"}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isLordSelected
                  ? (() => {
                    const loc = props.getPlayerLocation();
                    if (!loc || isLocationVisible(loc.lat, loc.lon)) {
                      return null;
                    }
                    return (
                      <button
                        type="button"
                        onClick={() => panToLocation(loc.lat, loc.lon)}
                        className={buttonGhost}
                      >
                        내 위치로
                      </button>
                    );
                  })()
                  : null}
                {(() => {
                  void unitOffscreenTick;
                  const unit = units.find((item) => item.id === selectedUnit);
                  if (!unit || isLocationVisible(unit.lat, unit.lon)) {
                    return null;
                  }
                  return (
                    <button
                      type="button"
                      onClick={() => panToLocation(unit.lat, unit.lon)}
                      className={buttonGhost}
                    >
                      부대 위치로
                    </button>
                  );
                })()}
                <button type="button" onClick={() => setSheet(null)} className={buttonGhost}>닫기</button>
              </div>
            </div>
            {isLordSelected && lordActive ? (
              <div aria-live="polite" className="text-xs font-bold text-[#354b3c]">
                <p className="mb-1 truncate">
                  영주 이동 중 ·{" "}
                  <span className="tabular-nums">{lordCountdownLabel}</span>
                </p>
                <div
                  role="progressbar"
                  aria-label="영주 이동 진행도"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(lordProgressPct)}
                  className="relative h-5 overflow-hidden rounded-full bg-[#d1c5aa]"
                >
                  <div
                    className="h-full rounded-full bg-[#526c49] transition-[width] duration-500 ease-linear"
                    style={{ width: `${lordProgressPct}%` }}
                  />
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] font-black tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
                    {Math.floor(lordProgressPct)}%
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => stopLordMovement()}
                  className={`${buttonGhost} mt-1 w-full`}
                >
                  이동 중지
                </button>
              </div>
            ) : isFindingPath ? (
              <div aria-live="polite" className="flex items-center justify-center gap-2 py-1 text-sm font-bold text-[#354b3c]">
                <span
                  aria-hidden="true"
                  className="inline-block h-5 w-5 animate-spin rounded-full border-[3px] border-[#526c49]/30 border-t-[#526c49]"
                />
                <p>길 찾는 중{findingProgress ? ` (다리 ${findingProgress.done}/${findingProgress.total})` : ""}…</p>
              </div>
            ) : isSelectedUnitMoving ? (
              <div aria-live="polite" className="text-xs font-bold text-[#354b3c]">
                <p className="mb-1 truncate">
                  {movingUnitName ?? "부대"} 이동 중{selectedMoveProgress?.legLabel ? ` · ${selectedMoveProgress.legLabel}` : ""} ·{" "}
                  <span className="tabular-nums">{moveCountdownLabel}</span>
                </p>
                <div
                  role="progressbar"
                  aria-label="부대 이동 진행도"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(moveProgressPct)}
                  className="relative h-5 overflow-hidden rounded-full bg-[#d1c5aa]"
                >
                  <div
                    className="h-full rounded-full bg-[#526c49] transition-[width] duration-500 ease-linear"
                    style={{ width: `${moveProgressPct}%` }}
                  />
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] font-black tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
                    {Math.floor(moveProgressPct)}%
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedUnit) {
                      void stopUnitMovement(selectedUnit);
                    }
                  }}
                  className={`${buttonGhost} mt-1 w-full`}
                >
                  이동 중지
                </button>
              </div>
            ) : (
              <>
                <p className="mb-1.5 text-sm text-slate-700">지도를 움직여 화면 중앙에 목적지를 맞춘 뒤 이동을 누르세요.</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={moveSelectedToCenter}
                    disabled={busy}
                    className={buttonPrimary}
                  >
                    여기로 이동
                  </button>
                  <button type="button" onClick={() => setSheet(null)} className={buttonGhost}>
                    취소
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      ) : sheet !== null || castleKey ? null : (
        <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] left-3 right-20 z-[1100] mx-auto grid w-auto max-w-md grid-cols-2 gap-1 rounded-2xl border border-[#b9995d]/75 bg-[#14201f]/95 p-1.5">
          <button
            type="button"
            onClick={() => {
              setSheet("castles");
              onCloseCastle();
            }}
            className={`${buttonOriginal} flex items-center justify-center gap-2`}
          >
            <TerritoryActionIcon name="castle" />
            성
          </button>
          <button
            type="button"
            onClick={() => {
              void refreshUnits();
              void refreshTrainingCastles();
              setSheet("units");
              onCloseCastle();
            }}
            className={`${buttonOriginal} flex items-center justify-center gap-2`}
          >
            <TerritoryActionIcon name="unit" />
            부대
          </button>
          <button
            type="button"
            onClick={() => {
              setSheet("build");
              onCloseCastle();
            }}
            className={`${buttonOriginal} flex items-center justify-center gap-2`}
          >
            <TerritoryActionIcon name="build" />
            축성
          </button>
          <button
            type="button"
            onClick={() => void doHarvest()}
            disabled={busy}
            className={`${buttonOriginal} flex items-center justify-center gap-2`}
          >
            <TerritoryActionIcon name="harvest" />
            수확
          </button>
        </div>
      )}

      <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] right-3 z-[1100] flex w-[4.25rem] flex-col gap-1.5">
        {props.territoryStart ? (
          <button
            type="button"
            onClick={() => {
              if (props.territoryStart) {
                panToLocation(props.territoryStart.lat, props.territoryStart.lon);
              }
            }}
            title={`${props.territoryStart.sido} ${props.territoryStart.sigungu} ${props.territoryStart.dong}`}
            className={`${buttonGhost} w-full px-1 text-xs`}
          >
            시작지점
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void props.onResetScore()}
          className={`${buttonGhost} w-full px-1 text-xs`}
        >
          초기화
        </button>
        <button
          type="button"
          onClick={() => void props.onExit()}
          className="min-h-[33px] w-full rounded-xl bg-[#7a342b] px-1 py-1 text-xs font-black tracking-wide text-[#fff4d8] active:translate-y-0.5 active:bg-[#8c4034]"
        >
          나가기
        </button>
      </div>

      {sheet === "castles" ? (
        <div className={sheetStyle}>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-base font-black text-slate-900">나의 성</p>
            <button type="button" onClick={() => setSheet(null)} className={buttonGhost}>
              닫기
            </button>
          </div>
          {(() => {
            const owned = new Set(props.ownedCastleKeys ?? []);
            const mine = props.castlePoints.filter((p) => owned.has(p.eventKey));
            return mine.length === 0 ? (
              <p className="py-3 text-center text-sm text-slate-500">보유한 성이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {mine.map((p) => (
                <li key={p.eventKey}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenCastle(p.eventKey);
                      setSheet(null);
                    }}
                    className="w-full rounded-xl border border-[#8e7954]/35 bg-[#fffaf0] px-3 py-1 text-left active:bg-[#e7ddc6]"
                  >
                    <span className="block truncate text-sm font-black text-slate-900">
                      {props.castleNames?.[p.eventKey] || p.label || p.eventKey}{" "}
                      <span className="font-bold text-slate-500">
                        {props.castleNames?.[p.eventKey] || p.label ? p.eventKey : ""}
                      </span>
                    </span>
                  </button>
                </li>
                ))}
              </ul>
            );
          })()}
        </div>
      ) : null}

      {sheet === "units" ? (
        <div className={sheetStyle}>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-base font-black text-slate-900">
              부대 {units.filter((s) => s.state !== "dead").length}/{unitCap}
            </p>
            <button type="button" onClick={() => setSheet(null)} className={buttonGhost}>
              닫기
            </button>
          </div>
          {showUnitList ? (
            <>
              <div className="mb-1 rounded-xl border border-[#8e7954]/35 bg-[#fffaf0] p-1.5" data-lord-row="1">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const loc = props.getPlayerLocation();
                      if (loc) {
                        props.panToLocation(loc.lat, loc.lon);
                      }
                    }}
                    className="flex-1 text-left"
                  >
                    <span className="text-sm font-black text-slate-900">
                      영주 (나){lordActive ? " (이동 중)" : ""}
                    </span>
                  </button>
                  {lordActive ? (
                    <button
                      type="button"
                      onClick={() => stopLordMovement()}
                      disabled={busy}
                      className={buttonPrimary}
                    >
                      이동 중지
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openLordMovement()}
                      disabled={busy}
                      className={buttonPrimary}
                    >
                      이동
                    </button>
                  )}
                </div>
                {lordActive ? (
                  <div aria-live="polite" className="mt-1 text-xs font-bold text-[#354b3c]">
                    <p className="mb-1 truncate">
                      목적으로 이동 중 · <span className="tabular-nums">{lordCountdownLabel}</span>
                    </p>
                    <div
                      role="progressbar"
                      aria-label="영주 이동 진행도"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(lordProgressPct)}
                      className="relative h-4 overflow-hidden rounded-full bg-[#d1c5aa]"
                    >
                      <div
                        className="h-full rounded-full bg-[#526c49] transition-[width] duration-500 ease-linear"
                        style={{ width: `${lordProgressPct}%` }}
                      />
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-black tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
                        {Math.floor(lordProgressPct)}%
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
              {units.length === 0 ? (
              <p className="py-3 text-center text-sm text-slate-500">파견된 부대가 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-1">
              {units.map((s) => (
                <li key={s.id} className="rounded-xl border border-[#8e7954]/35 bg-[#fffaf0] p-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedUnit(selectedUnit === s.id ? null : s.id);
                        props.panToLocation(s.lat, s.lon);
                      }}
                      className="flex-1 text-left"
                    >
                      <span className="text-sm font-black text-slate-900">
                        {s.name} {s.state === "training" ? "(훈련 중)" : s.state === "garrisoned" ? "(주둔)" : s.state === "dead" ? "(사망)" : ""}
                      </span>
                    </button>
                    {s.state === "field" ? (
                      <>
                        {(() => {
                          // 15m 이내 무법자가 있으면 공격(퀴즈) 버튼을 보인다.
                          const prey = neutralUnits.find((n) => {
                            const rad = Math.PI / 180;
                            const dLat = (n.lat - s.lat) * rad;
                            const dLon = (n.lon - s.lon) * rad;
                            const a =
                              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                              Math.cos(s.lat * rad) *
                                Math.cos(n.lat * rad) *
                                Math.sin(dLon / 2) *
                                Math.sin(dLon / 2);
                            return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a))) <= 15;
                          });
                          return prey ? (
                            <button
                              type="button"
                              onClick={() => {
                                router.push("/map");
                              }}
                              disabled={busy || movingUnitIds.includes(s.id)}
                              className={buttonPrimary}
                            >
                              무법자 공격
                            </button>
                          ) : null;
                        })()}
                        <button
                          type="button"
                          onClick={() => {
                            openUnitMovement(s.id);
                          }}
                          disabled={busy || movingUnitIds.includes(s.id)}
                          className={buttonPrimary}
                        >
                          {movingUnitIds.includes(s.id) ? "이동 중" : "이동"}
                        </button>
                      </>
                    ) : null}
                  </div>
                  {s.state === "field" && movingUnitIds.includes(s.id) ? (
                    <div aria-live="polite" className="mt-1 text-xs font-bold text-[#354b3c]">
                      <p className="mb-1 truncate">
                        목적으로 이동 중 · <span className="tabular-nums">{moveCountdownLabelFor(s.id)}</span>
                      </p>
                      <div
                        role="progressbar"
                        aria-label="부대 이동 진행도"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(moveProgressPctFor(s.id))}
                        className="relative h-4 overflow-hidden rounded-full bg-[#d1c5aa]"
                      >
                        <div
                          className="h-full rounded-full bg-[#526c49] transition-[width] duration-500 ease-linear"
                          style={{ width: `${moveProgressPctFor(s.id)}%` }}
                        />
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-black tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
                          {Math.floor(moveProgressPctFor(s.id))}%
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void stopUnitMovement(s.id)}
                        className={`${buttonGhost} mt-1 w-full`}
                      >
                        이동 중지
                      </button>
                    </div>
                  ) : selectedUnit === s.id && s.state === "field" ? (
                    <div className="mt-1 grid grid-cols-4 gap-1">
                      <button
                        type="button"
                        onClick={() => void doUnitAct(s.id, "scout", s.lat, s.lon)}
                        disabled={busy || movingUnitIds.includes(s.id)}
                        className={buttonGhost}
                      >
                        정찰
                      </button>
                      {(() => {
                        // 부대 행동 표시 조건 (서버 규칙과 동일 100m):
                        // 공성은 적성 근처에서만, 수성/입성은 아성 근처에서만 보인다.
                        // 표시된 성 목록 기준이며 최종 판정은 서버가 한다.
                        const owned = new Set(props.ownedCastleKeys ?? []);
                        const near = (mine: boolean): boolean =>
                          props.castlePoints.some((c) => {
                            if (owned.has(c.eventKey) !== mine) {
                              return false;
                            }
                            const rad = Math.PI / 180;
                            const dLat = (c.lat - s.lat) * rad;
                            const dLon = (c.lon - s.lon) * rad;
                            const a =
                              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                              Math.cos(s.lat * rad) *
                                Math.cos(c.lat * rad) *
                                Math.sin(dLon / 2) *
                                Math.sin(dLon / 2);
                            return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a))) <= 100;
                          });
                        const off = busy || movingUnitIds.includes(s.id);
                        const needCastle = (fn: () => void) => () => {
                          if (!castleKey) {
                            flash("성을 먼저 여세요.");
                            return;
                          }
                          void fn();
                        };
                        return (
                          <>
                            {near(false) ? (
                              <button
                                type="button"
                                onClick={needCastle(() => doUnitAct(s.id, "siege", s.lat, s.lon))}
                                disabled={off}
                                className={buttonGhost}
                              >
                                공성
                              </button>
                            ) : null}
                            {near(true) ? (
                              <>
                                <button
                                  type="button"
                                  onClick={needCastle(() => doUnitAct(s.id, "defend", s.lat, s.lon))}
                                  disabled={off}
                                  className={buttonGhost}
                                >
                                  수성
                                </button>
                                <button
                                  type="button"
                                  onClick={needCastle(() => doUnitAct(s.id, "join", s.lat, s.lon))}
                                  disabled={off}
                                  className={buttonGhost}
                                >
                                  입성
                                </button>
                              </>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          </>
          ) : null}
        </div>
      ) : null}

      {sheet === "build" ? (
        <div className={sheetStyle}>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-base font-black text-slate-900">축성</p>
            <button type="button" onClick={() => setSheet(null)} className={buttonGhost}>
              닫기
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <input
              value={buildName}
              onChange={(e) => setBuildName(e.target.value)}
              placeholder="성 이름 (30자)"
              maxLength={30}
              className={inputStyle}
            />
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setBuildKind("noble")}
                disabled={!canBuildNoble}
                title={canBuildNoble ? "" : "귀족 이상만 축성 가능"}
                className={`${buildKind === "noble" ? buttonPrimary : buttonGhost} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                귀족성
              </button>
              <button
                type="button"
                onClick={() => setBuildKind("lord")}
                disabled={!canBuildLord}
                title={canBuildLord ? "" : "평민 이상만 창시 가능"}
                className={`${buildKind === "lord" ? buttonPrimary : buttonGhost} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                영주성
              </button>
            </div>
            {!canBuildNoble && buildKind === "noble" ? (
              <p className="text-xs text-amber-600">귀족 이상만 귀족성을 축성할 수 있습니다.</p>
            ) : null}
            {!canBuildLord && buildKind === "lord" ? (
              <p className="text-xs text-amber-600">평민 이상만 영주성을 창시할 수 있습니다.</p>
            ) : null}
            <SearchableDropdown
              label="퀴즈 문제풀"
              items={quizPools}
              value={buildPoolId}
              onChange={setBuildPoolId}
              placeholder="문제풀 선택"
              loading={poolsLoading}
              emptyText="일치하는 문제풀이 없습니다."
            />
            <SearchableDropdown
              label="웹이벤트 (게임)"
              items={webEvents}
              value={buildPoolId}
              onChange={setBuildPoolId}
              placeholder="웹이벤트 선택"
              loading={poolsLoading}
              emptyText="일치하는 웹이벤트가 없습니다."
            />
            {buildKind === "noble" ? (
              <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                HP
                <input
                  type="number"
                  min={2}
                  max={3}
                  value={buildHp}
                  onChange={(e) => setBuildHp(Number(e.target.value))}
                  className={inputStyle}
                />
              </label>
            ) : null}
            <p className="text-xs text-slate-500">
              지도에서 위치를 정해 세웁니다. 동(위치에서 자동 판별)·거리·잔액을 서버가 검증합니다.
            </p>
            {!buildName.trim() || buildPoolId === null ? (
              <p className="text-xs text-slate-500">
                성 이름과 이벤트(문제풀/웹이벤트)를 선택하면 위치를 정할 수 있습니다.
              </p>
            ) : null}
            <button
              type="button"
              disabled={
                busy ||
                !buildName.trim() ||
                buildPoolId === null ||
                (buildKind === "noble" ? !canBuildNoble : !canBuildLord)
              }
              onClick={() => {
                const poolId = buildPoolId;
                if (poolId === null || !buildName.trim()) {
                  return;
                }
                props.onStartPlacement({
                  name: buildName.trim(),
                  kind: buildKind,
                  poolId,
                  hp: buildHp,
                  dong: (props.dongCode ?? "").trim(),
                });
                setSheet(null);
              }}
              className={buttonPrimary}
            >
              성 위치 정하기
            </button>
          </div>
        </div>
      ) : null}

      {castleKey && sheet === null ? (
        <div className={sheetStyle}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-base font-black text-slate-900">
              {detailLoading ? "불러오는 중…" : (detail?.name ?? castleKey)}
            </p>
            <button type="button" onClick={onCloseCastle} className={buttonGhost}>
              닫기
            </button>
          </div>
          {detail ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-bold text-slate-700">
                {detail.kind === "lord" ? "영주성" : "귀족성"} · HP {detail.hp}/{detail.maxHp} ·
                소속 {detail.members.length}/{detail.capacity} · 주둔 +{detail.garrison * 2}
              </p>
              {detail.status !== "active" ? (
                <p className="text-xs text-amber-600">승인 대기 중인 성입니다.</p>
              ) : null}
              {detail.cooldownSec > 0 ? (
                <p className="text-xs text-slate-500">
                  공성 쿨다운 {Math.ceil(detail.cooldownSec / 60)}분 남음
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  disabled={busy || detail.isOwner}
                  onClick={() => {
                    window.location.href = `/event?eventkey=${encodeURIComponent(castleKey)}`;
                  }}
                  className={buttonPrimary}
                >
                  공성
                </button>
                {!detail.myMemberCastle ? (
                  <button
                    type="button"
                    disabled={busy || !canJoinHere}
                    onClick={() => void doJoin(false)}
                    className={buttonGhost}
                  >
                    입성
                  </button>
                ) : null}
              </div>
              {detail.isOwner ? (
                <p className="text-xs text-slate-500">자신의 성은 공성할 수 없습니다.</p>
              ) : null}
              {detail && !detail.myMemberCastle && castleDistM !== null && !canJoinHere ? (
                <p className="text-xs text-slate-500">
                  입성은 성 100m 이내에서 가능합니다 (현재{" "}
                  {castleDistM >= 1000
                    ? `${(castleDistM / 1000).toFixed(1)}km`
                    : `${Math.round(castleDistM)}m`}
                  ).
                </p>
              ) : null}
              {detail.myMemberCastle ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void doJoin(true)}
                  className={buttonGhost}
                >
                  이적하기 (100, 월 1회)
                </button>
              ) : null}
              {!detail.isOwner ? (
                <div className="rounded-xl border border-[#8e7954]/35 bg-[#e7ddc6] p-2">
                  <p className="mb-1.5 text-xs font-black tracking-widest text-slate-500">
                    결투 (약탈전, 기사 이상·1일 3회)
                  </p>
                  {duelBattle ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-xs text-slate-600">
                        {duelBattle.preview} 미니게임을 플레이한 뒤 결산하세요.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          runAction(async () => {
                            const gps = props.getPlayerLocation();
                            const data = (await callApi<Record<string, unknown>>(
                              "/api/territory/duel-resolve",
                              {
                                battleId: duelBattle.id,
                                lat: gps?.lat,
                                lon: gps?.lon,
                              },
                            )) as {
                              won?: unknown;
                              attack?: unknown;
                              defense?: unknown;
                              loot?: unknown;
                            };
                            setDuelBattle(null);
                            await refreshDetail(castleKey);
                            return data.won === true
                              ? `승리! 약탈 +${String(data.loot ?? 0)} (공격 ${String(data.attack ?? 0)} vs 수비 ${String(data.defense ?? 0)})`
                              : `패배 (공격 ${String(data.attack ?? 0)} vs 수비 ${String(data.defense ?? 0)})`;
                          })
                        }
                        className={buttonPrimary}
                      >
                        결산하기
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !playerLoc || !canDuelHere}
                      onClick={() =>
                        runAction(async () => {
                          if (!playerLoc) {
                            throw new Error("stale_location");
                          }
                          const data = (await callApi<Record<string, unknown>>(
                            "/api/territory/challenge",
                            { castleKey, lat: playerLoc.lat, lon: playerLoc.lon },
                          )) as { battleId?: unknown; defensePreview?: unknown };
                          if (typeof data.battleId !== "string") {
                            throw new Error("challenge_failed");
                          }
                          const preview = data.defensePreview as {
                            power?: unknown;
                          } | null;
                          setDuelBattle({
                            id: data.battleId,
                            preview:
                              preview && typeof preview.power === "number"
                                ? `예상 수비 ${preview.power.toFixed(1)}. `
                                : "수비 정보 없음. ",
                          });
                          return "결투 신청됨. 미니게임 플레이 후 결산하세요.";
                        })
                      }
                      className={buttonGhost}
                    >
                        결투 신청
                      </button>
                  )}
                  {castleDistM !== null && !canDuelHere ? (
                    <p className="text-xs text-slate-500">
                      결투는 성 500m 이내에서 신청할 수 있습니다.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {detail.myPending ? (
                <p className="text-xs text-slate-500">승인 대기 중입니다.</p>
              ) : null}
              {detail.isOwner ? (
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void doHarvest(castleKey)}
                    disabled={busy}
                    className={buttonGhost}
                  >
                    수확
                  </button>
                  <button
                    type="button"
                    onClick={() => setSheet("manage")}
                    className={buttonGhost}
                  >
                    관리
                  </button>
                  <button
                    type="button"
                    onClick={() => void refreshDetail(castleKey)}
                    disabled={busy}
                    className={buttonGhost}
                  >
                    새로고침
                  </button>
                </div>
              ) : null}
              {detail.isOwner && detail.status === "active" ? (
                <div className="mt-1 rounded-xl border border-[#a77b35]/60 bg-[#e7ddc6] p-1.5">
                  <p className="mb-1 text-sm font-black text-slate-900">부대 훈련</p>
                  {hasUnitTraining ? (
                    <div aria-live="polite" className="text-xs font-bold text-[#354b3c]">
                      <p className="mb-1 truncate">
                        {trainingUnit?.name ?? "부대"} · 훈련 중 ·{" "}
                        <span className="tabular-nums">{trainingCountdownLabel}</span>
                      </p>
                      <div
                        role="progressbar"
                        aria-label="부대 훈련 진행도"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(trainingProgress)}
                        className="relative h-4 overflow-hidden rounded-full bg-[#d1c5aa]"
                      >
                        <div
                          className="h-full rounded-full bg-[#526c49] transition-[width] duration-1000 ease-linear"
                          style={{ width: `${trainingProgress}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <input
                        value={unitTrainingName}
                        onChange={(event) => setUnitTrainingName(event.target.value.slice(0, 12))}
                        maxLength={12}
                        placeholder="부대 이름 (선택)"
                        aria-label="훈련할 부대 이름"
                        className={`${inputStyle} mb-1.5`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!castleKey) {
                            return;
                          }
                          const reason = explainTrainingBlock(castleKey);
                          if (reason) {
                            setActionDialog({ title: "부대 훈련을 시작할 수 없습니다", message: reason });
                            return;
                          }
                          void startUnitTraining(castleKey, detail.name);
                        }}
                        aria-label="부대 훈련 시작, 영향력 50, 훈련 시간 30분"
                        className={buttonPrimary}
                      >
                        훈련 시작 · 영향력 50 · 30분
                      </button>
                    </>
                  )}
                </div>
              ) : null}
              <div className="mt-1">
                <p className="mb-1 text-xs font-black tracking-widest text-slate-500">소속원</p>
                {detail.members.length === 0 ? (
                  <p className="text-xs text-slate-500">없음</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {detail.members.slice(0, 8).map((m) => (
                      <li key={m.userId} className="text-xs text-slate-700">
                        {m.nickname} · {m.classId}
                        {m.isOwner ? " (주인)" : ""}
                      </li>
                    ))}
                    {detail.members.length > 8 ? (
                      <li className="text-xs text-slate-500">+{detail.members.length - 8}명</li>
                    ) : null}
                  </ul>
                )}
              </div>
            </div>
          ) : detailLoading ? null : (
            <p className="py-4 text-center text-sm text-slate-500">불러오지 못했습니다.</p>
          )}
        </div>
      ) : null}

      {sheet === "manage" && detail?.isOwner ? (
        <div className={sheetStyle}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-base font-black text-slate-900">성 관리</p>
            <button type="button" onClick={() => setSheet(null)} className={buttonGhost}>
              닫기
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                성문 하한
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={manageDiff[0]}
                  onChange={(e) => setManageDiff([Number(e.target.value), manageDiff[1]])}
                  className={inputStyle}
                />
              </label>
              <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                성문 상한
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={manageDiff[1]}
                  onChange={(e) => setManageDiff([manageDiff[0], Number(e.target.value)])}
                  className={inputStyle}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setManageJoinMode("auto")}
                className={manageJoinMode === "auto" ? buttonPrimary : buttonGhost}
              >
                자동 승인
              </button>
              <button
                type="button"
                onClick={() => setManageJoinMode("manual")}
                className={manageJoinMode === "manual" ? buttonPrimary : buttonGhost}
              >
                주인 승인
              </button>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                runAction(async () => {
                  if (!castleKey) {
                    return null;
                  }
                  await callApi("/api/castles/manage", {
                    castleKey,
                    difficulty: manageDiff,
                    joinMode: manageJoinMode,
                  });
                  await refreshDetail(castleKey);
                  return "저장했습니다. (성문 변경 100)";
                })
              }
              className={buttonPrimary}
            >
              저장
            </button>
            <ManagePanels
              castleKey={castleKey ?? ""}
              members={detail.members}
              appointTarget={appointTarget}
              setAppointTarget={setAppointTarget}
              pendingList={pendingList}
              setPendingList={setPendingList}
              runAction={runAction}
              busy={busy}
              flash={flash}
              refreshDetail={refreshDetail}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ManagePanels(props: {
  castleKey: string;
  members: CastleMember[];
  appointTarget: string;
  setAppointTarget: (v: string) => void;
  pendingList: { userId: string; nickname: string; requestedAt: number }[];
  setPendingList: (v: { userId: string; nickname: string; requestedAt: number }[]) => void;
  runAction: (fn: () => Promise<string | null>) => Promise<void>;
  busy: boolean;
  flash: (m: string) => void;
  refreshDetail: (key: string) => Promise<void>;
}) {
  const {
    castleKey,
    members,
    appointTarget,
    setAppointTarget,
    pendingList,
    setPendingList,
    runAction,
    busy,
    refreshDetail,
  } = props;

  useEffect(() => {
    let cancelled = false;
    void callApi<{ pending: { userId: string; nickname: string; requestedAt: number }[] }>(
      `/api/castles/approve?castleKey=${encodeURIComponent(castleKey)}`,
    )
      .then((data) => {
        if (!cancelled) {
          setPendingList(Array.isArray(data.pending) ? data.pending : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPendingList([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [castleKey, setPendingList]);

  return (
    <>
      <div>
        <p className="mb-1 text-xs font-black tracking-widest text-slate-500">
          승인 대기 ({pendingList.length})
        </p>
        {pendingList.length === 0 ? (
          <p className="text-xs text-slate-500">없음</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pendingList.map((p) => (
              <li key={p.userId} className="flex items-center gap-2">
                <span className="flex-1 text-xs font-bold text-slate-700">{p.nickname}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    runAction(async () => {
                      await callApi("/api/castles/approve", {
                        castleKey,
                        targetUserId: p.userId,
                        action: "approve",
                      });
                      setPendingList(pendingList.filter((x) => x.userId !== p.userId));
                      await refreshDetail(castleKey);
                      return "승인했습니다.";
                    })
                  }
                  className={buttonPrimary}
                >
                  승인
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    runAction(async () => {
                      await callApi("/api/castles/approve", {
                        castleKey,
                        targetUserId: p.userId,
                        action: "reject",
                      });
                      setPendingList(pendingList.filter((x) => x.userId !== p.userId));
                      return "거절했습니다.";
                    })
                  }
                  className={buttonGhost}
                >
                  거절
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-black tracking-widest text-slate-500">귀족 임면 (영주성)</p>
        <div className="flex gap-1.5">
          <select
            value={appointTarget}
            onChange={(e) => setAppointTarget(e.target.value)}
            className={inputStyle}
          >
            <option value="">대상 선택</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.nickname} · {m.classId}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={busy || !appointTarget}
            onClick={() =>
              runAction(async () => {
                await callApi("/api/castles/appoint", {
                  castleKey,
                  targetUserId: appointTarget,
                  action: "appoint",
                });
                await refreshDetail(castleKey);
                return "임명했습니다.";
              })
            }
            className={buttonGhost}
          >
            임명
          </button>
          <button
            type="button"
            disabled={busy || !appointTarget}
            onClick={() =>
              runAction(async () => {
                await callApi("/api/castles/appoint", {
                  castleKey,
                  targetUserId: appointTarget,
                  action: "dismiss",
                });
                await refreshDetail(castleKey);
                return "해임했습니다.";
              })
            }
            className={buttonGhost}
          >
            해임
          </button>
        </div>
      </div>
    </>
  );
}
