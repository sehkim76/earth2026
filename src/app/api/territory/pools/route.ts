import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/**
 * 축성 이벤트 선택용 풀 목록.
 * xrbox-admin의 퀴즈관리(S3 Quiz/ 문제풀) + 웹이벤트관리(공용 URLType 풀)를 참조한다.
 * - 퀴즈: S3 Quiz/ 공개 리스팅 + ARMissionEventPoolTable QuizType 행 (uri 중복 제거)
 * - 웹이벤트: ARMissionEventPoolTable URLType 행
 */
const S3_STORAGE_BASE =
  process.env.NEXT_PUBLIC_XRART_S3_STORAGE ||
  "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com";

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

const parseTag = (xml: string, tag: string): string | null => {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
};

const parseAllTags = (xml: string, tag: string): string[] => {
  const matches = xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"));
  return [...matches].map((match) => match[1]);
};

/** S3 Quiz/ 폴더의 csv/json 문제풀 목록 (공개 리스팅, 자격증명 불필요). */
async function listS3QuizPools(): Promise<PoolItem[]> {
  const items: PoolItem[] = [];
  let token: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix: "Quiz/",
      "max-keys": "1000",
    });
    if (token) {
      params.set("continuation-token", token);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let xml = "";
    try {
      const res = await fetch(`${S3_STORAGE_BASE}/?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        break;
      }
      xml = await res.text();
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
    for (const key of parseAllTags(xml, "Key")) {
      const fileName = key.split("/").pop() ?? "";
      // 축성 공성전은 CSV 문제풀만 사용한다 (JSON은 시즈 출제 미지원).
      if (!/\.csv$/i.test(fileName)) {
        continue;
      }
      items.push({
        id: `s3:${key}`,
        description: fileName.replace(/\.(csv|json)$/i, ""),
        uri: `${S3_STORAGE_BASE}/${key}`,
      });
    }
    if (parseTag(xml, "IsTruncated") !== "true") {
      break;
    }
    token = parseTag(xml, "NextContinuationToken");
    if (!token) {
      break;
    }
  }
  return items;
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
