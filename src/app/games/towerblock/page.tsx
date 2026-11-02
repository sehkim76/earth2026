import TowerBlock from "@/components/TowerBlock";

interface PageProps {
  searchParams: Promise<{
    eventkey?: string;
    exitUrl?: string;
    userId?: string;
    nickname?: string;
    from?: string;
  }>;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const eventKey = params.eventkey || "BUSANCITIZEN_STACK";
  const exitUrl = params.exitUrl || "/map";
  const userId = params.userId;
  const nickname = params.nickname;
  const from = params.from;

  return (
    <TowerBlock
      eventKey={eventKey}
      userId={userId}
      nickname={nickname}
      exitUrl={exitUrl}
      from={from}
    />
  );
}
