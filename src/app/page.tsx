import { Suspense } from "react";
import NicknameInput from "@/components/NicknameInput";
import { redirect } from "next/navigation";

import { getSafeServerSession } from "@/lib/auth-session";

type HomeProps = {
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

export default async function Home({ searchParams }: HomeProps) {
    const session = await getSafeServerSession({ returnTo: "/" });

    if (session?.user?.nickname) {
        redirect('/map');
    }

    const params = (await searchParams) ?? {};
    const initialMissionKey =
        getSingleParam(params.ARMissionKey) ??
        getSingleParam(params.armissionkey) ??
        getSingleParam(params.armissionKey) ??
        "";

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <Suspense>
                <NicknameInput
                    defaultValue=""
                    initialMissionKey={initialMissionKey.trim()}
                />
            </Suspense>

        </div>
    );
}
