/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
    app(input) {
        return {
            name: "armissionweb-nextjs",
            home: "aws",
            providers: {
                //aws: { region: "ap-northeast-2", profile: "busanjin" },
                aws: { region: "ap-northeast-2", profile: process.env.NEXT_PUBLIC_SST_AWS_PROFILE },
            },
            removal: input.stage === "production" ? "retain" : "remove",
        };
    },

    async run() {
        const site = new sst.aws.Nextjs("Web", {
        path: ".",
        domain: {
          name: "tribes.oceanwalk.kr",
          dns: false,
          cert: "arn:aws:acm:us-east-1:022520097536:certificate/489b1fdb-6a39-404e-9148-1c9fb3004e9a",
        },

        server: {
            architecture: "x86_64",
            // /api/route 장거리 라우팅용 (CloudFront 상한 120초 이내).
            timeout: "110 seconds",
            memory: "2048 MB",
        },
        runtime: "nodejs20.x",
        // 서버 함수는 Neon DB와 같은 리전(싱가포르)에 둔다. 서울에 두면 쿼리마다 서울↔싱가포르 왕복이 붙는다.
        // CloudFront·S3·도메인은 그대로이고 서버 함수만 이 리전에 배포된다.
        regions: ["ap-southeast-1"],

        // 정적 에셋 업로드 옵션 (.open-next/assets 기준 glob).
        // SST는 fileOptions를 역순으로 처리하므로 뒤쪽 항목이 우선한다.
        // 매칭된 파일은 기본 cacheControl을 받지 않으므로 반드시 명시한다.
        // _next/** (해시 파일)는 매칭하지 않아 기본 immutable 1년이 유지된다.
        assets: {
            fileOptions: [
                // 해시 없는 공개 에셋: 브라우저 1시간, CloudFront 1일 (+SWR 1일).
                {
                    files: [
                        "markers/**",
                        "map-assets/**",
                        "boundaries/**",
                        "walkable/**",
                        "*.png",
                    ],
                    cacheControl: "public,max-age=3600,s-maxage=86400,stale-while-revalidate=86400",
                },
                // .topojson은 기본 매핑이 없어 octet-stream으로 올라가 CloudFront 압축이 안 됨 → JSON으로 지정.
                {
                    files: "**/*.topojson",
                    contentType: "application/json;charset=UTF-8",
                    cacheControl: "public,max-age=3600,s-maxage=86400,stale-while-revalidate=86400",
                },
            ],
        },

        environment: {
            NEXT_PUBLIC_STAGE: $app.stage,
            DATABASE_URL: process.env.DATABASE_URL!,
            NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET!,
        },
        });

        return {
        url: site.url,
        };
    },
});
