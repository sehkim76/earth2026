import type { Viewport } from "next";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";

import { QuizPart } from "@/components/QuizPart";
import { getSafeServerSession } from "@/lib/auth-session";
import prisma from "@/lib/prismadb";
import { loadUnits } from "@/lib/units";
import type { QuizInfo } from "../[EventKey]/quiz";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const S3_STORAGE_BASE =
  process.env.NEXT_PUBLIC_XRART_S3_STORAGE ||
  "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com";

/** 중립성 퀴즈 풀이 허용 반경 (m). 본체 또는 자기 부대가 이 안에 있어야 한다. */
const NEUTRAL_QUIZ_RANGE_M = 15;

const haversineM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const kx = 111320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 110540);
};

type NeutralOfficeRow = {
  key?: unknown;
  lat?: unknown;
  lon?: unknown;
};

const findNeutralOffice = async (
  eventKey: string,
): Promise<{ lat: number; lon: number } | null> => {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "public", "boundaries", "kor_offices.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    for (const row of parsed as NeutralOfficeRow[]) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      if (row.key !== eventKey) {
        continue;
      }
      if (typeof row.lat !== "number" || typeof row.lon !== "number") {
        return null;
      }
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) {
        return null;
      }
      return { lat: row.lat, lon: row.lon };
    }
    return null;
  } catch {
    return null;
  }
};

const parseCsvLite = (text: string): string[][] => {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const clean = text.replace(/^﻿/, "");
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }
  }
  return rows;
};

const pickRandomQuiz = async (): Promise<{ item: QuizInfo; eventKey: string } | null> => {
  // 검증된 풀(quiz_pool.json) 우선 — 출제 불가 키를 미리 제외한다.
  let keys: string[] = [];
  try {
    const rawPool = await fs.readFile(
      path.join(process.cwd(), "public", "boundaries", "quiz_pool.json"),
      "utf-8"
    );
    const parsedPool: unknown = JSON.parse(rawPool);
    if (Array.isArray(parsedPool)) {
      keys = parsedPool.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const key = (entry as Record<string, unknown>).key;
        return typeof key === "string" && /^Quiz\/[^/]+\.(csv|json)$/i.test(key) ? [key] : [];
      });
    }
  } catch {
    keys = [];
  }
  if (keys.length === 0) {
    let titles: Record<string, string> = {};
    try {
      const raw = await fs.readFile(
        path.join(process.cwd(), "public", "boundaries", "quiz_titles.json"),
        "utf-8"
      );
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        titles = parsed as Record<string, string>;
      }
    } catch {
      return null;
    }
    keys = Object.keys(titles).filter((key) => /^Quiz\/[^/]+\.csv$/i.test(key));
  }
  if (keys.length === 0) {
    return null;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    // CSV·JSON 공용 검증 경로 (고정 키 조회와 동일).
    const item = await pickQuizFromKey(key);
    if (!item) {
      continue;
    }
    return { item, eventKey: `neutral:${key}` };
  }
  return null;
};

const quizInfoFromPool = (rows: string[][], poolUrl: string): QuizInfo | null => {
  if (rows.length < 2) {
    return null;
  }
  const header = rows[0].map((cell) => cell.trim());
  const colIndex = (name: string): number => header.indexOf(name);
  const getColumn = (row: string[], name: string): string => {
    const index = colIndex(name);
    return index >= 0 ? (row[index] ?? "").trim() : "";
  };
  const valid = rows.slice(1).filter((row) => {
    const answer = getColumn(row, "Answer");
    const difficulty = Number(getColumn(row, "Difficulty"));
    return answer.length > 0 && Number.isFinite(difficulty) && difficulty >= 1 && difficulty <= 5;
  });
  if (valid.length === 0) {
    return null;
  }
  const picked = valid[Math.floor(Math.random() * valid.length)];
  const difficulty = Number(getColumn(picked, "Difficulty"));
  return {
    Title: getColumn(picked, "Subject") || getColumn(picked, "Chapter") || "랜덤 퀴즈",
    QuizFormat: getColumn(picked, "AnswerType") || "MCQ",
    EventURI: poolUrl,
    Hint: getColumn(picked, "Hint") || undefined,
    HintType: getColumn(picked, "HintType") || undefined,
    AnswerType: getColumn(picked, "AnswerType") || undefined,
    Ex1: getColumn(picked, "EX1") || undefined,
    Ex2: getColumn(picked, "EX2") || undefined,
    Ex3: getColumn(picked, "EX3") || undefined,
    Ex4: getColumn(picked, "EX4") || undefined,
    Answer: getColumn(picked, "Answer") || undefined,
    Difficulty: Number.isFinite(difficulty) && difficulty > 0 ? difficulty : 1,
    AREvent: getColumn(picked, "AREvent") || undefined,
  };
};

