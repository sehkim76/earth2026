"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { unitStats, type AutoFormation, type AutoTickEvent, type AutoUnitKind } from "@/lib/auto-battle";

import type { AutoBattleStartResult } from "@/components/battle/auto-battle-api";

const KIND_LABEL: Record<AutoUnitKind, string> = {
  lord: "영주",
  infantry: "보병",
  archer: "궁병",
  cavalry: "기병",
  mage: "마법",
};

const KIND_COLOR: Record<AutoUnitKind, string> = {
  lord: "border-amber-300 bg-amber-300/15",
  infantry: "border-sky-400/60 bg-sky-400/10",
  archer: "border-emerald-400/60 bg-emerald-400/10",
  cavalry: "border-orange-400/60 bg-orange-400/10",
  mage: "border-violet-400/60 bg-violet-400/10",
};

interface UnitBox {
  kind: AutoUnitKind;
  name: string;
  maxHp: number;
  hp: number;
  atk: number;
  alive: boolean;
}

function deploy(formation: AutoFormation): UnitBox[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const slot = formation[i];
    if (!slot) return { kind: "infantry" as AutoUnitKind, name: "", maxHp: 0, hp: 0, atk: 0, alive: false };
    const stats = unitStats(slot);
    return { kind: slot.kind, name: slot.name, maxHp: stats.maxHp, hp: stats.maxHp, atk: stats.atk, alive: true };
  });
}

function skillOf(kind: AutoUnitKind): string {
  if (kind === "lord") return "전군 격려";
  if (kind === "infantry") return "방벽";
  if (kind === "archer") return "조준 사격";
  if (kind === "cavalry") return "돌격";
  return "마법 작렬";
}

interface AutoBattleSceneProps {
  result: AutoBattleStartResult;
  onFinished: () => void;
}

const SPEEDS = [1, 2, 4] as const;

