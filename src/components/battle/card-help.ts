// 처음 하는 사람을 위한 설명 문구: 키워드 사전, 카드·병사·지휘관을 풀어 쓴 설명.

import { COMMANDER_KIND_LABEL, getCard, heroPower } from "@/lib/battle";
import type { CardDef, Commander, Keyword, Soldier } from "@/lib/battle";

import { safeCard } from "@/components/battle/view-rules";

export interface GlossaryEntry {
  name: string;
  /** 아틀라스 아이콘 키 */
  icon: string;
  desc: string;
}

export const KEYWORD_HELP: Readonly<Record<Keyword, GlossaryEntry>> = {
  guard: { name: "수호", icon: "ic-guard", desc: "적은 이 병사를 먼저 쓰러뜨려야 다른 대상을 공격할 수 있다." },
  rush: { name: "기습", icon: "ic-rush", desc: "낸 턴에 바로 공격할 수 있다." },
  shield: { name: "결계", icon: "ic-shield", desc: "처음 받는 피해 한 번을 막아 준다." },
  ranged: { name: "원거리", icon: "ic-ranged", desc: "공격할 때 반격 피해를 받지 않는다." },
};

export const ON_PLAY_HELP: GlossaryEntry = { name: "출진", icon: "ic-onplay", desc: "카드를 낼 때 한 번 효과가 일어난다." };
export const ON_DEATH_HELP: GlossaryEntry = { name: "유훈", icon: "ic-ondeath", desc: "이 병사가 쓰러질 때 효과가 일어난다." };

export const CARD_TYPE_HELP: Readonly<Record<CardDef["type"], string>> = {
  soldier: "병사 카드: 필드에 남아 싸운다. 낸 다음 턴부터 공격할 수 있다.",
  tactic: "전술 카드: 효과를 한 번 쓰고 사라진다.",
  equipment: "장비 카드: 내 지휘관이 무기를 들고 직접 공격할 수 있다.",
};

export interface HelpInfo {
  title: string;
  /** 종류 표시 (병사·전술·장비·지휘관·능력) */
  tag: string;
  /** 수치 요약 (마나·공격력·체력…) */
  stats: { icon: string; label: string; value: string; tone?: "up" | "down" }[];
  /** 효과 문구 */
  text: string | null;
  /** 이 카드에 쓰인 키워드 설명 */
  terms: GlossaryEntry[];
  /** 지금 상태·할 수 있는 일 */
  tip: string | null;
}

function termsFor(keywords: readonly Keyword[], def: CardDef | null): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  const push = (e: GlossaryEntry): void => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    out.push(e);
  };
  keywords.forEach((k) => push(KEYWORD_HELP[k]));
  if (def) {
    // 문구에 나오는 키워드(다른 병사에게 주는 경우 포함)도 풀이한다
    (Object.keys(KEYWORD_HELP) as Keyword[]).forEach((k) => {
      if (def.text.includes(KEYWORD_HELP[k].name)) push(KEYWORD_HELP[k]);
    });
    if (def.type === "soldier" && def.onPlay?.length) push(ON_PLAY_HELP);
    if (def.onDeath?.length) push(ON_DEATH_HELP);
  }
  return out;
}

/** 손패·보관함 카드 설명 */
export function describeCard(cardId: string, shownCost?: number): HelpInfo | null {
  const def = safeCard(cardId);
  if (!def) return null;
  const cost = shownCost ?? def.cost;
  const stats: HelpInfo["stats"] = [
    { icon: "ic-mana", label: "마나", value: String(cost), tone: cost < def.cost ? "down" : undefined },
  ];
  if (def.type === "soldier") {
    stats.push({ icon: "ic-attack", label: "공격력", value: String(def.attack ?? 0) });
    stats.push({ icon: "ic-health", label: "체력", value: String(def.health ?? 0) });
  } else if (def.type === "equipment") {
    stats.push({ icon: "ic-attack", label: "공격력", value: String(def.attack ?? 0) });
    stats.push({ icon: "ic-durability", label: "사용 횟수", value: String(def.durability ?? 0) });
  }
  const tag = def.type === "soldier" ? "병사" : def.type === "tactic" ? "전술" : "장비";
  return {
    title: def.name,
    tag,
    stats,
    text: def.text && !isKeywordOnly(def) ? def.text : null,
    terms: [{ name: tag, icon: "ic-deck", desc: CARD_TYPE_HELP[def.type].replace(/^[^:]+: /, "") }, ...termsFor(def.keywords, def)],
    tip: null,
  };
}

/** 문구가 키워드 나열뿐이면 (예: "수호, 결계") 키워드 풀이로 대신한다 */
function isKeywordOnly(def: CardDef): boolean {
  const names = Object.values(KEYWORD_HELP).map((e) => e.name);
  return def.text.split(/[,.\s]+/).filter(Boolean).every((w) => names.includes(w));
}

