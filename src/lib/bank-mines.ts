import dataset from "../../public/map-assets/bank-mines.json";
import { workerCargo, type BankMineView, type GatherJob, type ResourceNode } from "@/lib/city";
import { acquirePgLock } from "@/lib/pg-advisory-lock";
import prisma from "@/lib/prismadb";
import type { Tx } from "@/lib/territory";

const CAPACITY = 500;
const COOLDOWN_MS = 15 * 60_000;

interface Site {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

const sites = new Map<string, Site>();
for (const [key, lat, lon, name] of dataset.sites) {
  if (typeof key !== "string" || typeof lat !== "number" || typeof lon !== "number" || typeof name !== "string") {
    throw new Error("Invalid bank location");
  }
  const id = `bank:${key}`;
  sites.set(id, { id, lat, lon, name });
}

type Reservation = Pick<GatherJob, "id" | "arriveAt" | "doneAt" | "amount">;
interface Stock {
  mined: number;
  reservations: Reservation[];
  respawnAt: number | null;
}
interface StoredStock {
  mined: number;
  reservations: unknown;
  respawnAt: Date | null;
}

const freshStock = (): Stock => ({ mined: 0, reservations: [], respawnAt: null });

/** 종료된 예약을 실제 채굴 완료 시각에 정산한다. 플레이어의 접속/귀환 시각과 독립적이다. */
function stockAt(row: StoredStock | undefined | null, now: number): Stock {
  if (!row || (row.respawnAt && row.respawnAt.getTime() <= now)) return freshStock();
  const state: Stock = { mined: row.mined, reservations: [], respawnAt: row.respawnAt?.getTime() ?? null };
  let lastFinish = 0;
  for (const job of row.reservations as Reservation[]) {
    if (job.doneAt > now) state.reservations.push(job);
    else {
      state.mined += job.amount;
      lastFinish = Math.max(lastFinish, job.doneAt);
    }
  }
  if (lastFinish && state.mined === CAPACITY) state.respawnAt = lastFinish + COOLDOWN_MS;
  return state.respawnAt !== null && state.respawnAt <= now ? freshStock() : state;
}

function mineNode(site: Site, stock: Stock, now: number): ResourceNode {
  const mine: BankMineView = {
    name: site.name,
    remaining: CAPACITY - stock.mined,
    available: CAPACITY - stock.mined,
    respawnAt: stock.respawnAt,
  };
  for (const job of stock.reservations) {
    mine.available -= job.amount;
    mine.remaining -= workerCargo(job, now);
  }
  return { id: site.id, lat: site.lat, lon: site.lon, amount: CAPACITY, kind: "gold", level: 1, expiresAt: Number.MAX_SAFE_INTEGER, mine };
}

export function bankNodeById(id: string): ResourceNode | null {
  const site = sites.get(id);
  return site ? mineNode(site, freshStock(), 0) : null;
}

export async function bankMinesInBounds(missionKey: string, south: number, west: number, north: number, east: number): Promise<ResourceNode[]> {
  const visible = [...sites.values()].filter(s => s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east);
  if (!visible.length) return [];
  const rows = await prisma.territoryGoldMine.findMany({ where: { missionKey, nodeId: { in: visible.map(s => s.id) } } });
  const byId = new Map(rows.map(row => [row.nodeId, row]));
  const now = Date.now();
  return visible.map(site => mineNode(site, stockAt(byId.get(site.id), now), now));
}

export async function lockBankMine(tx: Tx, missionKey: string, nodeId: string): Promise<void> {
  await acquirePgLock(tx, `gold-mine:${missionKey}:${nodeId}`);
}

export async function loadBankStock(tx: Tx, missionKey: string, nodeId: string, now: number): Promise<Stock> {
  const row = await tx.territoryGoldMine.findUnique({ where: { missionKey_nodeId: { missionKey, nodeId } } });
  return stockAt(row, now);
}

export function availableGold(stock: Stock): number {
  return CAPACITY - stock.mined - stock.reservations.reduce((sum, job) => sum + job.amount, 0);
}

export function reserveGold(stock: Stock, job: GatherJob): void {
  stock.reservations.push({ id: job.id, amount: job.amount, arriveAt: job.arriveAt, doneAt: job.doneAt });
}

export function releaseGold(stock: Stock, jobId: string, now: number): void {
  const index = stock.reservations.findIndex(job => job.id === jobId);
  if (index < 0) return;
  const [job] = stock.reservations.splice(index, 1);
  stock.mined += workerCargo(job!, now);
}

export async function saveBankStock(tx: Tx, missionKey: string, nodeId: string, stock: Stock): Promise<void> {
  const data = {
    mined: stock.mined, reservations: stock.reservations,
    respawnAt: stock.respawnAt === null ? null : new Date(stock.respawnAt),
  };
  await tx.territoryGoldMine.upsert({
    where: { missionKey_nodeId: { missionKey, nodeId } },
    create: { missionKey, nodeId, ...data }, update: data,
  });
}
