import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware() {
    return NextResponse.next();
  },
  {
    pages: {
      signIn: "/",
    },
    secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  },
);

export const config = {
  matcher: ["/quiz/:path*", "/games/:path*", "/games", "/map"],
};
