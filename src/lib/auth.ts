import type { NextAuthOptions } from "next-auth";
import type { DefaultSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import prisma from "@/lib/prismadb";
import { isValidNickname } from "@/lib/auth-claim";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      nickname: string;
      deviceId: string;
      ARMissionKey: string;
    };
  }

  interface User {
    nickname: string;
    deviceId: string;
    ARMissionKey?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    nickname?: string;
    deviceId?: string;
    ARMissionKey?: string;
  }
}

const developmentFallbackSecret = "armissionweb-dev-nextauth-secret";

const resolveAuthSecret = (): string => {
  if (process.env.NEXTAUTH_SECRET) {
    return process.env.NEXTAUTH_SECRET;
  }

  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }

  return developmentFallbackSecret;
};

type AuthUser = {
  id: string;
  name: string;
  nickname: string;
  deviceId: string;
  ARMissionKey: string;
};

const toAuthUser = (params: {
  id: string;
  nickname: string;
  deviceId: string;
  ARMissionKey?: string;
}): AuthUser => {
  return {
    id: params.id,
    name: params.nickname,
    nickname: params.nickname,
    deviceId: params.deviceId,
    ARMissionKey: params.ARMissionKey || "",
  };
};

export const authOptions: NextAuthOptions = {
  secret: resolveAuthSecret(),
  logger: {
    error(code, metadata) {
      if (code === "JWT_SESSION_ERROR") {
        return;
      }

      console.error("[next-auth][error]", code, metadata);
    },
  },
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 30,
  },
  pages: {
    signIn: "/",
  },
  providers: [
    CredentialsProvider({
      name: "Nickname",
      credentials: {
        nickname: { label: "Nickname", type: "text" },
        deviceId: { label: "Device ID", type: "text" },
        ARMissionKey: { label: "ARMissionKey", type: "text" },
      },
      async authorize(credentials) {
        const rawNickname = credentials?.nickname;
        const rawDeviceId = credentials?.deviceId;
        const rawARMissionKey = credentials?.ARMissionKey;

        if (typeof rawNickname !== "string" || typeof rawDeviceId !== "string") {
          return null;
        }

        const nickname = rawNickname.trim();
        const deviceId = rawDeviceId.trim();
        const ARMissionKey = typeof rawARMissionKey === "string" 
          ? rawARMissionKey.trim() 
          : "BUSANCITIZEN_ARBOOK";

        console.log("[next-auth] authorize 호출", { nickname, deviceId, ARMissionKey });

        if (!isValidNickname(nickname) || deviceId.length === 0) {
          return null;
        }

        const existingUser = await prisma.missionUser.findFirst({
          where: {
            nickname,
          },
        });

        if (existingUser) {
          if (existingUser.device_id !== deviceId) {
            await prisma.missionUser.updateMany({
              where: {
                userId: existingUser.userId,
              },
              data: {
                device_id: deviceId,
              },
            });
          }

          return toAuthUser({
            id: existingUser.userId,
            nickname: existingUser.nickname,
            deviceId,
            ARMissionKey: existingUser.ARMissionKey || ARMissionKey,
          });
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
            ARMissionKey: ARMissionKey,
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
        });

        return toAuthUser({
          id: createdUser.userId,
          nickname: createdUser.nickname,
          deviceId,
          ARMissionKey,
        });
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.nickname = user.nickname;
        token.deviceId = user.deviceId;
        token.ARMissionKey = user.ARMissionKey;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = typeof token.userId === "string" ? token.userId : "";
        session.user.nickname = typeof token.nickname === "string" ? token.nickname : "";
        session.user.deviceId = typeof token.deviceId === "string" ? token.deviceId : "";
        (session.user as { ARMissionKey?: string }).ARMissionKey = typeof token.ARMissionKey === "string" ? token.ARMissionKey : "";
        session.user.name = session.user.nickname;
      }

      return session;
    },
  },
};
