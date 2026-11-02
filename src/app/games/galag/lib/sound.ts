export type GalagSoundKind = "shoot" | "enemyShoot" | "enemyDown" | "playerDown" | "gameover";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
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

export function unlockAudio(): void {
  audio();
}

function envelope(ac: AudioContext, startAt: number, duration: number, volume: number): GainNode {
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  gain.connect(ac.destination);
  return gain;
}

function sweep(
  ac: AudioContext,
  from: number,
  to: number,
  startAt: number,
  duration: number,
  type: OscillatorType,
  volume: number,
): void {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, from), startAt);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), startAt + duration);
  osc.connect(envelope(ac, startAt, duration, volume));
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

function noise(
  ac: AudioContext,
  startAt: number,
  duration: number,
  volume: number,
  filterFreq: number,
): void {
  const length = Math.max(1, Math.floor(ac.sampleRate * duration));
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = filterFreq;
  src.connect(filter);
  filter.connect(envelope(ac, startAt, duration, volume));
  src.start(startAt);
}

export function playGalagSound(kind: GalagSoundKind): void {
  const ac = audio();
  if (!ac) return;
  try {
    const t = ac.currentTime;
    switch (kind) {
      case "shoot":
        sweep(ac, 880, 220, t, 0.12, "square", 0.08);
        break;
      case "enemyShoot":
        sweep(ac, 440, 110, t, 0.16, "sawtooth", 0.06);
        break;
      case "enemyDown":
        noise(ac, t, 0.22, 0.18, 3200);
        sweep(ac, 620, 90, t, 0.2, "triangle", 0.14);
        break;
      case "playerDown":
        noise(ac, t, 0.55, 0.22, 1400);
        sweep(ac, 320, 40, t, 0.55, "sawtooth", 0.14);
        break;
      case "gameover":
        sweep(ac, 392, 392, t, 0.16, "triangle", 0.16);
        sweep(ac, 329.63, 329.63, t + 0.16, 0.16, "triangle", 0.16);
        sweep(ac, 261.63, 261.63, t + 0.32, 0.3, "triangle", 0.16);
        break;
    }
  } catch {
    return;
  }
}
