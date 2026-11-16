// 서버 이벤트(BattleEvent[])를 순서대로 연출한다.
// DOM 요소는 data-bkey 로 찾고 (병사 sol-{iid}, 지휘관 cmd-{side}, 손패 hand-{iid}, 상대 손패 eback-{i},
// 덱 deck-{side}, 능력 power-{side}, 무기 weapon-{side}, 마나 mana-{side}),
// 카드 이동은 FLIP(전후 위치 차이를 transform 으로 되감기), 효과는 캔버스 입자로 그린다.

import { heroPower } from "@/lib/battle";
import type { BattleEvent, CardClass, CommanderKind, PublicBattleView, SideIndex, TargetRef } from "@/lib/battle";

import type { FxEngine, Point } from "@/components/battle/fx";
import { KEYWORD_LABEL, PLAYER, applyEventToView, describeEvent, refKey, safeCard } from "@/components/battle/view-rules";

export interface AnimHost {
  root: HTMLElement;
  shakeEl: HTMLElement;
  fxLayer: HTMLElement;
  fx: FxEngine;
  reduced: boolean;
  getView(): PublicBattleView;
  /** 화면 상태를 동기적으로 반영 (flushSync) */
  commit(v: PublicBattleView): void;
  /** 가운데 큰 카드 미리보기 (null 이면 숨김) */
  setPreview(p: { cardId: string; side: SideIndex } | null): void;
  log(text: string): void;
}

type FxStyle = "arrow" | "fire" | "orb" | "arcane" | "lightning" | "heal" | "gold" | "slash";

interface EffectSource {
  origin: Point;
  style: FxStyle;
  rain?: boolean;
}

const CLASS_COLORS: Readonly<Record<CardClass, string[]>> = {
  infantry: ["#7da2e8", "#dfe7f0", "#3a5cae"],
  archer: ["#80b852", "#f2e3a0", "#3c7a3a"],
  cavalry: ["#ec6d5c", "#ffe682", "#b02c38"],
  mage: ["#a77bdc", "#bfe8ff", "#3f8cff"],
  neutral: ["#ffe682", "#e8d9ac", "#d9a423"],
};

const STYLE_COLOR: Readonly<Record<FxStyle, string>> = {
  arrow: "#f5ecd0",
  fire: "#f27a18",
  orb: "#3f8cff",
  arcane: "#9a4dff",
  lightning: "#f2e94a",
  heal: "#3fc46a",
  gold: "#ffd34a",
  slash: "#ffffff",
};

function cardStyle(cardId: string): FxStyle {
  switch (cardId) {
    case "fire_arrow":
      return "fire";
    case "arrow_storm":
    case "marksman":
    case "novice_archer":
      return "arrow";
    case "mana_bolt":
      return "orb";
    case "elder_sorcerer":
    case "ward_weaver":
      return "arcane";
    case "thunder_net":
      return "lightning";
    case "field_medic":
      return "heal";
    default:
      return "gold";
  }
}

function powerStyle(kind: CommanderKind): FxStyle {
  switch (kind) {
    case "archer":
      return "arrow";
    case "mage":
      return "arcane";
    case "lord":
    case "cavalry":
      return "gold";
    default:
      return "slash";
  }
}

export class BattleAnimator {
  private h: AnimHost;
  private source: EffectSource | null = null;
  private pendingSpawn: DOMRect | null = null;
  private lastRects = new Map<string, DOMRect>();

  constructor(host: AnimHost) {
    this.h = host;
  }

  // ---- 유틸 ---------------------------------------------------------------

