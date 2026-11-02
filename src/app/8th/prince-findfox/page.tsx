import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const getSingleParam = (value: string | string[] | undefined): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }

  return undefined;
};

export default async function PrinceFindfoxPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  let sessionUserId: string | null = null;

  try {
    const session = await getServerSession(authOptions);
    sessionUserId = session?.user?.id || null;
  } catch {
    sessionUserId = null;
  }

  console.log("[prince-findfox] session snapshot", {
    hasSessionUserId: Boolean(sessionUserId),
    sessionUserId,
  });

  const host = getSingleParam(params.host);
  const exitUrl = getSingleParam(params.exitUrl) || "/ranking";
  const eventKey = getSingleParam(params.eventkey) || getSingleParam(params.EventKey);

  const iframeParams = new URLSearchParams();

  if (host === "web") {
    iframeParams.set("host", "web");
    iframeParams.set("exitUrl", exitUrl);
  }

  if (eventKey) {
    iframeParams.set("eventkey", eventKey);
  }

  if (sessionUserId) {
    iframeParams.set("userid", sessionUserId);
  }

  console.log("[prince-findfox] iframe params", {
    host,
    exitUrl,
    eventKey,
    forwardedUserId: sessionUserId,
  });

  const iframeQuery = iframeParams.toString();
  const iframeSrc = iframeQuery
    ? `/prince-findfox/index.html?${iframeQuery}`
    : "/prince-findfox/index.html";

  return (
    <main className="h-screen w-full bg-black">
      <iframe
        title="prince-findfox"
        src={iframeSrc}
        className="h-full w-full border-0"
        allow="camera; gyroscope; accelerometer; xr-spatial-tracking"
      />
    </main>
  );
}
