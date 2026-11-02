import type { Viewport } from "next";
import { redirect } from "next/navigation";

import { QuizPart } from "@/components/QuizPart";
import { getSafeServerSession } from "@/lib/auth-session";

import { getQuizInfo } from "./quiz";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

type QuizPageParams = {
  params: Promise<{ EventKey: string }>;
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

const QuizPage = async ({ params, searchParams }: QuizPageParams) => {
  const { EventKey } = await params;
  const query = (await searchParams) ?? {};
  const session = await getSafeServerSession({ returnTo: `/quiz/${encodeURIComponent(EventKey)}` });

  if (!session?.user?.id) {
    const loginCallbackQuery = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          loginCallbackQuery.append(key, item);
        }
        continue;
      }
      loginCallbackQuery.append(key, value);
    }
    const loginCallbackQueryString = loginCallbackQuery.toString();
    const loginCallback = `/quiz/${encodeURIComponent(EventKey)}${loginCallbackQueryString ? `?${loginCallbackQueryString}` : ""}`;
    redirect(`/?callbackUrl=${encodeURIComponent(loginCallback)}`);
  }

  const fallbackUserId = getSingleParam(query.userId) || getSingleParam(query.userid);
  const fallbackNickname = getSingleParam(query.nickname);
  const quiz = await getQuizInfo(EventKey || "", session?.user?.id || fallbackUserId);

  return (
    <div className="h-dvh min-h-0 w-screen overflow-hidden">
      <QuizPart
        item={quiz}
        eventKey={EventKey}
        userId={session?.user?.id || fallbackUserId}
        nickname={session?.user?.nickname || fallbackNickname}
      />
    </div>
  );
};

export default QuizPage;
