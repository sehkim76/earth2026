import { PrismaClient } from "@/generated/prisma/client"


declare global {
    var prisma : PrismaClient | undefined
}

const buildDatabaseUrl = (): string | undefined => {
    const raw = process.env.DATABASE_URL;
    if (!raw) {
        return raw;
    }
    if (/[?&]connection_limit=/.test(raw)) {
        return raw;
    }
    // Lambda 동시 실행 시 MySQL 커넥션 고갈(1040) 방지: 컨테이너당 풀 상한.
    return `${raw}${raw.includes("?") ? "&" : "?"}connection_limit=3`;
};

const client = globalThis.prisma || new PrismaClient({
    datasources: {
        db: {
            url: buildDatabaseUrl(),
        },
    },
})
globalThis.prisma = client

export default client