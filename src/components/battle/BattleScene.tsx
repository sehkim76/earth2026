"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { COMMANDER_KIND_LABEL, MAX_MANA, getCard, heroPower } from "@/lib/battle";
import type { Action, AttackerRef, PublicBattleView, SideIndex, Soldier, TargetRef } from "@/lib/battle";

import { BattleAnimator } from "@/components/battle/battle-animator";
import type { AnimHost } from "@/components/battle/battle-animator";
import { BattleCardBack, BattleCardFace, CardText, classVars } from "@/components/battle/BattleCardFace";
import { BattleHelp, readCoachOff, readHelpSeen, writeCoachOff, writeHelpSeen } from "@/components/battle/BattleHelp";
import { describeCard, describeCommander, describePower, describeSoldier, KEYWORD_HELP } from "@/components/battle/card-help";
import type { HelpInfo } from "@/components/battle/card-help";
import { BattleResultPanel } from "@/components/battle/BattleResultPanel";
import type { BattleSource } from "@/components/battle/battle-source";
import { FxEngine } from "@/components/battle/fx";
import { PixelArt, commanderArtKey } from "@/components/battle/PixelArt";
import { useBattle } from "@/components/battle/use-battle";
import {
  ENEMY,
  PLAYER,
  attackTargets,
  canPlayCard,
  cardCost,
  cardTargets,
  commanderReady,
  hasAnyMove,
  isMyTurn,
  powerTargets,
  powerUsable,
  refKey,
  safeCard,
  soldierReady,
} from "@/components/battle/view-rules";
import styles from "@/components/battle/battle.module.css";

export interface BattleSceneProps {
  initial: PublicBattleView;
  source: BattleSource;
  /** 전투를 그대로 둔 채 지도로 돌아가기 (없으면 버튼 숨김) */
  onExit?: () => void;
  /** 결과 화면에서 확인을 누름 */
  onFinished: (view: PublicBattleView) => void;
}

/** 설명 패널에 띄울 대상 */
type InfoTarget =
  | { kind: "hand"; iid: number }
  | { kind: "sol"; iid: number }
  | { kind: "cmd"; side: SideIndex }
  | { kind: "power"; side: SideIndex };

type Aim =
  | { kind: "card"; iid: number }
  | { kind: "attacker"; attacker: AttackerRef }
  | { kind: "power" };

interface Gesture {
  pointerId: number;
  key: string | null;
  startX: number;
  startY: number;
  moved: boolean;
  drag: Aim | null;
  longTimer: number;
  inspected: boolean;
}

const TURN_MS = 45_000;

// ---------------------------------------------------------------------------
// 배경: 전투 위치 위성 타일 (흐리게) + 성벽/들판
// ---------------------------------------------------------------------------

