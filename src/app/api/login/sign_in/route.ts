import { NextResponse } from "next/server";

import { isValidNickname } from "@/lib/auth-claim";
import prisma from "@/lib/prismadb";

type RequestBody = {
  nickname?: unknown;
  deviceId?: unknown;
};

const isUnclaimedDevice = (value: string | null | undefined): boolean => {
  return !value || value.trim().length === 0;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;

    const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";

    console.log("[sign_in] 요청 수신", { nickname, deviceId });

    if (!isValidNickname(nickname) || deviceId.length === 0) {
      console.log("[sign_in] 유효성 검사 실패");
      return NextResponse.json({ result: null }, { status: 400 });
    }

    const user = await prisma.missionUser.findFirst({
      where: {
        nickname,
      },
    });

    console.log("[sign_in] DB 조회 결과", { user: user ? { userId: user.userId, device_id: user.device_id } : null });

    if (!user) {
      console.log("[sign_in] 사용자 없음");
      return NextResponse.json({ result: null }, { status: 404 });
    }

    if (!isUnclaimedDevice(user.device_id) && user.device_id !== deviceId) {
      console.log("[sign_in] 다른 기기에서 사용 중");
      return NextResponse.json({ result: null }, { status: 401 });
    }

    console.log("[sign_in] 로그인 성공", { userId: user.userId });
    return NextResponse.json({
      result: {
        userId: user.userId,
        nickname: user.nickname,
        claimed: !isUnclaimedDevice(user.device_id),
      },
    });
  } catch (error) {
    console.error("[sign_in] 오류:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
