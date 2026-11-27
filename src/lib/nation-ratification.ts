import prisma from "@/lib/prismadb";
import { acquirePgLock } from "@/lib/pg-advisory-lock";
import type { Tx } from "@/lib/territory";

export const VOTING_PERIOD_MS = 24 * 60 * 60 * 1000;
export const votingClosed = (createdAt: Date): boolean => Date.now() >= createdAt.getTime() + VOTING_PERIOD_MS;
export const proclamationLock = (missionKey: string, seasonId: number): string => `proclamation:${missionKey}:${seasonId}`;

export async function ratify(tx: Tx, id: string): Promise<void> {
  const proposal = await tx.territoryDeclaration.findUniqueOrThrow({
    where: { id }, include: { votes: true },
  });
  if (proposal.status !== "pending" || proposal.votes.some(v => v.consent === false)) return;
  const consenting = proposal.votes.filter(v => v.consent === true);
  if (consenting.length !== proposal.votes.length && !votingClosed(proposal.createdAt)) return;
  const nation = await tx.territoryNation.create({
    data: {
      name: proposal.name, leaderUserId: proposal.proposerId,
      missionKey: proposal.missionKey, seasonId: proposal.seasonId,
      members: { create: consenting.map(v => ({
        userId: v.userId, role: v.userId === proposal.proposerId ? "leader" : "member",
      })) },
    },
  });
  await tx.territoryDeclaration.update({ where: { id }, data: { nationId: nation.id, status: "approved" } });
}

/** 무접속 중에도 만료를 정산한다. 중복 실행과 마감 직전 투표는 같은 잠금으로 직렬화한다. */
export async function settleExpiredDeclarations(missionKey?: string): Promise<void> {
  const due = await prisma.territoryDeclaration.findMany({
    where: { missionKey, status: "pending", createdAt: { lte: new Date(Date.now() - VOTING_PERIOD_MS) } },
    select: { id: true, missionKey: true, seasonId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const row of due) {
    await prisma.$transaction(async tx => {
      await acquirePgLock(tx, proclamationLock(row.missionKey, row.seasonId));
      await ratify(tx, row.id);
    }, { timeout: 20000 });
  }
}

export async function handler(): Promise<void> {
  await settleExpiredDeclarations();
}