/** 무법자 보유 퀴즈 고정 조회 (실패 시 null). JSON 단일 문항도 지원한다. */
const pickQuizFromKey = async (key: string): Promise<QuizInfo | null> => {
  if (!/^Quiz\/[^/]+\.(csv|json)$/i.test(key)) {
    return null;
  }
  try {
    const poolUrl = `${S3_STORAGE_BASE}/${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(poolUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    if (key.toLowerCase().endsWith(".json")) {
      // xrbox-admin fetchAndParseJSON과 동일 형식의 단일 문항 JSON.
      const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const answer = typeof parsed.Answer === "string" ? parsed.Answer.trim() : "";
      const difficulty = Number(parsed.Difficulty);
      if (answer.length === 0 || !Number.isFinite(difficulty) || difficulty < 1 || difficulty > 5) {
        return null;
      }
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      return {
        Title: str(parsed.Title) ?? "랜덤 퀴즈",
        QuizFormat: str(parsed.QuizFormat) ?? "json",
        EventURI: str(parsed.EventURI) ?? poolUrl,
        Hint: str(parsed.Hint),
        HintType: str(parsed.HintType),
        AnswerType: str(parsed.AnswerType),
        Ex1: str(parsed.Ex1),
        Ex2: str(parsed.Ex2),
        Ex3: str(parsed.Ex3),
        Ex4: str(parsed.Ex4),
        Answer: answer,
        Difficulty: difficulty,
        AREvent: str(parsed.AREvent),
        HintImageURL: str(parsed.HintImageURL),
      };
    }
    return quizInfoFromPool(parseCsvLite((await res.text()).slice(0, 512 * 1024)), poolUrl);
  } catch {
    return null;
  }
};

/** 무법자 공격 입장: 15m 검증 + 부대 소모 + 고정 퀴즈 반환 (실패 시 사유 반환). */
const resolveWildQuiz = async (
  userId: string,
  wildId: number,
): Promise<{ item: QuizInfo; eventKey: string } | { error: "gone" | "range" | "quiz" }> => {
  const WILD_ATTACK_RANGE_M = 15;
  // 서버 재검증은 GPS 오차·DB 위치 지연·무법자 이동을 감안해 5m 여유를 둔다.
  const WILD_ATTACK_SERVER_GRACE_M = WILD_ATTACK_RANGE_M + 5;
  const wild = await prisma.territoryNeutralUnit.findUnique({ where: { id: wildId } });
  if (!wild) {
    console.debug(`[neutral] attack denied id=${wildId} reason=gone`);
    return { error: "gone" as const };
  }
  const userRow = await prisma.missionUser.findUnique({
    where: { userId },
    select: { data: true, lat: true, lon: true },
  });
  // 부대 현재 위치는 다리 보간으로 계산한다 (DB에는 다리 기점만 있다).
  const nowMs = Date.now();
  const legStart = Number(wild.legStartedAt);
  const legEnd = Number(wild.legEndsAt);
  const legT = legEnd > legStart ? Math.min(1, Math.max(0, (nowMs - legStart) / (legEnd - legStart))) : 1;
  const wildLat = wild.lat + (wild.destLat - wild.lat) * legT;
  const wildLon = wild.lon + (wild.destLon - wild.lon) * legT;
  // 플레이어 본체 또는 자기 부대가 범위 안에 있어야 한다 (중립성과 동일).
  const toNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const userLat = toNumber(userRow?.lat);
  const userLon = toNumber(userRow?.lon);
  const playerDistM =
    userLat !== null && userLon !== null ? haversineM(userLat, userLon, wildLat, wildLon) : null;
  let unitDistM: number | null = null;
  for (const unit of loadUnits(userRow?.data)) {
    if (unit.state !== "field" && unit.state !== "garrisoned") {
      continue;
    }
    const d = haversineM(unit.lat, unit.lon, wildLat, wildLon);
    if (unitDistM === null || d < unitDistM) {
      unitDistM = d;
    }
  }
  const bestDistM = Math.min(
    playerDistM ?? Number.POSITIVE_INFINITY,
    unitDistM ?? Number.POSITIVE_INFINITY,
  );
  if (bestDistM > WILD_ATTACK_SERVER_GRACE_M) {
    console.debug(
      `[neutral] attack denied id=${wildId} reason=range dist=${Number.isFinite(bestDistM) ? Math.round(bestDistM) : "-"}m`,
    );
    return { error: "range" as const };
  }
  const item = wild.quizKey ? await pickQuizFromKey(wild.quizKey) : null;
  if (!item) {
    console.debug(`[neutral] attack denied id=${wildId} reason=quiz`);
    return { error: "quiz" as const };
  }
  await prisma.territoryNeutralUnit.delete({ where: { id: wildId } }).catch(() => {});
  return { item, eventKey: `neutral:${wild.quizKey}` };
};

type NeutralQuizPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const getSingleParam = (value: string | string[] | undefined): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
};

export default async function NeutralQuizPage({ searchParams }: NeutralQuizPageProps) {
  const session = await getSafeServerSession({ returnTo: "/quiz/neutral" });

  if (!session?.user?.id) {
    redirect(`/?callbackUrl=${encodeURIComponent("/quiz/neutral")}`);
  }

  // 중립성 연결 진입이면 본체 또는 자기 부대가 15m 이내에 있어야 한다.
  // 무법자 공격 진입(wild=중립부대 id)이면 자기 부대가 15m 이내에 있어야 하고,
  // 입장 시점에 부대를 소모(삭제)한다. 퀴즈는 부대가 보유한 고정 키로 출제한다.
  const params = (await searchParams) ?? {};
  const neutralEventKey = (getSingleParam(params.neutralEventKey) ?? "").trim();
  const wildIdRaw = (getSingleParam(params.wild) ?? "").trim();
  const wildId = wildIdRaw !== "" && /^\d+$/.test(wildIdRaw) ? Number.parseInt(wildIdRaw, 10) : null;
  if (wildId !== null) {
    const wildView = await resolveWildQuiz(session.user.id, wildId);
    if ("error" in wildView) {
      redirect(`/map?attackDenied=${wildView.error}`);
    }
    return (
      <div className="h-dvh min-h-0 w-screen overflow-hidden">
        <QuizPart
          item={wildView.item}
          eventKey={wildView.eventKey}
          userId={session?.user?.id}
          nickname={session?.user?.nickname}
        />
      </div>
    );
  }
  if (neutralEventKey.startsWith("neutral-")) {
    const office = await findNeutralOffice(neutralEventKey);
    if (!office) {
      redirect("/map");
    }
    const userRow = await prisma.missionUser.findUnique({
      where: { userId: session.user.id },
      select: { lat: true, lon: true, data: true },
    });
    const toNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const userLat = toNumber(userRow?.lat);
    const userLon = toNumber(userRow?.lon);
    const playerNear =
      userLat !== null &&
      userLon !== null &&
      haversineM(userLat, userLon, office.lat, office.lon) <= NEUTRAL_QUIZ_RANGE_M;
    const unitNear =
      !playerNear &&
      loadUnits(userRow?.data).some(
        (unit) =>
          (unit.state === "field" || unit.state === "garrisoned") &&
          haversineM(unit.lat, unit.lon, office.lat, office.lon) <= NEUTRAL_QUIZ_RANGE_M,
      );
    if (!playerNear && !unitNear) {
      redirect("/map");
    }
  }

  const picked = await pickRandomQuiz();
  if (!picked) {
    redirect("/map");
  }

  return (
    <div className="h-dvh min-h-0 w-screen overflow-hidden">
      <QuizPart
        item={picked.item}
        eventKey={picked.eventKey}
        userId={session?.user?.id}
        nickname={session?.user?.nickname}
      />
    </div>
  );
}
