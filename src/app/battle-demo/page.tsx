import { notFound } from "next/navigation";

import { BattleDemo } from "@/components/battle/BattleDemo";

export const dynamic = "force-dynamic";

interface BattleDemoPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** 개발용 전투 데모 (브라우저 안 엔진+AI). 운영에서는 404. */
export default async function BattleDemoPage({ searchParams }: BattleDemoPageProps) {
  if (process.env.NEXT_PUBLIC_STAGE === "production") {
    notFound();
  }
  const sp = await searchParams;
  return (
    <BattleDemo
      kind={one(sp.kind) ?? "lord"}
      level={Number(one(sp.level) ?? "3")}
      tier={Number(one(sp.tier) ?? "2")}
      seed={Number(one(sp.seed) ?? "20261117")}
    />
  );
}
