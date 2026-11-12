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
            { hostname: '49.50.164.91' }
        ]
    },  
  reactCompiler: true,
  // 서버 번들(람다 x86_64, AL2023)에서 쓰지 않는 Prisma 파일을 추적 대상에서 뺀다.
  // - 쿼리 엔진: 람다는 rhel-openssl-3.0.x만 로드한다 (debian=로컬 개발용, arm64=미사용).
  // - 런타임: 생성 클라이언트는 engineType=library → @prisma/client/runtime/library(.js/.mjs)만 쓴다.
  //   wasm 쿼리 엔진/컴파일러(DB별), edge·react-native 런타임은 불필요하다.
  outputFileTracingExcludes: {
    "*": [
      "src/generated/prisma/libquery_engine-debian-openssl-*.so.node",
      "src/generated/prisma/libquery_engine-linux-arm64-openssl-*.so.node",
      "src/generated/prisma/query_engine-windows*",
      "node_modules/@prisma/client/runtime/query_engine_bg.*",
      "node_modules/@prisma/client/runtime/query_compiler_bg.*",
      "node_modules/@prisma/client/runtime/wasm-engine-edge.*",
      "node_modules/@prisma/client/runtime/wasm-compiler-edge.*",
      "node_modules/@prisma/client/runtime/edge.js",
      "node_modules/@prisma/client/runtime/edge-esm.js",
      "node_modules/@prisma/client/runtime/react-native.js",
    ],
  },
};

export default nextConfig;
