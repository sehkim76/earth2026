
import prisma from "@/lib/prismadb";
import { hashSiegeQuestion } from "@/lib/game-score";


export interface QuizInfo {
    Title: string;
    QuizFormat: string;
    EventURI: string;
    Hint?: string; // hint 데이터를 포함
    HintType?: string; // hint 데이터를 포함
    AnswerType?: string;
    //AnswerType: QuizAnswerType;
    Ex1?: string;
    Ex2?: string;
    Ex3?: string;
    Ex4?: string;
    Answer?: string;
    Difficulty: number;
    AREvent?: string;
    HintImageURL?: string;
};


export async function getQuizInfo(eventKey: string, userId?: string): Promise<QuizInfo> {
    // 여기서 eventKey에 따라 실제 퀴즈 정보를 가져오는 로직을 구현
    // 예: 데이터베이스 조회, 외부 API 호출 등
    // 현재는 예시 데이터를 반환
    const quiz =await prisma.aRMissionEvent.findFirst({
        where: {
            EventKey: eventKey
        }
    });

    // 성 공성: 풀에서 난이도 필터 + 최근 출제 제외 후 랜덤 1문항 (공성 1타)
    if (eventKey.trim().startsWith("castle-") && quiz?.EventURI) {
        const picked = await pickCastleQuestion({
            eventKey: eventKey.trim(),
            poolUrl: (quiz.EventURI || "").trim(),
            settingsRaw2: quiz.string_param2 ?? null,
            userId: (userId ?? "").trim() || null,
        });
        if (picked) {
            return picked;
        }
    }
    
    if ( quiz?.EventURI?.endsWith('.json') ) {
        const response = await fetch(quiz.EventURI);
        const data = await response.json();
        console.log("Fetched quiz data:", data);
        return data as QuizInfo;
    }

    if (quiz?.EventURI?.endsWith('.csv')) {
        try {
            const response = await fetch(quiz.EventURI);
            if (!response.ok) {
                throw new Error(`quiz CSV fetch failed: ${response.status}`);
            }
            const rows = parseQuizCsv(await response.text());
            const header = rows[0] ?? [];
            const firstRow = rows[1];
            if (!firstRow) {
                throw new Error("quiz CSV has no data rows");
            }
            const getColumn = (name: string): string => {
                const index = header.findIndex((cell) => cell.trim() === name);
                return index >= 0 ? (firstRow[index] ?? "").trim() : "";
            };
            const difficulty = Number(getColumn("Difficulty"));
            return {
                Title: getColumn("Subject") || getColumn("Chapter") || quiz?.string_param1 || "샘플 퀴즈",
                QuizFormat: getColumn("AnswerType") || "MCQ",
                EventURI: quiz.EventURI,
                Hint: getColumn("Hint") || undefined,
                HintType: getColumn("HintType") || undefined,
                AnswerType: getColumn("AnswerType") || undefined,
                Ex1: getColumn("EX1") || undefined,
                Ex2: getColumn("EX2") || undefined,
                Ex3: getColumn("EX3") || undefined,
                Ex4: getColumn("EX4") || undefined,
                Answer: getColumn("Answer") || undefined,
                Difficulty: Number.isFinite(difficulty) && difficulty > 0
                    ? difficulty
                    : (quiz?.int_param1 || 1),
                AREvent: getColumn("AREvent") || undefined,
            };
        } catch (error) {
            console.error("[getQuizInfo] failed to load quiz CSV:", quiz.EventURI, error);
        }
    }
    
    return {
        Title: quiz?.string_param1 || "샘플 퀴즈",
        QuizFormat: quiz?.string_param2 || "MCQ",
        EventURI: quiz?.EventURI || eventKey,
        Difficulty: quiz?.int_param1 || 1
    };
}

