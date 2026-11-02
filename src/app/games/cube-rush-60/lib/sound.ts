// Cube Rush 60 — WebAudio 합성 사운드 (외부 파일 금지)
// 선택·제거·콤보·경고·게임오버 + ON/OFF 토글

export type SoundKind = "select" | "remove" | "combo" | "warning" | "gameover" | "miss";

let enabled = true;
let ctx: AudioContext | null = null;

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    if (typeof window === "undefined") return null;
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(
  ac: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  type: OscillatorType,
  volume: number,
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

export function playSound(kind: SoundKind, comboLevel = 0): void {
  const ac = audio();
  if (!ac) return;
  try {
    const t = ac.currentTime;
    switch (kind) {
      case "select":
        tone(ac, 660, t, 0.09, "sine", 0.18);
        break;
      case "miss":
        tone(ac, 180, t, 0.14, "sawtooth", 0.1);
        break;
      case "remove":
        tone(ac, 523.25, t, 0.12, "triangle", 0.22);
        tone(ac, 783.99, t + 0.07, 0.14, "triangle", 0.22);
        break;
      case "combo": {
        const base = 523.25 * Math.pow(2, Math.min(comboLevel, 6) / 12);
        tone(ac, base, t, 0.1, "square", 0.12);
        tone(ac, base * 1.25, t + 0.06, 0.1, "square", 0.12);
        tone(ac, base * 1.5, t + 0.12, 0.16, "square", 0.12);
        break;
      }
      case "warning":
        tone(ac, 440, t, 0.12, "square", 0.14);
        tone(ac, 440, t + 0.16, 0.12, "square", 0.14);
        break;
      case "gameover":
        tone(ac, 392, t, 0.18, "triangle", 0.2);
        tone(ac, 329.63, t + 0.18, 0.18, "triangle", 0.2);
        tone(ac, 261.63, t + 0.36, 0.32, "triangle", 0.2);
        break;
    }
  } catch {
    // 오디오 실패는 게임 진행에 영향 없음
  }
}
