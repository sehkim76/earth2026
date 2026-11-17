"use client";

import type { CSSProperties } from "react";

import type { CardClass, CardDef } from "@/lib/battle";

import { cardBadges } from "@/components/battle/card-help";
import { PixelArt } from "@/components/battle/PixelArt";
import { safeCard } from "@/components/battle/view-rules";
import styles from "@/components/battle/battle.module.css";

export const CLASS_LABEL: Readonly<Record<CardClass, string>> = {
  infantry: "보병",
  archer: "궁병",
  cavalry: "기병",
  mage: "마법",
  neutral: "공용",
};

const TYPE_LABEL: Readonly<Record<CardDef["type"], string>> = {
  soldier: "병사",
  tactic: "전술",
  equipment: "장비",
};

/** 오방색에서 따온 병종 색 (주색, 어두운색, 밝은색) */
export const CLASS_TONES: Readonly<Record<CardClass, [string, string, string]>> = {
  infantry: ["#3a5cae", "#1a2b5e", "#9fbcf0"],
  archer: ["#3c7a3a", "#1b4426", "#a8d47a"],
  cavalry: ["#a8352c", "#5e121c", "#f29a7c"],
  mage: ["#6a3d9e", "#341a52", "#c9a6f0"],
  neutral: ["#9a7430", "#4f3912", "#ecd08a"],
};

export function classVars(cls: CardClass): CSSProperties {
  const [main, dark, light] = CLASS_TONES[cls];
  return { "--cls": main, "--cls-dark": dark, "--cls-light": light } as CSSProperties;
}

/** 카드 문구에서 키워드(수호·기습·결계·원거리·출진·유훈)를 굵게 */
export function CardText({ text }: { text: string }) {
  const parts = text.split(/(수호|기습|결계|원거리|출진:|유훈:)/g).filter((p) => p.length > 0);
  return (
    <>
      {parts.map((p, i) =>
        /^(수호|기습|결계|원거리|출진:|유훈:)$/.test(p) ? <b key={i}>{p}</b> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

interface BattleCardFaceProps {
  cardId: string;
  /** 카드 폭(px). 높이는 1.4배. */
  width: number;
  /** 실제 비용 (할인 반영). 없으면 카드 기본 비용 */
  cost?: number;
  /** 간단 표시 (문구 생략) */
  compact?: boolean;
  className?: string;
}

/** 카드 앞면. 모서리를 깎은 판 + 병종 색 테 + 붉은 인장 모양 비용. */
export function BattleCardFace({ cardId, width, cost, compact, className }: BattleCardFaceProps) {
  const def = safeCard(cardId);
  if (!def) return null;
  const h = Math.round(width * 1.4);
  const artH = h * (compact ? 0.5 : 0.4);
  const artScale = Math.max(1, Math.round((artH / 32) * 4) / 4);
  const shownCost = cost ?? def.cost;
  const badges = cardBadges(def);
  return (
    <div
      className={`${styles.card} ${compact ? styles.cardCompact : ""} ${className ?? ""}`}
      data-type={def.type}
      style={{ width, height: h, fontSize: width / 9, ...classVars(def.cardClass) }}
    >
      <div className={styles.cardInner}>
        <div className={styles.cardArt}>
          <PixelArt name={def.artKey} scale={artScale} />
        </div>
        <div className={styles.cardName}>{def.name}</div>
        {!compact ? (
          <div className={styles.cardText}>
            <span>
              {def.text ? <CardText text={def.text} /> : <i className={styles.cardPlain}>특수 능력 없는 기본 병사</i>}
            </span>
          </div>
        ) : null}
        <div className={styles.cardType}>
          {compact && badges.length > 0 ? badges.join("·") : `${TYPE_LABEL[def.type]} · ${CLASS_LABEL[def.cardClass]}`}
        </div>
      </div>
      <div className={`${styles.costSeal} ${shownCost < def.cost ? styles.costDown : ""}`} title="마나 비용">
        {shownCost}
      </div>
      {!compact ? <span className={`${styles.statCap} ${styles.capCost}`}>마나</span> : null}
      {def.type !== "tactic" ? (
        <div className={`${styles.statGroup} ${styles.statLeft}`} title="공격력">
          <span className={styles.statLbl}>ATK</span>
          <div className={styles.cardAtk}>{def.attack ?? 0}</div>
        </div>
      ) : null}
      {def.type === "soldier" ? (
        <div className={`${styles.statGroup} ${styles.statRight}`} title="체력">
          <span className={styles.statLbl}>HP</span>
          <div className={styles.cardHp}>{def.health ?? 0}</div>
        </div>
      ) : null}
      {def.type === "equipment" ? (
        <div className={`${styles.statGroup} ${styles.statRight}`} title="사용 횟수">
          <span className={styles.statLbl}>횟수</span>
          <div className={styles.cardDur}>{def.durability ?? 0}</div>
        </div>
      ) : null}
    </div>
  );
}

/** 카드 뒷면 */
export function BattleCardBack({ width }: { width: number }) {
  return (
    <div className={styles.cardBack} style={{ width, height: Math.round(width * 1.4) }}>
      <PixelArt name="card-back" scale={width / 16} />
    </div>
  );
}
