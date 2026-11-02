import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prismadb";

export async function DELETE() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await prisma.aRMissionUserScore.deleteMany({
    where: {
      UserId: userId,
    },
  });

  console.log("[resetscore] deleted", { userId, count: result.count });

  return NextResponse.json({ deleted: result.count });
}
