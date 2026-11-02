import type { DefaultSession } from "next-auth";

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

export {};
