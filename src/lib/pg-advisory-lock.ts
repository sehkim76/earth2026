import { createHash } from "node:crypto";

type RawClient = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
};

/** Neon Postgres용 네임드 락. MySQL GET_LOCK 대체. 트랜잭션 종료 시 자동 해제된다. */
export const pgLockKey = (name: string): bigint => {
  const hex = createHash("sha1").update(name).digest("hex").slice(0, 15);
  return BigInt(`0x${hex}`);
};

export const acquirePgLock = async (tx: RawClient, name: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${pgLockKey(name)})`;
};
