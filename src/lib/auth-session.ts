import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { authOptions } from "@/lib/auth";

type SafeSessionOptions = {
  returnTo: string;
};

const AUTH_CLEAR_ATTEMPT_COOKIE = "armission-auth-clear-attempt";

const isDecodeFailureError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "JWEDecryptionFailed") {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes("decryption operation failed") || message.includes("jwt_session_error");
};

export const getSafeServerSession = async ({ returnTo }: SafeSessionOptions) => {
  const cookieStore = await cookies();
  const hasClearAttempt = Boolean(cookieStore.get(AUTH_CLEAR_ATTEMPT_COOKIE));

  try {
    return await getServerSession(authOptions);
  } catch (error) {
    if (isDecodeFailureError(error)) {
      if (!hasClearAttempt) {
        redirect(`/api/auth/clear?next=${encodeURIComponent(returnTo)}`);
      }

      return null;
    }

    throw error;
  }
};
