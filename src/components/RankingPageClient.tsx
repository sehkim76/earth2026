"use client";

import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";

import Ranking from "@/components/Ranking";
import type { RankingItem } from "@/components/Ranking";

type RankingPageClientProps = {
  nickname: string;
  items: RankingItem[];
};

export default function RankingPageClient({ nickname, items }: RankingPageClientProps) {
  const router = useRouter();

  const handleExit = async () => {
    await signOut({
      redirect: false,
    });
    router.push("/");
  };

  const handleResetScore = async () => {
    try {
      const response = await fetch("/api/resetscore", {
        method: "DELETE",
        credentials: "include",
      });

      if (response.ok) {
        window.location.reload();
      } else {
        console.error("[ResetScore] API returned error", response.status);
      }
    } catch (error) {
      console.error("[ResetScore] failed", error);
    }
  };

  return (
    <div className="h-full w-full p-0">
      <Ranking
        items={items}
        myNickname={nickname}
        mapToolbar={{
          onRanking: () => router.push("/ranking"),
          onQR: () => router.push("/arqr"),
          onExit: () => {
            void handleExit();
          },
          onResetScore: () => {
            void handleResetScore();
          },
          activeButton: "ranking",
        }}
      />
    </div>
  );
}