/** 필드 위 병사 설명 (현재 수치·상태 포함) */
export function describeSoldier(sol: Soldier, mine: boolean, myTurn: boolean): HelpInfo | null {
  const def = safeCard(sol.cardId);
  if (!def) return null;
  const keywords = sol.rushThisTurn && !sol.keywords.includes("rush") ? [...sol.keywords, "rush" as const] : sol.keywords;
  const baseAtk = def.attack ?? 0;
  const stats: HelpInfo["stats"] = [
    { icon: "ic-attack", label: "공격력", value: String(sol.attack), tone: sol.attack > baseAtk ? "up" : sol.attack < baseAtk ? "down" : undefined },
    {
      icon: "ic-health",
      label: "체력",
      value: `${Math.max(0, sol.health)}/${sol.maxHealth}`,
      tone: sol.health < sol.maxHealth ? "down" : sol.maxHealth > (def.health ?? 0) ? "up" : undefined,
    },
  ];
  let tip: string;
  if (!mine) {
    tip = keywords.includes("guard")
      ? "적의 수호 병사: 이 병사부터 쓰러뜨려야 합니다."
      : "적 병사: 내 병사나 지휘관으로 공격해 쓰러뜨리세요.";
  } else if (!myTurn) {
    tip = "내 병사: 내 턴에 적을 공격할 수 있습니다.";
  } else if (sol.attack <= 0) {
    tip = "공격력이 0이라 공격할 수 없습니다.";
  } else if (sol.summonedThisTurn && !keywords.includes("rush")) {
    tip = "이번 턴에 낸 병사라 다음 턴부터 공격할 수 있습니다.";
  } else if (sol.attacksThisTurn > 0) {
    tip = "이번 턴에 이미 공격했습니다.";
  } else {
    tip = "공격 가능! 적에게 끌어 놓거나, 누른 뒤 적을 누르세요. 서로 공격력만큼 피해를 주고받습니다.";
  }
  const sideTag = mine ? "내 병사" : "적 병사";
  return {
    title: def.name,
    tag: sideTag,
    stats,
    text: def.text && !isKeywordOnly(def) ? def.text : null,
    terms: termsFor(keywords, def),
    tip,
  };
}

/** 지휘관 설명 */
export function describeCommander(c: Commander, mine: boolean): HelpInfo {
  const stats: HelpInfo["stats"] = [{ icon: "ic-health", label: "체력", value: `${Math.max(0, c.hp)}/${c.maxHp}` }];
  if (c.armor > 0) stats.push({ icon: "ic-armor", label: "방어도", value: String(c.armor) });
  if (c.weapon) {
    stats.push({ icon: "ic-attack", label: "무기 공격력", value: String(c.weapon.attack) });
    stats.push({ icon: "ic-durability", label: "남은 사용", value: String(c.weapon.durability) });
  }
  const power = heroPower(c.kind, c.level);
  const weaponName = c.weapon ? getCard(c.weapon.cardId).name : null;
  return {
    title: `${c.name || COMMANDER_KIND_LABEL[c.kind]} Lv.${c.level}`,
    tag: mine ? "내 지휘관" : "적 지휘관",
    stats,
    text: `지휘관 능력 「${power.name}」(${power.cost}마나): ${power.text}${weaponName ? ` · 무기: ${weaponName}` : ""}`,
    terms: c.armor > 0 ? [{ name: "방어도", icon: "ic-armor", desc: "체력보다 먼저 깎이는 보호막." }] : [],
    tip: mine
      ? "체력이 0이 되면 패배합니다. 무기를 들면 지휘관도 공격할 수 있습니다."
      : "이 지휘관의 체력을 0으로 만들면 승리합니다.",
  };
}

/** 지휘관 능력 버튼 설명 */
export function describePower(c: Commander, mine: boolean): HelpInfo {
  const power = heroPower(c.kind, c.level);
  return {
    title: power.name,
    tag: mine ? "내 지휘관 능력" : "적 지휘관 능력",
    stats: [{ icon: "ic-mana", label: "마나", value: String(power.cost) }],
    text: power.text,
    terms: [],
    tip: mine ? "턴마다 한 번 쓸 수 있습니다. 버튼을 누르세요." : "적이 턴마다 한 번 쓸 수 있는 능력입니다.",
  };
}

/** 손패 카드 아래 짧은 꼬리표: 키워드·출진·유훈 */
export function cardBadges(def: CardDef): string[] {
  const out = def.keywords.map((k) => KEYWORD_HELP[k].name);
  if (def.type === "soldier" && def.onPlay?.length) out.push("출진");
  if (def.onDeath?.length) out.push("유훈");
  return out;
}