/** 40틱 자동전투 재생 (편성 → 스킬 1회 → 결과). */
export function AutoBattleScene({ result, onFinished }: AutoBattleSceneProps) {
  const grouped = useMemo(() => {
    const map = new Map<number, AutoTickEvent[]>();
    for (const e of result.events) {
      const list = map.get(e.tick) ?? [];
      list.push(e);
      map.set(e.tick, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [result]);

  const [atk, setAtk] = useState<UnitBox[]>(() => deploy(result.attacker));
  const [def, setDef] = useState<UnitBox[]>(() => deploy(result.defender));
  const [tickIdx, setTickIdx] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [done, setDone] = useState(false);
  const [flash, setFlash] = useState("");
  const timer = useRef<number | null>(null);

  const applyTick = (tickEvents: AutoTickEvent[]): void => {
    setAtk((prev) => {
      const next = prev.map((u) => ({ ...u }));
      for (const e of tickEvents) {
        if (e.attackerSide === 1 && e.targetIdx >= 0) {
          const t = next[e.targetIdx];
          if (t && t.alive) {
            t.hp = e.targetHpAfter;
            if (e.killed) {
              t.hp = 0;
              t.alive = false;
            }
          }
        }
      }
      return next;
    });
    setDef((prev) => {
      const next = prev.map((u) => ({ ...u }));
      for (const e of tickEvents) {
        if (e.attackerSide === 0 && e.targetIdx >= 0) {
          const t = next[e.targetIdx];
          if (t && t.alive) {
            t.hp = e.targetHpAfter;
            if (e.killed) {
              t.hp = 0;
              t.alive = false;
            }
          }
        }
      }
      return next;
    });
    const skillFired = tickEvents.some((e) => e.attackerIdx === -1);
    if (skillFired) {
      const byAtk = tickEvents.some((e) => e.attackerSide === 0 && e.attackerIdx === -1);
      setFlash(byAtk ? `아군 스킬 — ${skillOf(result.skillKind)}` : "적 스킬 발동!");
      window.setTimeout(() => setFlash(""), 1400);
    }
  };

  useEffect(() => {
    if (done) return;
    if (tickIdx >= grouped.length) {
      setDone(true);
      return;
    }
    timer.current = window.setTimeout(
      () => {
        const entry = grouped[tickIdx];
        if (entry) applyTick(entry[1]);
        setTickIdx((v) => v + 1);
      },
      tickIdx === 0 ? 900 : Math.round(650 / speed),
    );
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickIdx, speed, done]);

  const skip = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const finalAtk = deploy(result.attacker);
    const finalDef = deploy(result.defender);
    for (const e of result.events) {
      const pool = e.attackerSide === 0 ? finalDef : finalAtk;
      const t = pool[e.targetIdx];
      if (t && t.alive && e.targetIdx >= 0) {
        t.hp = e.targetHpAfter;
        if (e.killed) {
          t.hp = 0;
          t.alive = false;
        }
      }
    }
    setAtk(finalAtk);
    setDef(finalDef);
    setTickIdx(grouped.length);
    setDone(true);
  };

  const lastTick = grouped.length === 0 ? 0 : (grouped[Math.min(tickIdx, grouped.length - 1)]?.[0] ?? 0);
  const renderRow = (units: UnitBox[], dmgByIdx: Map<number, number>): ReactElement => (
    <div className="grid grid-cols-5 gap-1">
      {units.map((u, idx) => {
        if (u.maxHp === 0) return <div key={idx} className="h-16 rounded-md border border-dashed border-white/10" />;
        const pct = Math.max(0, Math.round((u.hp / u.maxHp) * 100));
        const dmg = dmgByIdx.get(idx);
        return (
          <div key={idx} className={`relative rounded-md border px-1 py-1 text-center ${u.alive ? KIND_COLOR[u.kind] : "border-white/10 bg-black/50 opacity-40"}`}>
            {dmg !== undefined ? (
              <span className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 rounded bg-red-600 px-1 text-xs font-bold text-white">-{dmg}</span>
            ) : null}
            <p className="truncate text-xs font-bold text-amber-50">{u.name || KIND_LABEL[u.kind]}</p>
            <p className="text-[10px] text-amber-100/60">
              {KIND_LABEL[u.kind]} · {u.atk}
            </p>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-black/60">
              <div className={`h-full ${pct > 50 ? "bg-emerald-400" : pct > 25 ? "bg-amber-400" : "bg-red-500"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[10px] text-amber-100/70">
              {u.hp}/{u.maxHp}
            </p>
          </div>
        );
      })}
    </div>
  );

  const curEvents = tickIdx === 0 ? [] : (grouped[Math.min(tickIdx - 1, grouped.length - 1)]?.[1] ?? []);
  const atkDmg = new Map<number, number>();
  const defDmg = new Map<number, number>();
  for (const e of curEvents) {
    if (e.attackerIdx === -1) continue;
    const map = e.attackerSide === 0 ? defDmg : atkDmg;
    map.set(e.targetIdx, (map.get(e.targetIdx) ?? 0) + e.damage);
  }

  return (
    <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-center justify-between text-sm text-amber-100/80">
        <span>
          틱 {Math.min(tickIdx, grouped.length)}/{grouped.length} · {lastTick}턴
        </span>
        <span className="flex gap-1">
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
      {flash ? <p className="rounded bg-amber-300/20 px-2 py-1 text-center text-sm font-bold text-amber-200">{flash}</p> : null}
      <p className="text-center text-sm font-bold text-red-300">{result.defenderName}</p>
      {renderRow(def, atkDmg)}
      <p className="py-0.5 text-center text-xs text-amber-100/50">⚔️</p>
      {renderRow(atk, defDmg)}
      <p className="text-center text-sm font-bold text-sky-300">아군</p>
      {done ? (
        <button
          type="button"
          onClick={onFinished}
          className="mt-1 w-full rounded-lg bg-amber-300 px-4 py-2 text-base font-bold text-black"
        >
          결과 보기
        </button>
      ) : null}
    </div>
  );
}