/** 따옴표로 감싼 필드와 줄바꿈을 지원하는 최소 CSV 파서 (RFC 4180 스타일) */function parseQuizCsv(text: string): string[][] {
    const rows: string[][] = [];
    let field = "";
    let row: string[] = [];
    let inQuotes = false;
    const clean = text.replace(/^﻿/, "");
    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        if (inQuotes) {
            if (ch === '"') {
                if (clean[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(field);
            field = "";
        } else if (ch === '\n') {
            row.push(field);
            field = "";
            rows.push(row);
            row = [];
        } else if (ch === '\r') {
            continue;
        } else {
            field += ch;
        }
    }
    row.push(field);
    rows.push(row);
    return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// ---------------------------------------------------------------------------
// 성 공성 출제 (풀 → 성문 필터 → 최근 출제 제외 → 랜덤 1문항)
// ---------------------------------------------------------------------------

const POOL_CACHE_TTL_MS = 10 * 60 * 1000;
const POOL_CACHE_MAX_ENTRIES = 50;

const poolCache = new Map<string, { at: number; rows: string[][] }>();

async function loadPoolRows(poolUrl: string): Promise<string[][] | null> {
  if (!/^https:\/\//i.test(poolUrl)) {
    return null;
  }
  const cached = poolCache.get(poolUrl);
  if (cached && Date.now() - cached.at < POOL_CACHE_TTL_MS) {
    return cached.rows;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(poolUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return null;
    }
    const rows = parseQuizCsv((await response.text()).slice(0, 512 * 1024));
    if (rows.length >= 2) {
      poolCache.set(poolUrl, { at: Date.now(), rows });
      if (poolCache.size > POOL_CACHE_MAX_ENTRIES) {
        const oldest = poolCache.keys().next();
        if (!oldest.done) {
          poolCache.delete(oldest.value);
        }
      }
    }
    return rows;
  } catch {
    return null;
  }
}

const readDifficultyRange = (settingsRaw: string | null): [number, number] => {
  try {
    const parsed = JSON.parse(settingsRaw ?? "") as { difficulty?: unknown };
    const diff = Array.isArray(parsed.difficulty) ? parsed.difficulty.map(Number) : [];
    if (diff.length >= 2 && diff.every((n) => Number.isFinite(n))) {
      const lo = Math.max(1, Math.min(5, Math.trunc(diff[0])));
      const hi = Math.max(1, Math.min(5, Math.trunc(diff[1])));
      return [Math.min(lo, hi), Math.max(lo, hi)];
    }
  } catch {
    // 기본 범위 사용
  }
  return [1, 5];
};

async function readRecentSiegeHashes(eventKey: string, userId: string | null): Promise<Set<string>> {
  const used = new Set<string>();
  if (!userId) {
    return used;
  }
  try {
    const rows = await prisma.aRMissionUserScore.findMany({
      where: {
        UserId: userId,
        EventKey: eventKey,
        answer: { startsWith: "siege:" },
      },
      orderBy: { scoredate: "desc" },
      take: 10,
      select: { answer: true },
    });
    for (const row of rows) {
      const parts = (row.answer ?? "").split(":");
      const hash = (parts[2] ?? "").split(" ")[0].trim();
      if (hash) {
        used.add(hash);
      }
    }
  } catch {
    // 조회 실패 시 중복 허용
  }
  return used;
}

async function pickCastleQuestion(params: {
  eventKey: string;
  poolUrl: string;
  settingsRaw2: string | null;
  userId: string | null;
}): Promise<QuizInfo | null> {
  const rows = await loadPoolRows(params.poolUrl);
  if (!rows || rows.length < 2) {
    return null;
  }
  const header = rows[0] ?? [];
  const colIndex = (name: string): number => header.findIndex((cell) => cell.trim() === name);
  const getColumn = (row: string[], name: string): string => {
    const index = colIndex(name);
    return index >= 0 ? (row[index] ?? "").trim() : "";
  };
  const hashOf = (row: string[]): string =>
    hashSiegeQuestion(
      `${getColumn(row, "Hint")}|${getColumn(row, "EX1")}|${getColumn(row, "EX2")}|${getColumn(row, "EX3")}|${getColumn(row, "EX4")}`,
    );

  const [lo, hi] = readDifficultyRange(params.settingsRaw2);
  const inRange = rows.slice(1).filter((row) => {
    const difficulty = Number(getColumn(row, "Difficulty"));
    const answer = getColumn(row, "Answer");
    return (
      answer.length > 0 && Number.isFinite(difficulty) && difficulty >= lo && difficulty <= hi
    );
  });
  if (inRange.length === 0) {
    return null;
  }

  const used = await readRecentSiegeHashes(params.eventKey, params.userId);
  const fresh = used.size > 0 ? inRange.filter((row) => !used.has(hashOf(row))) : inRange;
  const pool = fresh.length > 0 ? fresh : inRange;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  if (!picked) {
    return null;
  }

  const difficulty = Number(getColumn(picked, "Difficulty"));
  return {
    Title: getColumn(picked, "Subject") || getColumn(picked, "Chapter") || "공성 퀴즈",
    QuizFormat: getColumn(picked, "AnswerType") || "MCQ",
    EventURI: params.poolUrl,
    Hint: getColumn(picked, "Hint") || undefined,
    HintType: getColumn(picked, "HintType") || undefined,
    AnswerType: getColumn(picked, "AnswerType") || undefined,
    Ex1: getColumn(picked, "EX1") || undefined,
    Ex2: getColumn(picked, "EX2") || undefined,
    Ex3: getColumn(picked, "EX3") || undefined,
    Ex4: getColumn(picked, "EX4") || undefined,
    Answer: getColumn(picked, "Answer") || undefined,
    Difficulty:
      Number.isFinite(difficulty) && difficulty > 0 ? difficulty : 1,
    AREvent: getColumn(picked, "AREvent") || undefined,
  };
}