  private d(ms: number): number {
    return this.h.reduced ? Math.round(ms * 0.45) : ms;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => window.setTimeout(r, this.d(ms)));
  }

  private q(key: string): HTMLElement | null {
    return this.h.root.querySelector<HTMLElement>(`[data-bkey="${key}"]`);
  }

  private center(el: Element | DOMRect | null): Point | null {
    if (!el) return null;
    const r = el instanceof Element ? el.getBoundingClientRect() : el;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private refPoint(ref: TargetRef): Point | null {
    const key = refKey(ref);
    const el = this.q(key);
    if (el) return this.center(el);
    const last = this.lastRects.get(key);
    return last ? this.center(last) : null;
  }

  private snapshot(): Map<string, DOMRect> {
    const m = new Map<string, DOMRect>();
    this.h.root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
      const k = el.dataset.bkey;
      if (k) m.set(k, el.getBoundingClientRect());
    });
    return m;
  }

  /** 상태 반영 + 위치가 바뀐 요소는 이전 위치에서 미끄러지게, 새 요소는 enter 위치에서 날아오게 */
  private flipCommit(next: PublicBattleView, enter?: Map<string, DOMRect>, dur = 320): void {
    const before = this.snapshot();
    before.forEach((r, k) => this.lastRects.set(k, r));
    this.h.commit(next);
    this.h.root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
      const k = el.dataset.bkey;
      if (!k) return;
      const now = el.getBoundingClientRect();
      const from = enter?.get(k) ?? before.get(k);
      if (!from) return;
      const dx = from.left + from.width / 2 - (now.left + now.width / 2);
      const dy = from.top + from.height / 2 - (now.top + now.height / 2);
      const sc = now.width > 0 ? from.width / now.width : 1;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sc - 1) < 0.02) return;
      const isEnter = enter?.has(k) ?? false;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sc})`, opacity: isEnter ? 0.6 : 1 },
          { transform: "translate(0, 0) scale(1)", opacity: 1 },
        ],
        { duration: this.d(isEnter ? dur + 80 : dur), easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    });
  }

  private applyCommit(ev: BattleEvent, enter?: Map<string, DOMRect>): void {
    this.flipCommit(applyEventToView(this.h.getView(), ev), enter);
  }

  floatText(at: Point | null, text: string, cls: string): void {
    if (!at) return;
    const layer = this.h.fxLayer;
    const lr = layer.getBoundingClientRect();
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    el.style.left = `${at.x - lr.left}px`;
    el.style.top = `${at.y - lr.top}px`;
    layer.appendChild(el);
    const a = el.animate(
      [
        { transform: "translate(-50%, -30%) scale(0.4)", opacity: 0 },
        { transform: "translate(-50%, -70%) scale(1.25)", opacity: 1, offset: 0.18 },
        { transform: "translate(-50%, -90%) scale(1)", opacity: 1, offset: 0.65 },
        { transform: "translate(-50%, -160%) scale(0.9)", opacity: 0 },
      ],
      { duration: this.d(1100), easing: "ease-out" },
    );
    a.onfinish = () => el.remove();
  }

  banner(text: string, cls: string, ms = 900): Promise<void> {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    this.h.fxLayer.appendChild(el);
    const a = el.animate(
      [
        { transform: "translate(-50%, -50%) scaleX(0.2)", opacity: 0 },
        { transform: "translate(-50%, -50%) scaleX(1.05)", opacity: 1, offset: 0.2 },
        { transform: "translate(-50%, -50%) scaleX(1)", opacity: 1, offset: 0.8 },
        { transform: "translate(-50%, -50%) scaleX(1.2)", opacity: 0 },
      ],
      { duration: this.d(ms), easing: "ease-out" },
    );
    return new Promise((resolve) => {
      a.onfinish = () => {
        el.remove();
        resolve();
      };
    });
  }

  shake(amount: number): void {
    if (this.h.reduced || amount <= 0) return;
    const a = Math.min(14, 2 + amount * 1.6);
    const frames: Keyframe[] = [];
    for (let i = 0; i < 6; i++) {
      const k = 1 - i / 6;
      frames.push({ transform: `translate(${(Math.random() * 2 - 1) * a * k}px, ${(Math.random() * 2 - 1) * a * k}px)` });
    }
    frames.push({ transform: "translate(0, 0)" });
    this.h.shakeEl.animate(frames, { duration: 320, easing: "linear" });
  }

  private pop(el: HTMLElement | null, filter = "brightness(1.8)"): void {
    if (!el) return;
    el.animate(
      [
        { transform: "scale(1)", filter: "none" },
        { transform: "scale(1.14)", filter, offset: 0.35 },
        { transform: "scale(1)", filter: "none" },
      ],
      { duration: this.d(420), easing: "ease-out" },
    );
  }

  private hitFlash(el: HTMLElement | null): void {
    if (!el) return;
    el.animate(
      [
        { filter: "brightness(3) saturate(0)", transform: "translateX(0)" },
        { filter: "brightness(1.4)", transform: "translateX(-4px)", offset: 0.3 },
        { filter: "none", transform: "translateX(3px)", offset: 0.6 },
        { filter: "none", transform: "translateX(0)" },
      ],
      { duration: this.d(320) },
    );
  }

  /** 효과 출처에서 대상까지 투사체 (출처가 없으면 생략) */
  private async travel(to: Point | null, style?: FxStyle): Promise<void> {
    const src = this.source;
    if (!src || !to) return;
    const st = style ?? src.style;
    const color = STYLE_COLOR[st];
    if (st === "lightning") {
      this.h.fx.lightning(src.origin, to);
      await this.wait(120);
      return;
    }
    if (st === "heal") {
      await this.h.fx.projectile(src.origin, to, "orb", color, this.h.reduced ? 0.15 : 0.3, 30);
      return;
    }
    if (st === "slash") return;
    const from = src.rain ? { x: to.x + 40, y: to.y - 260 } : src.origin;
    const kind = st === "arrow" ? "arrow" : st === "fire" ? "fire" : "orb";
    await this.h.fx.projectile(from, to, kind, color, this.h.reduced ? 0.15 : st === "arrow" ? 0.26 : 0.34, st === "arrow" && !src.rain ? 40 : 0);
  }

  // ---- 이벤트 -------------------------------------------------------------

  async play(events: BattleEvent[]): Promise<void> {
    this.source = null;
    this.pendingSpawn = null;
    for (const ev of events) {
      const line = describeEvent(this.h.getView(), ev);
      if (line) this.h.log(line);
      try {
        await this.step(ev);
      } catch {
        // 연출 실패는 무시하고 상태만 반영한다
        this.h.commit(applyEventToView(this.h.getView(), ev));
      }
    }
    this.h.setPreview(null);
  }

  private async step(ev: BattleEvent): Promise<void> {
    const h = this.h;
    switch (ev.type) {
      case "turn-start": {
        this.source = null;
        this.applyCommit(ev);
        this.pop(this.q(`mana-${ev.side}`));
        await this.banner(ev.side === PLAYER ? "내 턴" : "적의 턴", ev.side === PLAYER ? "bfx-banner bfx-banner-mine" : "bfx-banner bfx-banner-enemy", 1000);
        return;
      }
      case "turn-end":
        this.source = null;
        this.applyCommit(ev);
        await this.wait(120);
        return;
      case "draw": {
        const deck = this.q(`deck-${ev.side}`)?.getBoundingClientRect();
        const v = h.getView();
        const key = ev.side === PLAYER ? `hand-${ev.iid}` : `eback-${v.sides[ev.side].handCount}`;
        this.applyCommit(ev, deck ? new Map([[key, deck]]) : undefined);
        await this.wait(ev.side === PLAYER ? 300 : 160);
        return;
      }
      case "burn": {
        const deck = this.center(this.q(`deck-${ev.side}`));
        if (deck) h.fx.burst(deck, ["#f27a18", "#ffe46a", "#a8300e"], 26, { up: 120, gravity: -60 });
        this.floatText(deck, "버려짐", "bfx-float bfx-float-info");
        this.applyCommit(ev);
        await this.wait(450);
        return;
      }
      case "fatigue": {
        const p = this.refPoint({ kind: "commander", side: ev.side });
        this.floatText(p ? { x: p.x, y: p.y - 30 } : null, `피로 ${ev.damage}`, "bfx-float bfx-float-info");
        if (p) h.fx.burst(p, ["#6b5a7a", "#3a3046"], 16, { speed: 90 });
        this.source = null;
        await this.wait(350);
        return;
      }
      case "play": {
        const def = safeCard(ev.cardId);
        this.source = null;
        const handEl = ev.side === PLAYER ? this.q(`hand-${ev.iid}`) : null;
        const from = handEl?.getBoundingClientRect() ?? this.q(`eback-${Math.max(0, h.getView().sides[ev.side].handCount - 1)}`)?.getBoundingClientRect() ?? null;
        if (def && (ev.side !== PLAYER || def.type !== "soldier")) {
          // 상대가 낸 카드·전술·장비는 가운데에 크게 보여 준다
          this.applyCommit(ev);
          h.setPreview({ cardId: ev.cardId, side: ev.side });
          const pv = this.q("preview");
          if (pv && from) {
            const to = pv.getBoundingClientRect();
            pv.animate(
              [
                {
                  transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${from.width / to.width})`,
                  opacity: 0.4,
                },
                { transform: "translate(0,0) scale(1)", opacity: 1 },
              ],
              { duration: this.d(280), easing: "cubic-bezier(.2,.8,.2,1)" },
            );
          }
          await this.wait(ev.side === PLAYER ? 520 : 1000);
          const pvRect = this.q("preview")?.getBoundingClientRect() ?? null;
          if (def.type === "soldier") {
            this.pendingSpawn = pvRect;
            h.setPreview(null);
          } else {
            const c = this.center(pvRect);
            if (c) {
              h.fx.burst(c, CLASS_COLORS[def.cardClass], 30, { speed: 220, gravity: 0 });
              this.source = { origin: c, style: cardStyle(ev.cardId), rain: ev.cardId === "arrow_storm" };
            }
            pv?.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.25)" }], {
              duration: this.d(220),
              fill: "forwards",
            });
            await this.wait(160);
            h.setPreview(null);
          }
        } else {
          this.pendingSpawn = from;
          this.applyCommit(ev);
        }
        return;
      }
      case "summon": {
        const spawn =
          this.pendingSpawn ??
          (this.source ? new DOMRect(this.source.origin.x - 20, this.source.origin.y - 26, 40, 52) : null) ??
          this.q(`cmd-${ev.side}`)?.getBoundingClientRect() ??
          null;
        this.pendingSpawn = null;
        const key = `sol-${ev.iid}`;
        this.applyCommit(ev, spawn ? new Map([[key, spawn]]) : undefined);
        await this.wait(280);
        const el = this.q(key);
        const c = this.center(el);
        if (c && el) {
          const def = safeCard(ev.cardId);
          const r = el.getBoundingClientRect();
          h.fx.pillar({ x: c.x, y: r.bottom }, r.width * 0.9, def?.cardClass === "mage" ? "rgba(190,150,255,0.9)" : "rgba(255,240,180,0.9)");
          h.fx.dust({ x: c.x, y: r.bottom - 4 }, r.width);
          this.pop(el, "brightness(1.5)");
        }
        await this.wait(260);
        return;
      }
      case "equip": {
        this.applyCommit(ev);
        const el = this.q(`weapon-${ev.side}`);
        this.pop(el, "brightness(2)");
        const c = this.center(el);
        if (c) h.fx.burst(c, ["#ffe682", "#ffffff", "#d9a423"], 20, { speed: 140, gravity: 0 });
        await this.wait(420);
        return;
      }
      case "weapon-break": {
        const el = this.q(`weapon-${ev.side}`);
        const c = this.center(el);
        if (c) h.fx.burst(c, ["#9aa8ba", "#e4ecf4", "#475266"], 22, { shard: true, speed: 200 });
        this.applyCommit(ev);
        await this.wait(300);
        return;
      }
      case "attack": {
        this.source = null;
        const aEl = this.q(refKey(ev.attacker));
        const tEl = this.q(refKey(ev.target));
        const a = this.center(aEl);
        const t = this.center(tEl);
        const v = h.getView();
        const atkRef = ev.attacker;
        const attackerSol =
          atkRef.kind === "soldier" ? v.sides[atkRef.side].board.find((b) => b.iid === atkRef.iid) : undefined;
        const ranged = attackerSol?.keywords.includes("ranged") ?? false;
        const power = attackerSol?.attack ?? v.sides[ev.attacker.side].commander.attack;
        this.applyCommit(ev);
        if (a && t && aEl) {
          if (ranged) {
            aEl.animate([{ transform: "scale(1)" }, { transform: "scale(1.08) translateY(-4px)" }, { transform: "scale(1)" }], {
              duration: this.d(260),
            });
            await h.fx.projectile(a, t, "arrow", "#f5ecd0", this.h.reduced ? 0.15 : 0.3, 36);
          } else {
            const dx = (t.x - a.x) * 0.78;
            const dy = (t.y - a.y) * 0.78;
            aEl.style.zIndex = "30";
            const anim = aEl.animate(
              [
                { transform: "translate(0,0) scale(1)" },
                { transform: `translate(${-dx * 0.08}px, ${-dy * 0.08}px) scale(1.12)`, offset: 0.25 },
                { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, offset: 0.5, easing: "ease-out" },
                { transform: "translate(0,0) scale(1)" },
              ],
              { duration: this.d(640), easing: "ease-in" },
            );
            anim.onfinish = () => {
              aEl.style.zIndex = "";
            };
            await this.wait(320);
          }
          h.fx.burst(t, ["#ffffff", "#ffe682", "#f27a18"], 18 + power * 3, { speed: 240, gravity: 120, size: 4 });
          h.fx.ring(t, "rgba(255,240,200,0.9)", 46 + power * 4);
          this.shake(power);
        }
        return;
      }
      case "damage": {
        const p = this.refPoint(ev.target);
        await this.travel(p);
        this.applyCommit(ev);
        const el = this.q(refKey(ev.target));
        this.hitFlash(el);
        if (this.source && p) {
          const st = this.source.style;
          h.fx.burst(p, st === "fire" ? ["#f27a18", "#ffe46a", "#a8300e"] : st === "lightning" ? ["#fff27a", "#ffffff"] : [STYLE_COLOR[st], "#ffffff"], 18, {
            speed: 180,
            gravity: st === "fire" ? -60 : 100,
          });
          if (ev.target.kind === "commander") this.shake(ev.amount);
        } else if (ev.target.kind === "commander" && ev.amount >= 3) {
          this.shake(ev.amount);
        }
        if (ev.armorAbsorbed > 0) this.floatText(p ? { x: p.x - 18, y: p.y - 10 } : null, `-${ev.armorAbsorbed}`, "bfx-float bfx-float-armor");
        const hpDmg = ev.amount - ev.armorAbsorbed;
        if (hpDmg > 0) this.floatText(p ? { x: p.x + (ev.armorAbsorbed > 0 ? 14 : 0), y: p.y } : null, `-${hpDmg}`, "bfx-float bfx-float-dmg");
        await this.wait(this.source ? 160 : 240);
        return;
      }
      case "shield-break": {
        const p = this.refPoint(ev.target);
        await this.travel(p);
        if (p) {
          h.fx.burst(p, ["#bfe8ff", "#ffffff", "#7da2e8"], 26, { shard: true, speed: 260, size: 6, gravity: 300 });
          h.fx.ring(p, "rgba(191,232,255,0.9)", 54);
        }
        this.applyCommit(ev);
        this.floatText(p, "결계 파괴", "bfx-float bfx-float-info");
        await this.wait(380);
        return;
      }
      case "heal": {
        const p = this.refPoint(ev.target);
        await this.travel(p, "heal");
        this.applyCommit(ev);
        if (p) h.fx.rise(p, ["#3fc46a", "#bff7b0", "#ffffff"], 22);
        this.pop(this.q(refKey(ev.target)), "brightness(1.4) hue-rotate(60deg)");
        if (ev.amount > 0) this.floatText(p, `+${ev.amount}`, "bfx-float bfx-float-heal");
        await this.wait(380);
        return;
      }
      case "armor": {
        this.applyCommit(ev);
        const el = this.q(`armor-${ev.side}`) ?? this.q(`cmd-${ev.side}`);
        const p = this.center(this.q(`cmd-${ev.side}`));
        if (p) h.fx.ring(p, "rgba(200,215,235,0.95)", 70);
        this.pop(el, "brightness(2)");
        this.floatText(p, `방어도 +${ev.amount}`, "bfx-float bfx-float-armor");
        await this.wait(420);
        return;
      }
      case "buff": {
        const p = this.refPoint(ev.target);
        await this.travel(p, this.source?.style === "slash" ? "gold" : undefined);
        this.applyCommit(ev);
        if (p) h.fx.rise(p, ["#80ff90", "#ffe682", "#ffffff"], 18);
        this.pop(this.q(refKey(ev.target)), "brightness(1.6) drop-shadow(0 0 8px #7dff8a)");
        this.floatText(p, `+${ev.attack}/+${ev.health}`, "bfx-float bfx-float-buff");
        await this.wait(380);
        return;
      }
      case "keyword": {
        const p = this.refPoint(ev.target);
        await this.travel(p, this.source?.style === "slash" ? "gold" : undefined);
        this.applyCommit(ev);
        const label = ev.keyword === "rushThisTurn" ? "돌파" : KEYWORD_LABEL[ev.keyword];
        if (p) h.fx.ring(p, ev.keyword === "shield" ? "rgba(127,190,255,0.95)" : "rgba(255,230,130,0.95)", 50);
        this.pop(this.q(refKey(ev.target)));
        this.floatText(p, label, "bfx-float bfx-float-buff");
        await this.wait(340);
        return;
      }
      case "keyword-trigger": {
        const key = `sol-${ev.iid}`;
        const el = this.q(key);
        const p = this.center(el) ?? this.center(this.lastRects.get(key) ?? null);
        if (p) {
          this.source = { origin: p, style: cardStyle(ev.cardId) };
          this.floatText({ x: p.x, y: p.y - 26 }, ev.trigger === "onPlay" ? "출진" : "유훈", "bfx-float bfx-float-trigger");
          h.fx.ring(p, ev.trigger === "onPlay" ? "rgba(255,210,120,0.9)" : "rgba(200,180,255,0.9)", 44);
        }
        await this.wait(260);
        return;
      }
      case "hero-power": {
        const v = h.getView();
        const c = v.sides[ev.side].commander;
        const name = heroPower(c.kind, c.level).name;
        this.applyCommit(ev);
        const btn = this.q(`power-${ev.side}`);
        this.pop(btn, "brightness(2)");
        const origin = this.center(this.q(`cmd-${ev.side}`)) ?? this.center(btn);
        if (origin) {
          this.source = { origin, style: powerStyle(c.kind) };
          h.fx.ring(origin, "rgba(255,226,140,0.95)", 64);
          this.floatText({ x: origin.x, y: origin.y - 40 }, name, "bfx-float bfx-float-trigger");
          this.pendingSpawn = this.q(`cmd-${ev.side}`)?.getBoundingClientRect() ?? null;
        }
        await this.wait(380);
        return;
      }
      case "mana": {
        this.applyCommit(ev);
        const el = this.q(`mana-${ev.side}`);
        this.pop(el, "brightness(2)");
        const p = this.center(el);
        if (p) h.fx.burst(p, ["#3f8cff", "#bfe8ff"], 16, { speed: 120, gravity: 0 });
        await this.wait(320);
        return;
      }
      case "discount": {
        this.applyCommit(ev);
        const p = this.center(this.q(`cmd-${ev.side}`));
        if (p) h.fx.rise(p, ["#a77bdc", "#e2c4ff"], 16);
        this.floatText(p, `다음 전술 -${ev.total}`, "bfx-float bfx-float-buff");
        await this.wait(320);
        return;
      }
      case "death": {
        const key = `sol-${ev.iid}`;
        const el = this.q(key);
        const p = this.center(el);
        if (el) {
          this.lastRects.set(key, el.getBoundingClientRect());
          el.classList.add("bfx-dying");
          const def = safeCard(ev.cardId);
          if (p) {
            h.fx.burst(p, [...(def ? CLASS_COLORS[def.cardClass] : ["#999999"]), "#3b3026", "#7a6a58"], 34, {
              shard: true,
              speed: 160,
              gravity: 220,
              size: 5,
              spread: 22,
            });
          }
          await this.wait(520);
        }
        this.applyCommit(ev);
        await this.wait(120);
        return;
      }
      case "game-over":
        this.applyCommit(ev);
        await this.wait(400);
        return;
    }
  }

  /** 최종 서버 상태로 맞춘다 */
  settle(final: PublicBattleView): void {
    this.flipCommit(final);
  }
}
