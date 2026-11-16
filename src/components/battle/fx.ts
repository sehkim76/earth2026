// 전투 효과용 캔버스 입자 엔진 (픽셀 느낌의 사각 입자, 번개, 화살 궤적, 빛 기둥).
// 살아있는 효과가 있을 때만 requestAnimationFrame 을 돈다.

export interface Point {
  x: number;
  y: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  gravity: number;
  drag: number;
  shard: boolean;
  rot: number;
  vr: number;
}

interface Bolt {
  pts: Point[];
  life: number;
  max: number;
  color: string;
  width: number;
}

interface Pillar {
  x: number;
  y: number;
  w: number;
  h: number;
  life: number;
  max: number;
  color: string;
}

interface Projectile {
  from: Point;
  to: Point;
  t: number;
  dur: number;
  color: string;
  kind: "arrow" | "orb" | "fire";
  arc: number;
  trail: Point[];
  done: () => void;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  max: number;
  color: string;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class FxEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private bolts: Bolt[] = [];
  private pillars: Pillar[] = [];
  private projectiles: Projectile[] = [];
  private rings: Ring[] = [];
  private raf = 0;
  private last = 0;
  private dpr = 1;
  /** 입자 수 배율 (모션 줄이기) */
  density = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  /** 화면 좌표(client) → 캔버스 좌표 */
  local(p: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: p.x - rect.left, y: p.y - rect.top };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.particles = [];
    this.bolts = [];
    this.pillars = [];
    this.projectiles = [];
    this.rings = [];
  }

  private kick(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private n(count: number): number {
    return Math.max(1, Math.round(count * this.density));
  }

  burst(
    at: Point,
    colors: string[],
    count: number,
    opts: { speed?: number; size?: number; life?: number; gravity?: number; up?: number; shard?: boolean; spread?: number } = {},
  ): void {
    const p = this.local(at);
    const speed = opts.speed ?? 180;
    const spread = opts.spread ?? 10;
    for (let i = 0; i < this.n(count); i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.3, 1) * speed;
      const life = (opts.life ?? 0.7) * rand(0.6, 1.2);
      this.particles.push({
        x: p.x + rand(-spread, spread),
        y: p.y + rand(-spread, spread),
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - (opts.up ?? 0),
        life,
        max: life,
        size: (opts.size ?? 4) * rand(0.6, 1.3),
        color: colors[i % colors.length],
        gravity: opts.gravity ?? 260,
        drag: 2.2,
        shard: opts.shard ?? false,
        rot: rand(0, Math.PI),
        vr: rand(-10, 10),
      });
    }
    this.kick();
  }

  /** 소환 먼지 (바닥에서 옆으로 퍼짐) */
  dust(at: Point, width: number): void {
    const p = this.local(at);
    for (let i = 0; i < this.n(18); i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const life = rand(0.4, 0.8);
      this.particles.push({
        x: p.x + rand(-width / 2, width / 2),
        y: p.y + rand(-4, 4),
        vx: dir * rand(30, 120),
        vy: rand(-60, -10),
        life,
        max: life,
        size: rand(3, 6),
        color: ["#c9b48c", "#a68456", "#e2d3b0"][i % 3],
        gravity: 60,
        drag: 3,
        shard: false,
        rot: 0,
        vr: 0,
      });
    }
    this.kick();
  }

  /** 위로 오르는 입자 (치유·강화) */
  rise(at: Point, colors: string[], count: number, width = 40): void {
    const p = this.local(at);
    for (let i = 0; i < this.n(count); i++) {
      const life = rand(0.6, 1.1);
      this.particles.push({
        x: p.x + rand(-width / 2, width / 2),
        y: p.y + rand(-10, 20),
        vx: rand(-10, 10),
        vy: rand(-110, -50),
        life,
        max: life,
        size: rand(2, 5),
        color: colors[i % colors.length],
        gravity: -20,
        drag: 0.5,
        shard: false,
        rot: 0,
        vr: 0,
      });
    }
    this.kick();
  }

  pillar(at: Point, width: number, color: string, life = 0.6): void {
    const p = this.local(at);
    const h = Math.max(200, p.y + 40);
    this.pillars.push({ x: p.x - width / 2, y: p.y - h + 20, w: width, h, life, max: life, color });
    this.kick();
  }

  ring(at: Point, color: string, maxR = 60, life = 0.45): void {
    const p = this.local(at);
    this.rings.push({ x: p.x, y: p.y, r: 4, maxR, life, max: life, color });
    this.kick();
  }

  lightning(from: Point, to: Point, color = "#fff27a", life = 0.35): void {
    const a = this.local(from);
    const b = this.local(to);
    const segs = 9;
    const pts: Point[] = [];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const off = i === 0 || i === segs ? 0 : rand(-1, 1) * Math.min(26, len * 0.12);
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
    }
    this.bolts.push({ pts, life, max: life, color, width: 3 });
    this.bolts.push({ pts, life: life * 0.8, max: life * 0.8, color: "#ffffff", width: 1 });
    this.kick();
  }

  /** 투사체 (화살·마력 구슬·불덩이). 도착하면 resolve. */
  projectile(from: Point, to: Point, kind: Projectile["kind"], color: string, dur = 0.32, arc = 0): Promise<void> {
    return new Promise((resolve) => {
      this.projectiles.push({
        from: this.local(from),
        to: this.local(to),
        t: 0,
        dur,
        color,
        kind,
        arc,
        trail: [],
        done: resolve,
      });
      this.kick();
    });
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // 빛 기둥
    this.pillars = this.pillars.filter((pl) => {
      pl.life -= dt;
      if (pl.life <= 0) return false;
      const k = pl.life / pl.max;
      const g = ctx.createLinearGradient(pl.x, 0, pl.x + pl.w, 0);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, pl.color);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = Math.min(1, k * 1.6) * 0.85;
      ctx.fillStyle = g;
      const w = pl.w * (0.6 + 0.4 * k);
      ctx.fillRect(pl.x + (pl.w - w) / 2, pl.y, w, pl.h);
      ctx.globalAlpha = 1;
      return true;
    });

    // 고리
    this.rings = this.rings.filter((r) => {
      r.life -= dt;
      if (r.life <= 0) return false;
      const k = 1 - r.life / r.max;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 4 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r + (r.maxR - r.r) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return true;
    });

    // 번개
    this.bolts = this.bolts.filter((b) => {
      b.life -= dt;
      if (b.life <= 0) return false;
      ctx.globalAlpha = Math.min(1, (b.life / b.max) * 1.5);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      b.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      return true;
    });

    // 투사체
    this.projectiles = this.projectiles.filter((pr) => {
      pr.t += dt / pr.dur;
      const t = Math.min(1, pr.t);
      const x = pr.from.x + (pr.to.x - pr.from.x) * t;
      const y = pr.from.y + (pr.to.y - pr.from.y) * t - Math.sin(t * Math.PI) * pr.arc;
      pr.trail.push({ x, y });
      if (pr.trail.length > 10) pr.trail.shift();
      for (let i = 0; i < pr.trail.length; i++) {
        const p = pr.trail[i];
        const k = (i + 1) / pr.trail.length;
        ctx.globalAlpha = k * 0.8;
        ctx.fillStyle = pr.kind === "arrow" ? "#f5ecd0" : pr.color;
        const s = pr.kind === "arrow" ? 2 : 3 + k * (pr.kind === "fire" ? 7 : 5);
        ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
      }
      ctx.globalAlpha = 1;
      if (pr.kind === "arrow") {
        const prev = pr.trail.length > 1 ? pr.trail[pr.trail.length - 2] : pr.from;
        const ang = Math.atan2(y - prev.y, x - prev.x);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = "#7d5024";
        ctx.fillRect(-16, -1, 16, 2);
        ctx.fillStyle = "#dfe7f0";
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(-2, -4);
        ctx.lineTo(-2, 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-18, -3, 4, 2);
        ctx.fillRect(-18, 1, 4, 2);
        ctx.restore();
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = pr.color;
        ctx.shadowBlur = 16;
        const s = pr.kind === "fire" ? 10 : 8;
        ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
        ctx.shadowBlur = 0;
        if (Math.random() < 0.6 * this.density) {
          this.particles.push({
            x,
            y,
            vx: rand(-30, 30),
            vy: rand(-30, 30),
            life: 0.3,
            max: 0.3,
            size: 3,
            color: pr.color,
            gravity: pr.kind === "fire" ? -80 : 0,
            drag: 2,
            shard: false,
            rot: 0,
            vr: 0,
          });
        }
      }
      if (pr.t >= 1) {
        pr.done();
        return false;
      }
      return true;
    });

    // 입자
    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) return false;
      p.vx -= p.vx * p.drag * dt;
      p.vy -= p.vy * p.drag * dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const k = p.life / p.max;
      ctx.globalAlpha = Math.min(1, k * 1.8);
      ctx.fillStyle = p.color;
      if (p.shard) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(-p.size, -p.size * 0.4);
        ctx.lineTo(p.size, 0);
        ctx.lineTo(-p.size * 0.3, p.size * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        const s = Math.max(1, Math.round(p.size * (0.5 + 0.5 * k)));
        ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
      }
      return true;
    });
    ctx.globalAlpha = 1;

    const alive =
      this.particles.length + this.bolts.length + this.pillars.length + this.projectiles.length + this.rings.length;
    if (alive > 0) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.raf = 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };
}
