"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  unitStats,
  type AutoFormation,
  type AutoSkillEvent,
  type AutoTickEvent,
  type AutoUnitKind,
} from "@/lib/auto-battle";

import type { AutoBattleStartResult } from "@/components/battle/auto-battle-api";
import { loadSfxMuted, playSfx, setSfxMuted } from "@/components/battle/auto-battle-sfx";
import { FxEngine, type Point } from "@/components/battle/fx";
import { PixelArt } from "@/components/battle/PixelArt";

const KIND_LABEL: Record<AutoUnitKind, string> = {
  lord: "영주",
  infantry: "보병",
  archer: "궁병",
  cavalry: "기병",
  mage: "마법",
};

/** 병종별 효과 색 (피격 입자·스킬 빛기둥) */
const KIND_FX: Record<AutoUnitKind, string[]> = {
  lord: ["#ffe28a", "#ffc23d", "#fff6cf"],
  infantry: ["#cfe3ff", "#8fb6ea", "#ffffff"],
  archer: ["#f2e2b0", "#c9a35c", "#ffffff"],
  cavalry: ["#ffb27a", "#ff7f45", "#ffe0c2"],
  mage: ["#d1a8ff", "#9a6bff", "#f3e6ff"],
};

export function autoSkillName(kind: AutoUnitKind): string {
  if (kind === "lord") return "전군 격려";
  if (kind === "infantry") return "방벽";
  if (kind === "archer") return "조준 사격";
  if (kind === "cavalry") return "돌격";
  return "마법 작렬";
}

export function skillEffectText(kind: AutoUnitKind): string {
  if (kind === "lord") return "아군 전체 공격력 +1, 체력 +1";
  if (kind === "infantry") return "아군 전체 체력 2 회복";
  if (kind === "archer") return "적 하나에 3 피해";
  if (kind === "cavalry") return "아군 전체 공격력 +1";
  return "적 전체에 1 피해";
}

interface UnitBox {
  kind: AutoUnitKind;
  name: string;
  level: number;
  maxHp: number;
  hp: number;
  atk: number;
  alive: boolean;
  empty: boolean;
}

type Sides = [UnitBox[], UnitBox[]];

function deploy(formation: AutoFormation): UnitBox[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const slot = formation[i];
    if (!slot) {
      return { kind: "infantry" as AutoUnitKind, name: "", level: 1, maxHp: 0, hp: 0, atk: 0, alive: false, empty: true };
    }
    const stats = unitStats(slot);
    return {
      kind: slot.kind,
      name: slot.name,
      level: slot.level,
      maxHp: stats.maxHp,
      hp: stats.maxHp,
      atk: stats.atk,
      alive: true,
      empty: false,
    };
  });
}

/** 스킬을 쓰는 선두 = 편성의 첫 칸 */
function leadIdx(units: UnitBox[]): number {
  const i = units.findIndex((u) => !u.empty);
  return i < 0 ? 0 : i;
}

interface Step {
  tick: number;
  skills: AutoSkillEvent[];
  /** 스킬 피해 (attackerIdx -1) */
  skillHits: Array<{ ev: AutoTickEvent; seq: number }>;
  attacks: Array<{ ev: AutoTickEvent; seq: number }>;
}

