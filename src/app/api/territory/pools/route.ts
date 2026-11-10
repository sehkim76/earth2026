import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/**
 * 축성 이벤트 선택용 풀 목록.
 * 웹이벤트관리(공용 URLType 풀) + 풀 테이블 QuizType 행을 참조한다. (S3 연동 제거됨)
 */
type PoolItem = {
  id: string;
  description: string;
  uri: string;
};

let quizTitlesCache: Record<string, string> | null = null;

/** 문제풀 한글 타이틀 매핑 (빌드 시점 배치 생성, public/boundaries/quiz_titles.json). */
async function loadQuizTitles(): Promise<Record<string, string>> {
  if (quizTitlesCache) {
    return quizTitlesCache;
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(join(process.cwd(), "public", "boundaries", "quiz_titles.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    quizTitlesCache =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, string>)
        : {};
  } catch {
    quizTitlesCache = {};
  }
  return quizTitlesCache;
}

/** 문제풀 한글 타이틀 매핑 (빌드 시점 배치 생성, public/boundaries/quiz_titles.json). */
async function listS3QuizPools(): Promise<PoolItem[]> {
  return [];
}
export async function GET() {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  try {
    const [rows, s3Pools, quizTitles] = await Promise.all([
      prisma.aRMissionEventPoolTable.findMany({
        where: { EventType: { in: ["QuizType", "URLType"] } },
        select: { id: true, EventType: true, EventURI: true, description: true },
        orderBy: { description: "asc" },
      }),
      listS3QuizPools(),
      loadQuizTitles(),
    ]);
    const seenUris = new Set<string>();
    const quizPools: PoolItem[] = [];
    for (const pool of s3Pools) {
      if (seenUris.has(pool.uri)) {
        continue;
      }
      seenUris.add(pool.uri);
      const s3Key = pool.id.startsWith("s3:") ? pool.id.slice(3) : "";
      const title = (s3Key && quizTitles[s3Key]?.trim()) || "";
      quizPools.push({
        ...pool,
        description: title || pool.description,
      });
    }
    for (const row of rows) {
      if (row.EventType !== "QuizType") {
        continue;
      }
      const uri = (row.EventURI ?? "").trim();
      if (!uri || seenUris.has(uri)) {
        continue;
      }
      seenUris.add(uri);
      quizPools.push({
        id: `pool:${row.id}`,
        description: (row.description ?? "").trim() || `문제풀 ${row.id}`,
        uri,
      });
    }
    quizPools.sort((a, b) => a.description.localeCompare(b.description, "ko"));
    const webEvents: PoolItem[] = rows
      .filter((row) => row.EventType === "URLType")
      .map((row) => ({
        id: `pool:${row.id}`,
        description: (row.description ?? "").trim() || `이벤트 ${row.id}`,
        uri: (row.EventURI ?? "").trim(),
      }));
    return NextResponse.json({ ok: true, quizPools, webEvents });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
