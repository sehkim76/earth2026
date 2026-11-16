"use client";

import { useState } from "react";

import type { OutlawTier } from "@/lib/battle";

import { BattleScene } from "@/components/battle/BattleScene";
import { createLocalBattle } from "@/components/battle/local-source";
import type { LocalBattle, LocalBattleOptions } from "@/components/battle/local-source";

interface BattleDemoProps {
  kind: string;
  level: number;
  tier: number;
  seed: number;
}

const KINDS: ReadonlyArray<LocalBattleOptions["commanderKind"]> = ["lord", "infantry", "archer", "cavalry", "mage"];
const KIND_NAME: Readonly<Record<LocalBattleOptions["commanderKind"], string>> = {
  lord: "시험 영주",
  infantry: "제1 보병대",
  archer: "제2 궁병대",
  cavalry: "제3 기병대",
  mage: "제4 마법대",
};

function makeBattle(props: BattleDemoProps, seed: number): LocalBattle {
  const kind = KINDS.find((k) => k === props.kind) ?? "lord";
  const tier = (Math.max(1, Math.min(3, Math.floor(props.tier) || 2)) as OutlawTier);
  return createLocalBattle({
    seed,
    commanderKind: kind,
    commanderLevel: Math.max(1, Math.min(10, Math.floor(props.level) || 3)),
    commanderName: KIND_NAME[kind],
    outlawTier: tier,
    // 서울 시청 앞 (배경 위성 타일용)
    lat: 37.5663,
    lon: 126.9779,
  });
}

/** 같은 BattleScene 을 로컬 엔진 공급원으로 띄운다. */
export function BattleDemo(props: BattleDemoProps) {
  const [seed, setSeed] = useState(Number.isFinite(props.seed) ? props.seed : 20261117);
  const [battle, setBattle] = useState<LocalBattle>(() => makeBattle(props, seed));
  const [round, setRound] = useState(0);

  const restart = (): void => {
    const next = seed + 1;
    setSeed(next);
    setBattle(makeBattle(props, next));
    setRound((r) => r + 1);
  };

  return (
    <main style={{ position: "fixed", inset: 0, background: "#0d0f0c" }}>
      <BattleScene key={round} initial={battle.initial} source={battle.source} onExit={restart} onFinished={restart} />
    </main>
  );
}
