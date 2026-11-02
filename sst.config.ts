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
        domain: "armission.xrart.kr",

        server: {
            architecture: "x86_64",
            // /api/route 장거리 라우팅용 (CloudFront 상한 120초 이내).
            timeout: "110 seconds",
            memory: "2048 MB",
        },
        runtime: "nodejs20.x",

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