function tileXY(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

function SatelliteBackdrop({ lat, lon }: { lat: number; lon: number }) {
  const tiles = useMemo(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const z = 17;
    const c = tileXY(lat, lon, z);
    const out: string[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        out.push(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${c.y + dy}/${c.x + dx}`);
      }
    }
    return out;
  }, [lat, lon]);
  return (
    <div className={styles.sat} aria-hidden="true">
      <div className={styles.satGrid}>
        {tiles.map((url) => (
          <div key={url} style={{ backgroundImage: `url(${url})` }} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 턴 타이머 (서버 마감 기준)
// ---------------------------------------------------------------------------

function TurnTimer({ deadline, now, active }: { deadline: number; now: () => number; active: boolean }) {
  const ringRef = useRef<SVGCircleElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const C = 2 * Math.PI * 30;
    const tick = (): void => {
      const left = Math.max(0, deadline - now());
      const k = active ? Math.min(1, left / TURN_MS) : 0;
      if (ringRef.current) {
        ringRef.current.style.strokeDasharray = `${C}`;
        ringRef.current.style.strokeDashoffset = `${C * (1 - k)}`;
        ringRef.current.style.stroke = left < 10_000 ? "#ff5a4a" : left < 20_000 ? "#ffc54a" : "#ffe9a8";
      }
      if (textRef.current) textRef.current.textContent = active ? `${Math.ceil(left / 1000)}` : "";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deadline, now, active]);
  return (
    <>
      <svg className={styles.timerRing} viewBox="0 0 68 68" aria-hidden="true">
        <circle cx="34" cy="34" r="30" className={styles.timerTrack} />
        <circle ref={ringRef} cx="34" cy="34" r="30" className={styles.timerFill} />
      </svg>
      <span ref={textRef} className={styles.timerText} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 병사·지휘관
// ---------------------------------------------------------------------------

interface SoldierTokenProps {
  sol: Soldier;
  ready: boolean;
  target: boolean;
  selected: boolean;
  dim: boolean;
}

function SoldierToken({ sol, ready, target, selected, dim }: SoldierTokenProps) {
  const def = safeCard(sol.cardId);
  if (!def) return null;
  const guard = sol.keywords.includes("guard");
  const shield = sol.keywords.includes("shield");
  const ranged = sol.keywords.includes("ranged");
  const rush = sol.keywords.includes("rush") || sol.rushThisTurn;
  const hurt = sol.health < sol.maxHealth;
  const atkUp = sol.attack > (def.attack ?? 0);
  const hpUp = sol.maxHealth > (def.health ?? 0) && !hurt;
  return (
    <div className={styles.solWrap} data-bkey={`sol-${sol.iid}`} data-flip="1">
      <div
        className={[
          styles.sol,
          guard ? styles.solGuard : "",
          ready ? styles.solReady : "",
          target ? styles.isTarget : "",
          selected ? styles.isSelected : "",
          dim ? styles.solDim : "",
        ].join(" ")}
        style={classVars(def.cardClass)}
      >
        {guard ? <div className={styles.guardCrown} aria-hidden="true" /> : null}
        <div className={styles.solArt}>
          <PixelArt name={def.artKey} scale={2} />
        </div>
        <div className={styles.solKw}>
          {guard ? <span className={styles.kwChip}>{KEYWORD_HELP.guard.name}</span> : null}
          {shield ? <span className={styles.kwChip}>{KEYWORD_HELP.shield.name}</span> : null}
          {ranged ? <span className={styles.kwChip}>{KEYWORD_HELP.ranged.name}</span> : null}
          {rush ? <span className={styles.kwChip}>{KEYWORD_HELP.rush.name}</span> : null}
          {def.onDeath ? <span className={styles.kwChip}>유훈</span> : null}
        </div>
        {shield ? <div className={styles.shieldBubble} aria-hidden="true" /> : null}
        <div className={`${styles.solStat} ${styles.solStatL}`} title="공격력">
          <span className={styles.statLbl}>ATK</span>
          <div className={`${styles.solAtk} ${atkUp ? styles.statUp : ""}`}>{sol.attack}</div>
        </div>
        <div className={`${styles.solStat} ${styles.solStatR}`} title="체력">
          <span className={styles.statLbl}>HP</span>
          <div className={`${styles.solHp} ${hurt ? styles.statHurt : hpUp ? styles.statUp : ""}`}>{Math.max(0, sol.health)}</div>
        </div>
      </div>
    </div>
  );
}

interface CommanderProps {
  view: PublicBattleView;
  side: SideIndex;
  target: boolean;
  ready: boolean;
  selected: boolean;
}

function CommanderBadge({ view, side, target, ready, selected }: CommanderProps) {
  const c = view.sides[side].commander;
  const hurt = c.hp < c.maxHp;
  return (
    <div className={`${styles.cmd} ${side === PLAYER ? styles.cmdMine : styles.cmdEnemy}`}>
      <div
        data-bkey={`cmd-${side}`}
        className={[styles.cmdFrame, target ? styles.isTarget : "", ready ? styles.solReady : "", selected ? styles.isSelected : ""].join(" ")}
      >
        <PixelArt name={commanderArtKey(c.kind)} scale={2.5} />
      </div>
      <div className={styles.cmdName}>
        {c.name || COMMANDER_KIND_LABEL[c.kind]} <span>Lv.{c.level}</span>
      </div>
      <div className={`${styles.cmdHp} ${hurt ? styles.statHurt : ""}`} title="지휘관 체력">
        <PixelArt name="ic-health" scale={1.75} />
        {Math.max(0, c.hp)}
      </div>
      {c.armor > 0 ? (
        <div className={styles.cmdArmor} data-bkey={`armor-${side}`} title="방어도 (체력보다 먼저 깎임)">
          <PixelArt name="ic-armor" scale={1.75} />
          {c.armor}
        </div>
      ) : null}
      <div className={styles.weaponSlot} data-bkey={`weapon-${side}`}>
        {c.weapon ? (
          <>
            <PixelArt name={getCard(c.weapon.cardId).artKey} scale={1.25} />
            <span className={styles.weaponAtk} title="무기 공격력">{c.weapon.attack}</span>
            <span className={styles.weaponDur} title="남은 사용 횟수">{c.weapon.durability}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ManaBar({ view, side }: { view: PublicBattleView; side: SideIndex }) {
  const sd = view.sides[side];
  const pips = Math.max(MAX_MANA, sd.maxMana, sd.mana);
  return (
    <div className={`${styles.mana} ${side === ENEMY ? styles.manaEnemy : styles.manaMine}`} data-bkey={`mana-${side}`}>
      <div className={styles.manaPips}>
        {Array.from({ length: pips }, (_, i) => (
          <span
            key={i}
            className={i < sd.mana ? styles.pipFull : i < sd.maxMana ? styles.pipSpent : styles.pipLocked}
          />
        ))}
      </div>
      <span className={styles.manaText}>
        <span className={styles.manaWord}>마나</span> {sd.mana}/{sd.maxMana}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 설명 패널 (누른 카드·병사·지휘관을 글로 풀어 준다)
// ---------------------------------------------------------------------------

function HelpBody({ info }: { info: HelpInfo }) {
  return (
    <>
      <div className={styles.infoHead}>
        <span className={styles.infoTag}>{info.tag}</span>
        <b>{info.title}</b>
      </div>
      {info.stats.length > 0 ? (
        <div className={styles.infoStats}>
          {info.stats.map((st) => (
            <span key={st.label} className={st.tone === "up" ? styles.statUp : st.tone === "down" ? styles.infoDown : ""}>
              <PixelArt name={st.icon} scale={1.5} />
              {st.label} <b>{st.value}</b>
            </span>
          ))}
        </div>
      ) : null}
      {info.text ? (
        <div className={styles.infoText}>
          <CardText text={info.text} />
        </div>
      ) : null}
      {info.terms.map((t) => (
        <div key={t.name} className={styles.infoTerm}>
          <PixelArt name={t.icon} scale={1.5} />
          <b>{t.name}</b>
          <span>{t.desc}</span>
        </div>
      ))}
      {info.tip ? <div className={styles.infoTip}>{info.tip}</div> : null}
    </>
  );
}

function infoForKey(key: string | null): InfoTarget | null {
  if (!key) return null;
  if (key.startsWith("hand-")) return { kind: "hand", iid: Number(key.slice(5)) };
  if (key.startsWith("sol-")) return { kind: "sol", iid: Number(key.slice(4)) };
  if (key === "cmd-0" || key === "armor-0" || key === "weapon-0") return { kind: "cmd", side: 0 };
  if (key === "cmd-1" || key === "armor-1" || key === "weapon-1") return { kind: "cmd", side: 1 };
  if (key === "power-1") return { kind: "power", side: 1 };
  return null;
}

/** 지금 해 볼 만한 일 (처음 하는 사람 안내) */
function coachText(v: PublicBattleView): string | null {
  if (v.winner !== null || !isMyTurn(v)) return null;
  const me = v.sides[PLAYER];
  const hand = me.hand ?? [];
  if (hand.some((c) => canPlayCard(v, c))) {
    return `마나 ${me.mana}개가 있어요. 빛나는 카드를 위로 끌어 내세요. (누르면 설명)`;
  }
  if (commanderReady(v) || me.board.some((b) => soldierReady(v, b))) {
    return "빛나는 병사를 적에게 끌어 공격하세요. 서로 공격력만큼 체력이 깎여요.";
  }
  if (powerUsable(v)) return "오른쪽 아래 지휘관 능력을 쓸 수 있어요.";
  return "할 일을 다 했어요. '턴 종료'를 누르세요.";
}

// ---------------------------------------------------------------------------
// 장면
// ---------------------------------------------------------------------------

function closestKey(el: Element | null): string | null {
  const hit = el?.closest<HTMLElement>("[data-bkey]");
  return hit?.dataset.bkey ?? null;
}

function cardIdForKey(v: PublicBattleView, key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith("hand-")) {
    const iid = Number(key.slice(5));
    return v.sides[PLAYER].hand?.find((c) => c.iid === iid)?.cardId ?? null;
  }
  if (key.startsWith("sol-")) {
    const iid = Number(key.slice(4));
    return [...v.sides[0].board, ...v.sides[1].board].find((b) => b.iid === iid)?.cardId ?? null;
  }
  return null;
}

function keyToRef(v: PublicBattleView, key: string | null): TargetRef | null {
  if (!key) return null;
  if (key === "cmd-0") return { kind: "commander", side: 0 };
  if (key === "cmd-1") return { kind: "commander", side: 1 };
  if (key.startsWith("sol-")) {
    const iid = Number(key.slice(4));
    for (const side of [0, 1] as const) {
      if (v.sides[side].board.some((b) => b.iid === iid)) return { kind: "soldier", side, iid };
    }
  }
  return null;
}

function aimTargets(v: PublicBattleView, aim: Aim | null): TargetRef[] {
  if (!aim) return [];
  if (aim.kind === "attacker") return attackTargets(v);
  if (aim.kind === "power") return powerTargets(v) ?? [];
  const card = v.sides[PLAYER].hand?.find((c) => c.iid === aim.iid);
  return card ? (cardTargets(v, card) ?? []) : [];
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function BattleScene({ initial, source, onExit, onFinished }: BattleSceneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const shakeRef = useRef<HTMLDivElement>(null);
  const fxLayerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<SVGPathElement>(null);
  const arrowHeadRef = useRef<SVGPolygonElement>(null);
  const handZoneRef = useRef<HTMLDivElement>(null);
  const animatorRef = useRef<BattleAnimator | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const reduced = useReducedMotion();

  const getAnimator = useCallback(() => animatorRef.current, []);
  const battle = useBattle({ source, initial, getAnimator });
  const { view, busy, send, refresh, commit, getView, showToast, setLog } = battle;

  const [sel, setSel] = useState<Aim | null>(null);
  const [drag, setDrag] = useState<Aim | null>(null);
  const [dragCardIid, setDragCardIid] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ cardId: string; side: SideIndex } | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const [concedeArmed, setConcedeArmed] = useState(false);
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [coachOff, setCoachOff] = useState(false);

  // 처음 전투면 도움말을 먼저 띄운다. 안내 문구 끄기 설정을 읽는다.
  useEffect(() => {
    setCoachOff(readCoachOff());
    if (!readHelpSeen() && initial.winner === null) setHelpOpen(true);
    // 최초 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [vw, setVw] = useState(390);

  // 연출기 준비
  useEffect(() => {
    const root = rootRef.current;
    const shakeEl = shakeRef.current;
    const fxLayer = fxLayerRef.current;
    const canvas = canvasRef.current;
    if (!root || !shakeEl || !fxLayer || !canvas) return;
    const fx = new FxEngine(canvas);
    fx.density = reduced ? 0.35 : 1;
    const host: AnimHost = {
      root,
      shakeEl,
      fxLayer,
      fx,
      reduced,
      getView,
      commit,
      setPreview: (p) => setPreview(p),
      log: setLog,
    };
    animatorRef.current = new BattleAnimator(host);
    const onResize = (): void => {
      fx.resize();
      setVw(window.innerWidth);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      fx.destroy();
      animatorRef.current = null;
    };
  }, [reduced, getView, commit, setLog]);

  // 시작 연출: 손패를 덱에서 나눠 준다
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const deck = root.querySelector('[data-bkey="deck-0"]')?.getBoundingClientRect();
    const cards = root.querySelectorAll<HTMLElement>('[data-bkey^="hand-"]');
    cards.forEach((el, i) => {
      if (!deck) return;
      const r = el.getBoundingClientRect();
      el.animate(
        [
          {
            transform: `translate(${deck.left - r.left}px, ${deck.top - r.top}px) scale(0.4)`,
            opacity: 0,
          },
          { transform: "translate(0,0) scale(1)", opacity: 1 },
        ],
        { duration: 420, delay: 150 + i * 110, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" },
      );
    });
    // 최초 한 번만
  }, []);

  // 턴 마감이 지나면 서버에 다시 물어본다 (서버가 턴을 자동 종료)
  useEffect(() => {
    if (view.winner !== null || view.activeSide !== PLAYER || busy) return;
    const left = view.turnDeadline - source.now() + 3500;
    const id = window.setTimeout(() => void refresh(), Math.max(500, left));
    return () => window.clearTimeout(id);
  }, [view.turnDeadline, view.activeSide, view.winner, busy, refresh, source]);

  // 턴이 바뀌면 설명 패널을 닫는다 (상대 턴 연출을 가리지 않게)
  useEffect(() => {
    setInfo(null);
  }, [view.activeSide]);

  // 항복 확인 해제
  useEffect(() => {
    if (!concedeArmed) return;
    const id = window.setTimeout(() => setConcedeArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [concedeArmed]);

  const locked = busy || !isMyTurn(view);
  const aim = drag ?? sel;
  const targetKeys = useMemo(() => new Set(aimTargets(view, aim).map(refKey)), [view, aim]);
  const me = view.sides[PLAYER];
  const foe = view.sides[ENEMY];
  const hand = useMemo(() => me.hand ?? [], [me.hand]);
  const finished = view.winner !== null && !busy;

  // 행동 보내기
  const [pendingIid, setPendingIid] = useState<number | null>(null);
  const act = useCallback(
    (action: Action) => {
      setSel(null);
      setInfo(null);
      // 낸 카드는 응답이 올 때까지 손패에서 숨긴다 (되돌아오는 깜빡임 방지)
      if (action.type === "playCard") setPendingIid(action.iid);
      void send(action).finally(() => setPendingIid(null));
    },
    [send],
  );

  const boardPosAt = (x: number): number => {
    const root = rootRef.current;
    if (!root) return me.board.length;
    let pos = 0;
    me.board.forEach((b) => {
      const el = root.querySelector(`[data-bkey="sol-${b.iid}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.left + r.width / 2 < x) pos += 1;
    });
    return pos;
  };

  /** 대상 지정 중인 선택을 key 대상에 적용. 적용했으면 true */
  const resolveAim = (a: Aim, key: string | null, x: number): boolean => {
    const v = getView();
    const ref = keyToRef(v, key);
    const valid = ref ? aimTargets(v, a).some((t) => refKey(t) === refKey(ref)) : false;
    if (a.kind === "attacker") {
      if (ref && valid) {
        act({ type: "attack", attacker: a.attacker, target: ref });
        return true;
      }
      if (ref && ref.side === ENEMY) showToast("수호 병사부터 공격해야 합니다.", "info");
      return false;
    }
    if (a.kind === "power") {
      if (ref && valid) {
        act({ type: "heroPower", target: ref });
        return true;
      }
      return false;
    }
    const card = v.sides[PLAYER].hand?.find((c) => c.iid === a.iid);
    if (!card) return false;
    const def = getCard(card.cardId);
    const targets = cardTargets(v, card);
    if (targets === null || (targets.length === 0 && def.type === "soldier")) {
      act({ type: "playCard", iid: card.iid, ...(def.type === "soldier" ? { boardPos: boardPosAt(x) } : {}) });
      return true;
    }
    if (ref && valid) {
      act({ type: "playCard", iid: card.iid, target: ref, ...(def.type === "soldier" ? { boardPos: boardPosAt(x) } : {}) });
      return true;
    }
    return false;
  };

  const isMineReady = (key: string | null): AttackerRef | null => {
    const v = getView();
    if (key === "cmd-0" && commanderReady(v)) return { kind: "commander" };
    if (key?.startsWith("sol-")) {
      const iid = Number(key.slice(4));
      const s = v.sides[PLAYER].board.find((b) => b.iid === iid);
      if (s && soldierReady(v, s)) return { kind: "soldier", iid };
    }
    return null;
  };

  const updateAimVisual = (g: Gesture, x: number, y: number): void => {
    const root = rootRef.current;
    const ghost = ghostRef.current;
    const path = arrowRef.current;
    const head = arrowHeadRef.current;
    if (!root || !g.drag) return;
    const rr = root.getBoundingClientRect();
    const handTop = handZoneRef.current?.getBoundingClientRect().top ?? rr.bottom;
    let showArrow = false;
    let from: { x: number; y: number } | null = null;
    if (g.drag.kind === "card") {
      const v = getView();
      const card = v.sides[PLAYER].hand?.find((c) => c.iid === (g.drag as { iid: number }).iid);
      const targets = card ? cardTargets(v, card) : null;
      const aiming = targets !== null && targets.length > 0 && y < handTop - 30;
      if (ghost) {
        ghost.style.opacity = aiming ? "0" : "1";
        ghost.style.transform = `translate(${x - rr.left}px, ${y - rr.top}px) translate(-50%, -60%) rotate(${Math.max(-12, Math.min(12, (x - g.startX) * 0.05))}deg)`;
      }
      if (aiming) {
        showArrow = true;
        from = { x: g.startX, y: handTop - 10 };
      }
    } else {
      showArrow = true;
      const el = g.key ? root.querySelector(`[data-bkey="${g.key}"]`) : null;
      const r = el?.getBoundingClientRect();
      from = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: g.startX, y: g.startY };
    }
    if (path && head) {
      if (showArrow && from) {
        const fx = from.x - rr.left;
        const fy = from.y - rr.top;
        const tx = x - rr.left;
        const ty = y - rr.top;
        const mx = (fx + tx) / 2;
        const my = Math.min(fy, ty) - Math.abs(tx - fx) * 0.25 - 30;
        path.setAttribute("d", `M ${fx} ${fy} Q ${mx} ${my} ${tx} ${ty}`);
        const ang = Math.atan2(ty - my, tx - mx);
        const s = 14;
        head.setAttribute(
          "points",
          `${tx + Math.cos(ang) * 4},${ty + Math.sin(ang) * 4} ${tx - Math.cos(ang - 0.5) * s},${ty - Math.sin(ang - 0.5) * s} ${tx - Math.cos(ang + 0.5) * s},${ty - Math.sin(ang + 0.5) * s}`,
        );
        path.style.display = "";
        head.style.display = "";
      } else {
        path.style.display = "none";
        head.style.display = "none";
      }
    }
  };

  const endGesture = (): void => {
    const g = gestureRef.current;
    if (g) window.clearTimeout(g.longTimer);
    gestureRef.current = null;
    setDrag(null);
    setDragCardIid(null);
    if (arrowRef.current) arrowRef.current.style.display = "none";
    if (arrowHeadRef.current) arrowHeadRef.current.style.display = "none";
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const t = e.target as Element;
    if (t.closest("button") || t.closest("[data-bmodal]")) return;
    if (gestureRef.current) return;
    const key = closestKey(t);
    const g: Gesture = {
      pointerId: e.pointerId,
      key,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      drag: null,
      longTimer: 0,
      inspected: false,
    };
    const cardId = cardIdForKey(getView(), key);
    if (cardId) {
      g.longTimer = window.setTimeout(() => {
        if (gestureRef.current === g && !g.moved) {
          g.inspected = true;
          setInspect(cardId);
        }
      }, 420);
    }
    gestureRef.current = g;
    try {
      rootRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // 무시
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 10) {
      g.moved = true;
      window.clearTimeout(g.longTimer);
      if (g.inspected) return;
      const v = getView();
      if (!busy && isMyTurn(v)) {
        if (g.key?.startsWith("hand-")) {
          const iid = Number(g.key.slice(5));
          const card = v.sides[PLAYER].hand?.find((c) => c.iid === iid);
          if (card && canPlayCard(v, card)) {
            g.drag = { kind: "card", iid };
            setDrag(g.drag);
            setDragCardIid(iid);
            setSel(null);
          }
        } else {
          const atk = isMineReady(g.key);
          if (atk) {
            g.drag = { kind: "attacker", attacker: atk };
            setDrag(g.drag);
            setSel(null);
          }
        }
      }
    }
    if (g.drag) updateAimVisual(g, e.clientX, e.clientY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.inspected) {
      setInspect(null);
      endGesture();
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    const under = document.elementFromPoint(x, y);
    const key = closestKey(under);
    const drag0 = g.drag;
    endGesture();
    if (busy || !isMyTurn(getView())) {
      if (!g.moved) setInfo(infoForKey(g.key));
      return;
    }
    if (drag0) {
      if (drag0.kind === "card") {
        const handTop = handZoneRef.current?.getBoundingClientRect().top ?? Infinity;
        if (y > handTop - 6) return; // 손패로 되돌림
        if (!resolveAim(drag0, key, x)) {
          setSel(drag0);
          showToast("대상을 고르세요.", "info");
        }
      } else {
        resolveAim(drag0, key, x);
      }
      return;
    }
    // 탭
    const tapKey = g.key;
    const v = getView();
    if (sel) {
      if (tapKey?.startsWith("hand-")) {
        const iid = Number(tapKey.slice(5));
        if (sel.kind === "card" && sel.iid === iid) {
          setSel(null);
          setInfo(null);
          return;
        }
      } else {
        const zone = (under?.closest<HTMLElement>("[data-bzone]")?.dataset.bzone ?? null) as string | null;
        if (resolveAim(sel, tapKey, x)) return;
        if (sel.kind === "card" && zone === "0") {
          const card = v.sides[PLAYER].hand?.find((c) => c.iid === sel.iid);
          if (card && cardTargets(v, card) !== null) {
            showToast("대상을 고르세요.", "info");
            return;
          }
        }
      }
    }
    if (tapKey?.startsWith("hand-")) {
      const iid = Number(tapKey.slice(5));
      const card = v.sides[PLAYER].hand?.find((c) => c.iid === iid);
      if (!card) return;
      setInfo({ kind: "hand", iid });
      if (canPlayCard(v, card)) setSel({ kind: "card", iid });
      else {
        setSel(null);
        showToast(cardCost(v, PLAYER, card) > v.sides[PLAYER].mana ? "마나가 부족합니다." : "지금은 낼 수 없습니다.", "info");
      }
      return;
    }
    const atk = isMineReady(tapKey);
    setInfo(infoForKey(tapKey));
    if (atk) {
      setSel({ kind: "attacker", attacker: atk });
      return;
    }
    setSel(null);
  };

  const onPointerCancel = (): void => {
    setInspect(null);
    endGesture();
  };

  const onPower = (): void => {
    setInfo({ kind: "power", side: PLAYER });
    if (locked) return;
    if (!powerUsable(view)) {
      showToast(view.sides[PLAYER].commander.powerUsedThisTurn ? "이번 턴에 이미 사용했습니다." : "지금은 쓸 수 없습니다.", "info");
      return;
    }
    if (powerTargets(view)) {
      setSel(sel?.kind === "power" ? null : { kind: "power" });
      return;
    }
    act({ type: "heroPower" });
  };

  const onEndTurn = (): void => {
    if (locked) return;
    act({ type: "endTurn" });
  };

  const onConcede = (): void => {
    if (busy || view.winner !== null) return;
    if (!concedeArmed) {
      setConcedeArmed(true);
      showToast("한 번 더 누르면 항복합니다.", "info");
      return;
    }
    setConcedeArmed(false);
    act({ type: "concede" });
  };

  // 손패 부채꼴 배치
  const handCardW = Math.min(112, Math.max(84, Math.round(vw * 0.25)));
  const handLayout = useMemo(() => {
    const n = hand.length;
    const avail = Math.min(vw, 520) - 24 - handCardW;
    const step = n > 1 ? Math.min(handCardW * 0.78, avail / (n - 1)) : 0;
    const mid = (n - 1) / 2;
    return hand.map((c, i) => ({
      iid: c.iid,
      left: (i - mid) * step,
      rot: (i - mid) * (n > 5 ? 4 : 5),
      drop: Math.abs(i - mid) ** 2 * 2.2,
    }));
  }, [hand, vw, handCardW]);

  const myPower = heroPower(me.commander.kind, me.commander.level);
  const foePower = heroPower(foe.commander.kind, foe.commander.level);
  const selCard = sel?.kind === "card" ? hand.find((c) => c.iid === sel.iid) : undefined;
  const hint = (() => {
    if (!isMyTurn(view) && view.winner === null) return "적이 작전을 짜는 중…";
    if (!sel) return null;
    if (sel.kind === "attacker") return "공격할 적을 고르세요";
    if (sel.kind === "power") return `${myPower.name}: 대상을 고르세요`;
    if (selCard) {
      const def = getCard(selCard.cardId);
      const ts = cardTargets(view, selCard);
      if (ts && ts.length > 0) return `${def.name}: 대상을 고르세요`;
      return def.type === "soldier" ? `${def.name}: 필드에 놓으세요` : `${def.name}: 위로 끌거나 필드를 누르세요`;
    }
    return null;
  })();

  const infoHelp: HelpInfo | null = (() => {
    if (!info) return null;
    if (info.kind === "hand") {
      const card = hand.find((c) => c.iid === info.iid);
      if (!card) return null;
      const cost = cardCost(view, PLAYER, card);
      const d = describeCard(card.cardId, cost);
      if (!d) return null;
      let tip: string;
      if (!isMyTurn(view)) tip = "내 턴에 낼 수 있습니다.";
      else if (cost > me.mana) tip = `마나가 부족합니다. (필요 ${cost} · 남은 마나 ${me.mana})`;
      else if (!canPlayCard(view, card)) tip = getCard(card.cardId).type === "soldier" ? "필드가 가득 찼습니다 (최대 5)." : "지금은 쓸 대상이 없습니다.";
      else if ((cardTargets(view, card) ?? []).length > 0) tip = "빛나는 대상을 누르거나 그 위로 끌어 놓으세요.";
      else tip = getCard(card.cardId).type === "soldier" ? "위로 끌어 필드에 놓거나, 내 필드를 누르세요." : "위로 끌어 놓거나, 필드를 누르면 사용됩니다.";
      return { ...d, tip };
    }
    if (info.kind === "sol") {
      for (const side of [PLAYER, ENEMY] as const) {
        const b = view.sides[side].board.find((x) => x.iid === info.iid);
        if (b) return describeSoldier(b, side === PLAYER, isMyTurn(view));
      }
      return null;
    }
    if (info.kind === "cmd") return describeCommander(view.sides[info.side].commander, info.side === PLAYER);
    return describePower(view.sides[info.side].commander, info.side === PLAYER);
  })();
  // 적을 겨누는 중이면 설명을 내 쪽에, 아니면 적 쪽 위에 띄워 대상을 가리지 않는다
  const infoLow = [...targetKeys].some((k) => k === "cmd-1" || foe.board.some((b) => `sol-${b.iid}` === k));
  const coach = !coachOff && !sel && !drag && !infoHelp ? coachText(view) : null;

  const rootStyle = { "--hand-w": `${handCardW}px` } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${reduced ? styles.reduced : ""}`}
      style={rootStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="카드 전투"
    >
      <SatelliteBackdrop lat={view.target.lat} lon={view.target.lon} />
      <div className={styles.field} aria-hidden="true">
        <div className={styles.fieldGrass} />
        <div className={styles.fieldWall} />
        <div className={styles.fieldRoad} />
        <PixelArt name="banner-enemy" scale={2} className={styles.bannerL} />
        <PixelArt name="banner-enemy" scale={2} className={styles.bannerR} />
        <div className={styles.vignette} />
      </div>

      <div ref={shakeRef} className={styles.layout}>
        {/* 적 진영 */}
        <div className={styles.enemyHud}>
          <div className={styles.enemyHand} data-bkey="ehand">
            {Array.from({ length: foe.handCount }, (_, i) => (
              <div
                key={i}
                className={styles.ebackWrap}
                data-bkey={`eback-${i}`}
                data-flip="1"
                style={{ left: `${(i - (foe.handCount - 1) / 2) * 17}px`, rotate: `${(i - (foe.handCount - 1) / 2) * 6}deg` }}
              >
                <BattleCardBack width={32} />
              </div>
            ))}
          </div>
          <div className={styles.deckPile} data-bkey="deck-1" title="적 덱">
            <PixelArt name="ic-deck" scale={2} />
            <span>덱 {foe.deckCount}</span>
          </div>
          <CommanderBadge view={view} side={ENEMY} target={targetKeys.has("cmd-1")} ready={false} selected={false} />
          <div className={styles.enemyRight}>
            <ManaBar view={view} side={ENEMY} />
            <div className={styles.foePower} data-bkey="power-1" title={`${foePower.name}: ${foePower.text}`}>
              <PixelArt name="ic-power" scale={2} />
              <span>{foePower.name}</span>
            </div>
          </div>
        </div>

        <div className={styles.boardRow} data-bzone="1">
          {foe.board.map((b) => (
            <SoldierToken key={b.iid} sol={b} ready={false} target={targetKeys.has(`sol-${b.iid}`)} selected={false} dim={false} />
          ))}
        </div>

        <div className={styles.midline}>
          <div className={styles.logLine}>{hint ?? battle.log ?? `${view.target.name} 토벌전`}</div>
          <button
            type="button"
            className={`${styles.endTurn} ${isMyTurn(view) && !hasAnyMove(view) ? styles.endTurnGlow : ""}`}
            disabled={locked}
            onClick={onEndTurn}
          >
            <TurnTimer deadline={view.turnDeadline} now={source.now} active={view.winner === null} />
            <span className={styles.endTurnLabel}>{isMyTurn(view) ? "턴 종료" : "적 턴"}</span>
          </button>
        </div>

        <div className={styles.boardRow} data-bzone="0">
          {me.board.map((b) => (
            <SoldierToken
              key={b.iid}
              sol={b}
              ready={!locked && soldierReady(view, b)}
              target={targetKeys.has(`sol-${b.iid}`)}
              selected={aim?.kind === "attacker" && aim.attacker.kind === "soldier" && aim.attacker.iid === b.iid}
              dim={b.summonedThisTurn && !b.keywords.includes("rush") && !b.rushThisTurn && isMyTurn(view)}
            />
          ))}
        </div>

        {/* 내 진영 */}
        <div className={styles.myHud}>
          <div className={styles.myLeft}>
            <div className={styles.deckPile} data-bkey="deck-0" title="내 덱">
              <PixelArt name="ic-deck" scale={2} />
              <span>덱 {me.deckCount}</span>
            </div>
            <ManaBar view={view} side={PLAYER} />
          </div>
          <CommanderBadge
            view={view}
            side={PLAYER}
            target={targetKeys.has("cmd-0")}
            ready={!locked && commanderReady(view)}
            selected={aim?.kind === "attacker" && aim.attacker.kind === "commander"}
          />
          <button
            type="button"
            data-bkey="power-0"
            className={[
              styles.powerBtn,
              !locked && powerUsable(view) ? styles.powerReady : "",
              me.commander.powerUsedThisTurn ? styles.powerUsed : "",
              sel?.kind === "power" ? styles.isSelected : "",
            ].join(" ")}
            onClick={onPower}
            disabled={busy}
            title={`${myPower.name}: ${myPower.text}`}
          >
            <PixelArt name="ic-power" scale={2.5} />
            <span className={styles.powerName}>{myPower.name}</span>
            <span className={styles.powerCost}>{myPower.cost}</span>
          </button>
        </div>

        <div ref={handZoneRef} className={styles.handZone}>
          {handLayout.map((h) => {
            const card = hand.find((c) => c.iid === h.iid);
            if (!card) return null;
            const playable = !locked && canPlayCard(view, card);
            const selected = sel?.kind === "card" && sel.iid === h.iid;
            return (
              <div
                key={h.iid}
                data-bkey={`hand-${h.iid}`}
                data-card={card.cardId}
                data-flip="1"
                className={styles.handSlot}
                style={{ left: `calc(50% + ${h.left}px - ${handCardW / 2}px)`, zIndex: selected ? 50 : 10 }}
              >
                <div
                  className={[
                    styles.handCard,
                    playable ? styles.playable : "",
                    selected ? styles.handSelected : "",
                    dragCardIid === h.iid ? styles.handDragging : "",
                    pendingIid === h.iid ? styles.handPending : "",
                  ].join(" ")}
                  style={{ "--rot": `${h.rot}deg`, "--drop": `${h.drop}px` } as CSSProperties}
                >
                  <BattleCardFace cardId={card.cardId} width={handCardW} cost={cardCost(view, PLAYER, card)} compact />
                </div>
              </div>
            );
          })}
        </div>

        {inspect ? null : infoHelp ? (
          <div className={`${styles.info} ${infoLow ? styles.infoLow : ""}`} aria-live="polite">
            <HelpBody info={infoHelp} />
          </div>
        ) : coach ? (
          <div className={`${styles.coach} ${styles.infoLow}`}>{coach}</div>
        ) : null}
      </div>

      {/* 끌기 중인 카드 */}
      <div ref={ghostRef} className={styles.ghost} aria-hidden="true">
        {dragCardIid !== null && hand.find((c) => c.iid === dragCardIid) ? (
          <BattleCardFace
            cardId={hand.find((c) => c.iid === dragCardIid)?.cardId ?? ""}
            width={Math.round(handCardW * 1.15)}
            compact
          />
        ) : null}
      </div>

      <svg className={styles.arrowLayer} aria-hidden="true">
        <path ref={arrowRef} className={styles.arrowPath} style={{ display: "none" }} />
        <polygon ref={arrowHeadRef} className={styles.arrowHead} style={{ display: "none" }} />
      </svg>

      <canvas ref={canvasRef} className={styles.fxCanvas} aria-hidden="true" />
      <div ref={fxLayerRef} className={styles.fxLayer} aria-hidden="true" />

      {preview ? (
        <div className={styles.previewWrap}>
          <div data-bkey="preview" className={`${styles.preview} ${preview.side === ENEMY ? styles.previewEnemy : ""}`}>
            <BattleCardFace cardId={preview.cardId} width={Math.min(210, Math.round(vw * 0.52))} />
          </div>
          <div className={styles.previewLabel}>{preview.side === ENEMY ? "적의 카드" : "사용"}</div>
        </div>
      ) : null}

      {inspect ? (
        <div className={styles.previewWrap}>
          <div className={styles.preview}>
            <BattleCardFace cardId={inspect} width={Math.min(230, Math.round(vw * 0.58))} />
          </div>
          {(() => {
            const d = describeCard(inspect);
            return d ? (
              <div className={styles.inspectHelp}>
                <HelpBody info={{ ...d, stats: [] }} />
              </div>
            ) : null;
          })()}
        </div>
      ) : null}

      {/* 상단 메뉴: 도움말·지도로·항복을 하나로 접어 적 진영을 가리지 않게 */}
      <div className={styles.topButtons}>
        <button
          type="button"
          className={`${styles.smallBtn} ${styles.menuBtn}`}
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((o) => !o);
            setConcedeArmed(false);
          }}
        >
          {menuOpen ? "✕ 닫기" : "☰ 메뉴"}
        </button>
        {menuOpen ? (
          <div className={styles.menuList}>
            <button
              type="button"
              className={`${styles.smallBtn} ${styles.helpBtn}`}
              onClick={() => {
                setMenuOpen(false);
                setHelpOpen(true);
              }}
            >
              ? 도움말
            </button>
            {onExit ? (
              <button type="button" className={styles.smallBtn} onClick={onExit}>
                지도로
              </button>
            ) : null}
            {view.winner === null ? (
              <button type="button" className={`${styles.smallBtn} ${concedeArmed ? styles.smallBtnDanger : ""}`} onClick={onConcede}>
                {concedeArmed ? "정말 항복" : "항복"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {busy ? <div className={styles.busyDot} aria-label="처리 중" /> : null}

      {battle.toast ? (
        <div key={battle.toast.id} className={`${styles.toast} ${battle.toast.tone === "info" ? styles.toastInfo : ""}`} role="status">
          {battle.toast.text}
        </div>
      ) : null}

      {helpOpen ? (
        <BattleHelp
          coachOff={coachOff}
          onCoachChange={(off) => {
            setCoachOff(off);
            writeCoachOff(off);
          }}
          onClose={() => {
            setHelpOpen(false);
            writeHelpSeen();
          }}
        />
      ) : null}

      {finished ? <BattleResultPanel view={view} reduced={reduced} onConfirm={() => onFinished(view)} /> : null}
    </div>
  );
}
