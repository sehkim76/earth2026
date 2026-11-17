"use client";

import { MAX_MANA } from "@/lib/battle";

import { BattleCardFace } from "@/components/battle/BattleCardFace";
import { KEYWORD_HELP, ON_DEATH_HELP, ON_PLAY_HELP } from "@/components/battle/card-help";
import { PixelArt } from "@/components/battle/PixelArt";
import styles from "@/components/battle/battle.module.css";

const HELP_SEEN_KEY = "battle-help-seen";
const COACH_OFF_KEY = "battle-coach-off";

export function readHelpSeen(): boolean {
  try {
    return window.localStorage.getItem(HELP_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHelpSeen(): void {
  try {
    window.localStorage.setItem(HELP_SEEN_KEY, "1");
  } catch {
    // 무시
  }
}

export function readCoachOff(): boolean {
  try {
    return window.localStorage.getItem(COACH_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCoachOff(off: boolean): void {
  try {
    window.localStorage.setItem(COACH_OFF_KEY, off ? "1" : "0");
  } catch {
    // 무시
  }
}

interface BattleHelpProps {
  coachOff: boolean;
  onCoachChange: (off: boolean) => void;
  onClose: () => void;
}

/** 처음 하는 사람을 위한 전투 규칙 안내 */
export function BattleHelp({ coachOff, onCoachChange, onClose }: BattleHelpProps) {
  const terms = [KEYWORD_HELP.guard, KEYWORD_HELP.rush, KEYWORD_HELP.shield, KEYWORD_HELP.ranged, ON_PLAY_HELP, ON_DEATH_HELP];
  return (
    <div className={styles.helpBackdrop} data-bmodal="1" onClick={onClose}>
      <div className={styles.helpSheet} role="dialog" aria-label="카드 전투 도움말" onClick={(e) => e.stopPropagation()}>
        <div className={styles.helpTop}>
          <b>카드 전투 하는 법</b>
          <button type="button" className={styles.smallBtn} onClick={onClose}>
            닫기
          </button>
        </div>
        <div className={styles.helpScroll}>
          <section>
            <h3>이기는 방법</h3>
            <p>
              적 지휘관의 <b>체력</b>을 0으로 만들면 승리, 내 지휘관 체력이 0이 되면 패배합니다.
            </p>
          </section>

          <section>
            <h3>한 턴에 하는 일</h3>
            <ol className={styles.helpSteps}>
              <li>
                턴이 시작되면 카드 1장을 뽑고 <b>마나</b>가 1개씩 늘어납니다 (최대 {MAX_MANA}개).
              </li>
              <li>
                마나를 써서 카드를 냅니다. 손패의 카드를 <b>위로 끌어 놓으면</b> 나갑니다.
              </li>
              <li>
                필드의 병사로 적을 <b>공격</b>합니다. 공격할 수 있는 병사는 빛납니다. 적에게 끌어 놓으세요.
              </li>
              <li>
                다 했으면 <b>턴 종료</b>를 누릅니다. 한 턴은 45초입니다.
              </li>
            </ol>
          </section>

          <section>
            <h3>카드 보는 법</h3>
            <div className={styles.helpCardRow}>
              <BattleCardFace cardId="shield_bearer" width={140} />
              <ul className={styles.helpLegend}>
                <li>
                  <span className={styles.legendCost}>2</span>
                  <span>
                    왼쪽 위: 낼 때 드는 <b>마나</b>
                  </span>
                </li>
                <li>
                  <span className={styles.legendAtk}>2</span>
                  <span>
                    왼쪽 아래: <b>공격력</b> (주는 피해)
                  </span>
                </li>
                <li>
                  <span className={styles.legendHp}>3</span>
                  <span>
                    오른쪽 아래: <b>체력</b> (0이 되면 쓰러짐)
                  </span>
                </li>
                <li>가운데 글: 카드 효과</li>
              </ul>
            </div>
            <ul className={styles.helpList}>
              <li>
                <b>병사</b>: 필드에 남아 싸웁니다. 낸 턴에는 쉬고 다음 턴부터 공격합니다.
              </li>
              <li>
                <b>전술</b>: 효과를 한 번 쓰고 사라집니다.
              </li>
              <li>
                <b>장비</b>: 지휘관이 무기를 들어 직접 공격합니다. 오른쪽 아래 숫자는 사용 횟수.
              </li>
            </ul>
          </section>

          <section>
            <h3>공격하면</h3>
            <p>
              공격한 쪽과 맞은 쪽이 <b>서로 공격력만큼</b> 체력이 깎입니다. 적 지휘관을 바로 때릴 수도 있지만, 적에게 <b>수호</b>{" "}
              병사가 있으면 그 병사부터 쓰러뜨려야 합니다.
            </p>
          </section>

          <section>
            <h3>지휘관 능력</h3>
            <p>
              오른쪽 아래 둥근 버튼. 마나 2개로 턴마다 한 번 쓸 수 있습니다. 지휘관마다 능력이 다르고, 레벨이 오르면 강해집니다.
            </p>
          </section>

          <section>
            <h3>특수 능력</h3>
            <ul className={styles.helpTerms}>
              {terms.map((t) => (
                <li key={t.name}>
                  <PixelArt name={t.icon} scale={2} />
                  <b>{t.name}</b>
                  <span>{t.desc}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>조작</h3>
            <ul className={styles.helpList}>
              <li>카드·병사·지휘관을 <b>누르면</b> 설명이 나옵니다.</li>
              <li>
                카드를 <b>길게 누르면</b> 크게 볼 수 있습니다.
              </li>
              <li>끌기 대신 누르고 → 대상을 눌러도 됩니다.</li>
            </ul>
          </section>

          <label className={styles.helpToggle}>
            <input type="checkbox" checked={!coachOff} onChange={(e) => onCoachChange(!e.target.checked)} />
            화면 아래에 다음 할 일 안내 보기
          </label>
          <p className={styles.helpNote}>도움말을 보는 동안에도 턴 시간은 흐릅니다. 오른쪽 위 「? 도움말」로 언제든 다시 볼 수 있습니다.</p>
        </div>
      </div>
    </div>
  );
}
