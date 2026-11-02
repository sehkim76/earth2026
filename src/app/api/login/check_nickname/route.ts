import { NextResponse } from "next/server";

import { isValidNickname } from "@/lib/auth-claim";
import prisma from "@/lib/prismadb";

type RequestBody = {
  nickname?: unknown;
  deviceId?: unknown;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;

    const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";

    console.log("[check_nickname] 요청 수신", { nickname, deviceId });

    if (!isValidNickname(nickname)) {
      console.log("[check_nickname] 유효하지 않은 닉네임", { nickname });
      return NextResponse.json({ result: "invalid" });
    }

    const user = await prisma.missionUser.findFirst({
      where: {
        nickname,
      },
      select: {
        userId: true,
        device_id: true,
      },
    });

    console.log("[check_nickname] DB 조회 결과", { user });

    if (!user) {
      console.log("[check_nickname] 사용 가능한 닉네임 (unique)");
      return NextResponse.json({ result: "unique" });
    }

    console.log("[check_nickname] 내 소유 (owned)", { userId: user.userId });
    return NextResponse.json({ result: "owned", userId: user.userId });
  } catch (error) {
    console.error("[check_nickname] 오류:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
