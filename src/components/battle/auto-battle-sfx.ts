// 오토배틀 효과음 — WebAudio 합성음만 사용 (외부 음원 없음).
// 같은 종류 소리가 몰리면(4배속) 짧은 간격으로 걸러 귀를 덜 피곤하게 한다.

type SfxName = "hit" | "crit" | "arrow" | "magic" | "death" | "skill" | "heal" | "win" | "lose";

const MUTE_KEY = "tribes.autoBattle.muted";
const MIN_GAP_MS: Record<SfxName, number> = {
  hit: 55,
  crit: 70,
  arrow: 60,
  magic: 70,
  death: 90,
  skill: 200,
  heal: 200,
  win: 500,
  lose: 500,
};

let ctx: AudioContext | null = null;
let muted = false;
const lastPlayed = new Map<SfxName, number>();

export function loadSfxMuted(): boolean {
  try {
    muted = window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    muted = false;
  }
  return muted;
}

export function setSfxMuted(next: boolean): void {
  muted = next;
  try {
    window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  } catch {
    // 저장 실패는 무시 (이번 화면에서만 적용)
  }
}

function audio(): AudioContext | null {
  if (muted || typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

function tone(
  ac: AudioContext,
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
  delay = 0,
): void {
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(ac: AudioContext, dur: number, gain: number, filterHz: number, type: BiquadFilterType = "lowpass"): void {
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = filterHz;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(ac.destination);
  src.start();
}

export function playSfx(name: SfxName): void {
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < MIN_GAP_MS[name]) return;
  const ac = audio();
  if (!ac) return;
  lastPlayed.set(name, now);
  switch (name) {
    case "hit":
      noise(ac, 0.08, 0.35, 1800);
      tone(ac, 180, 0.08, "square", 0.08, 90);
      break;
    case "crit":
      noise(ac, 0.12, 0.45, 2600);
      tone(ac, 320, 0.12, "square", 0.1, 120);
      break;
    case "arrow":
      noise(ac, 0.14, 0.18, 4000, "highpass");
      break;
    case "magic":
      tone(ac, 520, 0.22, "sine", 0.12, 1200);
      tone(ac, 780, 0.18, "triangle", 0.06, 1600, 0.03);
      break;
    case "death":
      tone(ac, 140, 0.32, "sawtooth", 0.1, 45);
      noise(ac, 0.2, 0.25, 700);
      break;
    case "skill":
      tone(ac, 392, 0.35, "triangle", 0.1);
      tone(ac, 494, 0.35, "triangle", 0.08, undefined, 0.06);
      tone(ac, 587, 0.45, "triangle", 0.08, undefined, 0.12);
      break;
    case "heal":
      tone(ac, 660, 0.3, "sine", 0.08, 990);
      break;
    case "win":
      [523, 659, 784, 1047].forEach((f, i) => tone(ac, f, 0.28, "square", 0.06, undefined, i * 0.12));
      break;
    case "lose":
      [392, 330, 262].forEach((f, i) => tone(ac, f, 0.4, "triangle", 0.08, undefined, i * 0.18));
      break;
  }
}
