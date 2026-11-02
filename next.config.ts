import type { NextConfig } from "next";
import { execSync } from "node:child_process";

const BUILD_SHA = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_SHA: BUILD_SHA,
  },
  /* config options here */
    images: {
        remotePatterns: [
            { hostname: 'res.cloudinary.com' },
            { hostname: '49.50.164.91' },
            { hostname: 'armissionchallenge.s3.ap-northeast-2.amazonaws.com' }
        ]
    },  
  reactCompiler: true,
};

export default nextConfig;
