"use client";

import { useEffect, useRef, useState } from "react";

import type { BattleCommanderInfo, PublicBattleView } from "@/lib/battle";

import { BattleCardFace } from "@/components/battle/BattleCardFace";
import { PLAYER } from "@/components/battle/view-rules";
import styles from "@/components/battle/battle.module.css";

interface BattleResultPanelProps {
  view: PublicBattleView;
  reduced: boolean;
  onConfirm: () => void;
}

function frac(info: BattleCommanderInfo): number {
  if (info.nextLevelXp === null) return 1;
  const span = info.nextLevelXp - info.levelXpStart;
  return span > 0 ? Math.max(0, Math.min(1, (info.xp - info.levelXpStart) / span)) : 1;
}

/** 승패 깃발 + 경험치 막대 + 레벨 업 + 보상 카드 공개 */
export function BattleResultPanel({ view, reduced, onConfirm }: BattleResultPanelProps) {
  const result = view.result;
  const victory = result ? result.victory : view.winner === PLAYER;
  const draw = view.winner === "draw";
  const fillRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(result?.commanderBefore.level ?? view.commander.level);
  const [levelFlash, setLevelFlash] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const fill = fillRef.current;
    if (!result || !fill) {
      const id = window.setTimeout(() => setRevealed(true), 600);
      return () => window.clearTimeout(id);
    }
    const k = reduced ? 0.4 : 1;
    const from = frac(result.commanderBefore);
    const to = frac(result.commanderAfter);
    const timers: number[] = [];
    fill.style.width = `${from * 100}%`;
    const run = async (): Promise<void> => {
      await new Promise((r) => timers.push(window.setTimeout(r, 700 * k)));
      if (result.levelUp) {
        await fill.animate([{ width: `${from * 100}%` }, { width: "100%" }], { duration: 700 * k, easing: "ease-in", fill: "forwards" })
          .finished;
        setLevel(result.commanderAfter.level);
        setLevelFlash(true);
        await fill.animate([{ width: "0%" }, { width: `${to * 100}%` }], { duration: 700 * k, easing: "ease-out", fill: "forwards" })
          .finished;
      } else {
        await fill.animate([{ width: `${from * 100}%` }, { width: `${to * 100}%` }], {
          duration: 900 * k,
          easing: "ease-out",
          fill: "forwards",
        }).finished;
      }
      timers.push(window.setTimeout(() => setRevealed(true), 300 * k));
    };
    void run().catch(() => setRevealed(true));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [result, reduced]);

  const title = draw ? "무승부" : victory ? "승리" : "패배";
  return (
    <div className={styles.resultBackdrop}>
      <div className={`${styles.resultPanel} ${victory ? styles.resultWin : draw ? "" : styles.resultLose}`}>
        <div className={styles.resultBanner}>{title}</div>
        <div className={styles.resultSub}>
          {view.target.name} {victory ? "토벌 성공" : draw ? "결판나지 않음" : "토벌 실패"}
        </div>
        {result ? (
          <>
            <div className={styles.xpRow}>
              <span className={`${styles.xpLevel} ${levelFlash ? styles.levelFlash : ""}`}>Lv.{level}</span>
              <div className={styles.xpBar}>
                <div ref={fillRef} className={styles.xpFill} />
              </div>
              <span className={styles.xpGain}>+{result.xpGained} 경험치</span>
            </div>
            {levelFlash ? <div className={styles.levelUp}>레벨 업! {result.commanderAfter.name} Lv.{result.commanderAfter.level}</div> : null}
            {result.cardRewards.length > 0 ? (
              <div className={styles.rewardRow}>
                {result.cardRewards.map((id, i) => (
                  <div
                    key={`${id}-${i}`}
                    className={`${styles.rewardCard} ${revealed ? styles.rewardShown : ""}`}
                    style={{ transitionDelay: `${i * 180}ms` }}
                  >
                    <div className={styles.rewardFront}>
                      <BattleCardFace cardId={id} width={104} />
                    </div>
                    <div className={styles.rewardBack} />
                  </div>
                ))}
              </div>
            ) : null}
            {revealed && result.cardRewards.length > 0 ? <div className={styles.resultNote}>새 카드를 얻었습니다</div> : null}
            {result.injuredUntil ? (
              <div className={styles.resultNote}>
                지휘관 부상 —{" "}
                {new Date(result.injuredUntil).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}까지 출전 불가
              </div>
            ) : null}
          </>
        ) : null}
        <button type="button" className={styles.resultBtn} onClick={onConfirm}>
          확인
        </button>
      </div>
    </div>
  );
}
