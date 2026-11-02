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

    if (!isValidNickname(nickname) || deviceId.length === 0) {
      return NextResponse.json({ result: "invalid" }, { status: 400 });
    }

    const existingUser = await prisma.missionUser.findFirst({
      where: {
        nickname,
      },
      select: {
        userId: true,
        device_id: true,
      },
    });

    if (existingUser) {
      if (!isUnclaimedDevice(existingUser.device_id) && existingUser.device_id !== deviceId) {
        return NextResponse.json({ result: "duplicate" }, { status: 409 });
      }

      return NextResponse.json({ result: "owned", userId: existingUser.userId });
    }

    const uniqueId = crypto.randomUUID();
    const createdUser = await prisma.missionUser.create({
      data: {
        userId: uniqueId,
        password: uniqueId,
        nickname,
        code: "W",
        email: "",
        createdate: new Date(),
        score: 0,
        ARMissionKey: "",
        MainSceneName: "",
        device_id: deviceId,
        Features: "",
        access_time: new Date(),
        location: "",
        edboxModel: "",
        isCMSAdmin: 0,
        is_system_admin: 0,
        SubscriberCode: "",
      },
      select: {
        userId: true,
      },
    });

    return NextResponse.json({ result: "success", userId: createdUser.userId });
  } catch (error) {
    console.error("[create_nickname] 오류:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