function buildTimeline(events: AutoTickEvent[], skills: AutoSkillEvent[]): Step[] {
  const byTick = new Map<number, Step>();
  const get = (tick: number): Step => {
    let s = byTick.get(tick);
    if (!s) {
      s = { tick, skills: [], skillHits: [], attacks: [] };
      byTick.set(tick, s);
    }
    return s;
  };
  for (const sk of skills) get(sk.tick).skills.push(sk);
  events.forEach((ev, seq) => {
    const step = get(ev.tick);
    if (ev.attackerIdx < 0) step.skillHits.push({ ev, seq });
    else step.attacks.push({ ev, seq });
  });
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

/** 스킵용: 모든 기록을 적용한 최종 상태 */
function finalSides(result: AutoBattleStartResult, skills: AutoSkillEvent[]): Sides {
  const sides: Sides = [deploy(result.attacker), deploy(result.defender)];
  for (const step of buildTimeline(result.events, skills)) {
    for (const sk of step.skills) {
      sk.self.forEach((s, i) => {
        const u = sides[sk.side][i];
        if (u && !u.empty) Object.assign(u, { hp: s.hp, maxHp: s.maxHp, atk: s.atk, alive: s.alive });
      });
    }
    for (const { ev } of [...step.skillHits, ...step.attacks]) {
      const u = sides[ev.attackerSide === 0 ? 1 : 0][ev.targetIdx];
      if (u && !u.empty) {
        u.hp = ev.targetHpAfter;
        if (ev.killed) u.alive = false;
      }
    }
  }
  return sides;
}

interface AutoBattleSceneProps {
  result: AutoBattleStartResult;
  onFinished: () => void;
}

const SPEEDS = [1, 2, 4] as const;
/** 1배속 기준 한 턴 길이 */
const TICK_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** 오토배틀 재생: 픽셀 병사 + 공격 궤적·피해 숫자·사망·스킬 연출 + 합성 효과음. */
export function AutoBattleScene({ result, onFinished }: AutoBattleSceneProps) {
  const skills = useMemo(() => result.skills ?? [], [result]);
  const timeline = useMemo(() => buildTimeline(result.events, skills), [result, skills]);
  const lastTick = timeline.length > 0 ? (timeline[timeline.length - 1]?.tick ?? 0) : 0;
  const enemyIsOutlaw = result.defenderTier !== null;

  const [sides, setSides] = useState<Sides>(() => [deploy(result.attacker), deploy(result.defender)]);
  const [turn, setTurn] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [done, setDone] = useState(false);
  const [muted, setMuted] = useState(false);
  const [banner, setBanner] = useState<{ side: 0 | 1; title: string; text: string; key: number } | null>(null);
  const [outcome, setOutcome] = useState<"win" | "lose" | "draw" | null>(null);

  const fieldRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<Array<Array<HTMLDivElement | null>>>([[], []]);
  const fxRef = useRef<FxEngine | null>(null);
  const speedRef = useRef<number>(1);
  const skipRef = useRef(false);
  const reducedRef = useRef(false);
  const appliedSeq = useRef(new Map<string, number>());
  const finishRef = useRef<() => void>(() => {});
  const kindsRef = useRef<[AutoUnitKind[], AutoUnitKind[]]>([
    deploy(result.attacker).map((u) => u.kind),
    deploy(result.defender).map((u) => u.kind),
  ]);

  useEffect(() => {
    setMuted(loadSfxMuted());
  }, []);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // 캔버스 입자 엔진
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    reducedRef.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const fx = new FxEngine(canvas);
    fx.density = reducedRef.current ? 0.35 : 1;
    fxRef.current = fx;
    const onResize = (): void => fx.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      fx.destroy();
      fxRef.current = null;
    };
  }, []);

  // 재생 루프 (한 번만 돈다. 배속은 speedRef로, 스킵은 skipRef로 반영)
  useEffect(() => {
    let cancelled = false;
    const stopped = (): boolean => cancelled || skipRef.current;
    const ms = (base: number): number => base / speedRef.current;

    const cell = (side: 0 | 1, idx: number): HTMLDivElement | null => cellRefs.current[side]?.[idx] ?? null;
    const centerOf = (el: HTMLElement | null): Point | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };

    const floatText = (at: Point | null, text: string, cls: string, big = false): void => {
      const layer = floatRef.current;
      if (!layer || !at) return;
      const base = layer.getBoundingClientRect();
      const el = document.createElement("span");
      el.textContent = text;
      el.className = `pointer-events-none absolute whitespace-nowrap font-black ${cls}`;
      el.style.left = `${at.x - base.left + (Math.random() * 16 - 8)}px`;
      el.style.top = `${at.y - base.top - 10}px`;
      el.style.fontSize = big ? "22px" : "17px";
      el.style.textShadow = "0 2px 0 #000, 0 0 6px rgba(0,0,0,0.8)";
      layer.appendChild(el);
      const anim = el.animate(
        [
          { transform: "translate(-50%,-50%) scale(0.6)", opacity: 0 },
          { transform: "translate(-50%,-90%) scale(1.15)", opacity: 1, offset: 0.2 },
          { transform: "translate(-50%,-220%) scale(1)", opacity: 0 },
        ],
        { duration: Math.max(450, ms(900)), easing: "ease-out" },
      );
      anim.onfinish = () => el.remove();
    };

    const shakeField = (strength: number): void => {
      if (reducedRef.current) return;
      fieldRef.current?.animate(
        [
          { transform: "translate(0,0)" },
          { transform: `translate(${strength}px,${-strength / 2}px)` },
          { transform: `translate(${-strength}px,${strength / 2}px)` },
          { transform: "translate(0,0)" },
        ],
        { duration: 180 },
      );
    };

    const applyHit = (side: 0 | 1, idx: number, hpAfter: number, killed: boolean, seq: number): void => {
      const key = `${side}:${idx}`;
      if ((appliedSeq.current.get(key) ?? -1) > seq) return;
      appliedSeq.current.set(key, seq);
      setSides((prev) => {
        const next: Sides = [prev[0].slice(), prev[1].slice()];
        const u = next[side][idx];
        if (u) next[side][idx] = { ...u, hp: killed ? 0 : hpAfter, alive: killed ? false : u.alive };
        return next;
      });
    };

    /** 피격: 흔들림·번쩍·입자·숫자·체력 반영, 처치면 쓰러짐 */
    const impact = (ev: AutoTickEvent, seq: number, attackerKind: AutoUnitKind | null): void => {
      const tSide: 0 | 1 = ev.attackerSide === 0 ? 1 : 0;
      const el = cell(tSide, ev.targetIdx);
      const at = centerOf(el);
      const sprite = el?.querySelector<HTMLElement>("[data-sprite]");
      sprite?.animate(
        [
          { transform: "translateX(0)", filter: "brightness(1)" },
          { transform: "translateX(-5px)", filter: "brightness(2.4) sepia(1) hue-rotate(-50deg) saturate(5)" },
          { transform: "translateX(5px)", filter: "brightness(1.6)" },
          { transform: "translateX(0)", filter: "brightness(1)" },
        ],
        { duration: 240 },
      );
      if (at) {
        fxRef.current?.burst(at, attackerKind ? KIND_FX[attackerKind] : ["#ffffff", "#ffd27a"], ev.counterBonus ? 16 : 9, {
          speed: ev.counterBonus ? 220 : 160,
          size: 4,
          life: 0.45,
        });
      }
      floatText(
        at,
        ev.counterBonus ? `-${ev.damage} 상성!` : `-${ev.damage}`,
        ev.counterBonus ? "text-amber-300" : "text-red-400",
        ev.counterBonus,
      );
      playSfx(ev.counterBonus ? "crit" : "hit");
      if (ev.counterBonus) shakeField(3);
      applyHit(tSide, ev.targetIdx, ev.targetHpAfter, ev.killed, seq);
      if (ev.killed) {
        if (at) {
          fxRef.current?.burst(at, ["#8a8a8a", "#d9d9d9", "#b33a2e", "#5a4a3a"], 24, {
            speed: 240,
            size: 5,
            life: 0.8,
            shard: true,
            up: 80,
          });
        }
        playSfx("death");
        shakeField(5);
      }
    };

    const playAttack = async (ev: AutoTickEvent, seq: number): Promise<void> => {
      const aSide = ev.attackerSide;
      const tSide: 0 | 1 = aSide === 0 ? 1 : 0;
      const kind = kindsRef.current[aSide][ev.attackerIdx] ?? "infantry";
      const aEl = cell(aSide, ev.attackerIdx);
      const tEl = cell(tSide, ev.targetIdx);
      const from = centerOf(aEl);
      const to = centerOf(tEl);
      const sprite = aEl?.querySelector<HTMLElement>("[data-sprite]");
      const ranged = kind === "archer" || kind === "mage";
      if (ranged) {
        // 반동 후 투사체
        sprite?.animate(
          [{ transform: "translateY(0)" }, { transform: `translateY(${aSide === 0 ? 4 : -4}px)` }, { transform: "translateY(0)" }],
          { duration: ms(200) },
        );
        playSfx(kind === "archer" ? "arrow" : "magic");
        if (from && to && fxRef.current) {
          await fxRef.current.projectile(
            from,
            to,
            kind === "archer" ? "arrow" : "orb",
            kind === "archer" ? "#f4e4b0" : "#b48cff",
            Math.max(0.12, ms(340) / 1000),
            kind === "archer" ? 36 : 12,
          );
        } else {
          await sleep(ms(300));
        }
      } else {
        // 근접: 대상 쪽으로 돌진했다가 복귀
        const reach = kind === "cavalry" ? 0.62 : 0.45;
        const dx = from && to ? (to.x - from.x) * reach : 0;
        const dy = from && to ? (to.y - from.y) * reach : 0;
        const dur = ms(kind === "cavalry" ? 380 : 320);
        if (!reducedRef.current) {
          sprite?.animate(
            [
              { transform: "translate(0,0) scale(1)" },
              { transform: `translate(${dx}px,${dy}px) scale(1.12)`, offset: 0.45 },
              { transform: "translate(0,0) scale(1)" },
            ],
            { duration: dur, easing: "cubic-bezier(.3,.7,.4,1)" },
          );
        }
        await sleep(dur * 0.45);
        if (to && fxRef.current && kind === "cavalry") fxRef.current.dust(to, 40);
      }
      if (cancelled) return;
      impact(ev, seq, kind);
    };

    const playSkill = async (sk: AutoSkillEvent, hits: Array<{ ev: AutoTickEvent; seq: number }>): Promise<void> => {
      const casterIdx = leadIdx(deploy(sk.side === 0 ? result.attacker : result.defender));
      const caster = centerOf(cell(sk.side, casterIdx));
      setBanner({
        side: sk.side,
        title: `${sk.side === 0 ? "아군" : "적"} 스킬 — ${autoSkillName(sk.kind)}`,
        text: skillEffectText(sk.kind),
        key: Date.now(),
      });
      playSfx("skill");
      if (caster) {
        fxRef.current?.pillar(caster, 46, KIND_FX[sk.kind][0] ?? "#ffffff", 0.7);
        fxRef.current?.ring(caster, KIND_FX[sk.kind][1] ?? "#ffffff", 80, 0.5);
      }
      await sleep(ms(550));
      if (stopped()) return;
      const foeSide: 0 | 1 = sk.side === 0 ? 1 : 0;
      if (sk.kind === "archer" || sk.kind === "mage") {
        const shots = hits.map(async ({ ev, seq }) => {
          const to = centerOf(cell(foeSide, ev.targetIdx));
          if (caster && to && fxRef.current) {
            if (sk.kind === "mage") {
              fxRef.current.lightning(caster, to, "#c9a2ff", 0.4);
              await sleep(ms(120));
            } else {
              await fxRef.current.projectile(caster, to, "fire", "#ffb84d", Math.max(0.15, ms(320) / 1000), 50);
            }
          }
          if (!cancelled) impact(ev, seq, null);
        });
        if (sk.kind === "mage") playSfx("magic");
        await Promise.all(shots);
      } else {
        // 아군 강화·회복: 발동 직후 상태를 그대로 반영
        playSfx("heal");
        setSides((prev) => {
          const next: Sides = [prev[0].slice(), prev[1].slice()];
          sk.self.forEach((s, i) => {
            const u = next[sk.side][i];
            if (u && !u.empty) next[sk.side][i] = { ...u, hp: s.hp, maxHp: s.maxHp, atk: s.atk, alive: s.alive };
          });
          return next;
        });
        const label = sk.kind === "infantry" ? "+2 체력" : sk.kind === "cavalry" ? "공격 +1" : "+1/+1";
        const colors = sk.kind === "infantry" ? ["#7dffa8", "#c8ffd9", "#3fd17a"] : KIND_FX[sk.kind];
        sk.self.forEach((s, i) => {
          if (!s.alive) return;
          const at = centerOf(cell(sk.side, i));
          if (at) fxRef.current?.rise(at, colors, 14, 44);
          floatText(at, label, sk.kind === "infantry" ? "text-emerald-300" : "text-amber-200");
        });
      }
      await sleep(ms(500));
    };

    const run = async (): Promise<void> => {
      await sleep(700);
      for (const step of timeline) {
        if (stopped()) return;
        setTurn(step.tick + 1);
        for (const sk of step.skills) {
          if (stopped()) return;
          await playSkill(
            sk,
            step.skillHits.filter((h) => h.ev.attackerSide === sk.side),
          );
        }
        // 스킬 기록 없이 온 스킬 피해 (구버전 응답) 도 반영
        if (step.skills.length === 0) {
          for (const h of step.skillHits) impact(h.ev, h.seq, null);
        }
        const pending: Array<Promise<void>> = [];
        const gap = step.attacks.length > 0 ? TICK_MS / step.attacks.length : TICK_MS;
        for (const { ev, seq } of step.attacks) {
          if (stopped()) return;
          pending.push(playAttack(ev, seq));
          await sleep(ms(Math.min(260, gap)));
        }
        await Promise.all(pending);
        await sleep(ms(220));
      }
      if (stopped()) return;
      finish();
    };

    const finish = (): void => {
      const o = result.victory ? "win" : result.winner === "draw" ? "draw" : "lose";
      setOutcome(o);
      setBanner(null);
      setDone(true);
      playSfx(o === "win" ? "win" : "lose");
      if (o === "win") {
        const f = fieldRef.current?.getBoundingClientRect();
        if (f && fxRef.current) {
          for (let i = 0; i < 4; i++) {
            fxRef.current.burst(
              { x: f.left + f.width * (0.2 + i * 0.2), y: f.top + f.height * 0.35 },
              ["#ffe28a", "#ffc23d", "#ffffff", "#7dd3fc"],
              22,
              { speed: 260, size: 4, life: 1.1, up: 160 },
            );
          }
        }
      }
    };
    finishRef.current = finish;

    void run();
    return () => {
      cancelled = true;
    };
    // 한 번만 재생한다 (result는 이 장면 동안 바뀌지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = (): void => {
    if (done) return;
    skipRef.current = true;
    setSides(finalSides(result, skills));
    setTurn(lastTick + 1);
    finishRef.current();
  };

  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);
    setSfxMuted(next);
  };

  const renderUnit = (side: 0 | 1, idx: number): ReactElement => {
    const u = sides[side][idx];
    if (!u || u.empty) {
      return <div key={idx} className="w-[30%] max-w-[96px]" />;
    }
    const pct = u.maxHp > 0 ? Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100)) : 0;
    const art = side === 1 && enemyIsOutlaw ? "cmd-outlaw" : `cmd-${u.kind}`;
    const isLead = idx === leadIdx(sides[side]);
    return (
      <div
        key={idx}
        ref={(el) => {
          const row = cellRefs.current[side];
          if (row) row[idx] = el;
        }}
        className={`relative flex w-[30%] max-w-[96px] flex-col items-center transition-[opacity,filter] duration-500 ${u.alive ? "" : "opacity-35 grayscale"}`}
      >
        <div
          data-sprite
          className={`relative rounded-full ${side === 0 ? "bg-sky-400/15" : "bg-red-500/15"} px-1 pt-0.5 transition-transform duration-500 ${u.alive ? "" : "rotate-[80deg] translate-y-2"}`}
        >
          <PixelArt name={art} scale={2} />
          {isLead ? (
            <span className="absolute -right-1 -top-1 rounded bg-amber-300 px-1 text-[9px] font-black leading-tight text-black">선두</span>
          ) : null}
        </div>
        <p className="mt-0.5 w-full truncate text-center text-[10px] font-bold leading-tight text-amber-50">
          {u.name || KIND_LABEL[u.kind]}
        </p>
        <p className="text-[9px] leading-tight text-amber-100/70">
          {KIND_LABEL[u.kind]} · 공 {u.atk}
        </p>
        <div className="relative mt-0.5 h-1.5 w-full overflow-hidden rounded bg-black/70">
          {/* 늦게 줄어드는 흰 잔상 → 방금 입은 피해가 보인다 */}
          <div className="absolute inset-y-0 left-0 bg-white/70 transition-[width] delay-300 duration-500" style={{ width: `${pct}%` }} />
          <div
            className={`absolute inset-y-0 left-0 transition-[width] duration-200 ${pct > 50 ? "bg-emerald-400" : pct > 25 ? "bg-amber-400" : "bg-red-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[9px] tabular-nums leading-tight text-amber-100/80">
          {u.hp}/{u.maxHp}
        </p>
      </div>
    );
  };

  const row = (side: 0 | 1, idxs: number[]): ReactElement => (
    <div className="flex justify-center gap-2">{idxs.map((i) => renderUnit(side, i))}</div>
  );

  const progressPct = lastTick > 0 ? Math.min(100, (turn / (lastTick + 1)) * 100) : done ? 100 : 0;

  return (
    <div className="flex max-h-[85vh] flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2 text-sm text-amber-100/80">
        <span className="shrink-0 font-bold tabular-nums">
          {turn === 0 ? "전투 준비" : `${Math.min(turn, lastTick + 1)}턴`}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-black/50">
          <div className="h-full bg-amber-300/80 transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? "소리 켜기" : "소리 끄기"}
            className="rounded bg-white/10 px-2 py-0.5 text-xs font-bold text-amber-100"
          >
            {muted ? "소리 끔" : "소리"}
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`rounded px-2 py-0.5 text-xs font-bold ${speed === s ? "bg-amber-300 text-black" : "bg-white/10 text-amber-100"}`}
            >
              {s}x
            </button>
          ))}
          {!done ? (
            <button type="button" onClick={skip} className="rounded bg-white/10 px-2 py-0.5 text-xs font-bold text-amber-100">
              스킵
            </button>
          ) : null}
        </span>
      </div>

      <div
        ref={fieldRef}
        className="relative overflow-hidden rounded-xl border border-amber-200/20 bg-[radial-gradient(ellipse_at_50%_0%,rgba(190,60,50,0.28),transparent_55%),radial-gradient(ellipse_at_50%_100%,rgba(60,130,210,0.28),transparent_55%),linear-gradient(180deg,#3d4a2c_0%,#55663a_50%,#3d4a2c_100%)] px-2 py-2"
      >
        {/* 풀밭 점무늬 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-25"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.18) 1px, transparent 1.5px), radial-gradient(rgba(0,0,0,0.25) 1px, transparent 1.5px)",
            backgroundSize: "14px 14px, 22px 22px",
            backgroundPosition: "0 0, 7px 11px",
          }}
        />
        <p className="relative mb-1 text-center text-xs font-black text-red-200">
          {result.defenderName}
          {result.reinforced.length > 0 ? <span className="ml-1 text-sky-300">(원군 {result.reinforced.length})</span> : null}
        </p>
        <div className="relative flex flex-col gap-1.5">
          {row(1, [3, 4])}
          {row(1, [0, 1, 2])}
          <div className="my-0.5 flex items-center gap-2 px-4" aria-hidden="true">
            <div className="h-px flex-1 border-t border-dashed border-amber-100/30" />
            <span className="text-xs text-amber-100/50">⚔</span>
            <div className="h-px flex-1 border-t border-dashed border-amber-100/30" />
          </div>
          {row(0, [0, 1, 2])}
          {row(0, [3, 4])}
        </div>
        <p className="relative mt-1 text-center text-xs font-black text-sky-200">아군</p>

        <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 h-full w-full [image-rendering:pixelated]" />
        <div ref={floatRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-30" />

        {banner ? (
          <div
            key={banner.key}
            className={`pointer-events-none absolute inset-x-2 top-[38%] z-40 animate-[autoBanner_1.2s_ease-out_forwards] rounded-lg border-2 px-3 py-2 text-center shadow-lg ${banner.side === 0 ? "border-sky-300/70 bg-sky-950/85" : "border-red-300/70 bg-red-950/85"}`}
          >
            <p className={`text-lg font-black ${banner.side === 0 ? "text-sky-200" : "text-red-200"}`}>{banner.title}</p>
            <p className="text-xs text-amber-50/85">{banner.text}</p>
          </div>
        ) : null}

        {outcome ? (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/35">
            <p
              className={`animate-[autoOutcome_0.6s_cubic-bezier(.2,1.4,.4,1)_forwards] text-5xl font-black tracking-widest ${outcome === "win" ? "text-amber-300" : outcome === "draw" ? "text-slate-200" : "text-red-300"}`}
              style={{ textShadow: "0 4px 0 #000, 0 0 18px rgba(0,0,0,0.9)" }}
            >
              {outcome === "win" ? "승리!" : outcome === "draw" ? "무승부" : "패배…"}
            </p>
          </div>
        ) : null}
      </div>

      {done ? (
        <button type="button" onClick={onFinished} className="w-full rounded-lg bg-amber-300 px-4 py-2 text-base font-bold text-black">
          결과 보기
        </button>
      ) : null}
      <style>{`
        @keyframes autoBanner {
          0% { opacity: 0; transform: scale(0.7); }
          15% { opacity: 1; transform: scale(1.05); }
          25% { transform: scale(1); }
          80% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-12px); }
        }
        @keyframes autoOutcome {
          0% { opacity: 0; transform: scale(2.2); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
