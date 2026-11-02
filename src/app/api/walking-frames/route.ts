import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";

type SpriteSource = "walking" | "fallenAngel";

const DEFAULT_WALKING_FRAMES_DIR = "C:\\Users\\user\\Downloads\\Walking";
const DEFAULT_FALLEN_ANGEL_WALKING_FRAMES_DIR = "C:\\Users\\user\\Downloads\\craftpix-991117-free-fallen-angel-chibi-2d-game-sprites\\Fallen_Angels_1\\PNG\\PNG Sequences\\Walking";
const PROJECT_WALKING_FRAMES_DIR = path.join(process.cwd(), "public", "map-assets", "walking");
const PROJECT_FALLEN_ANGEL_WALKING_FRAMES_DIR = path.join(process.cwd(), "public", "map-assets", "fallen-angel");

const parseSpriteSource = (value: string | null): SpriteSource => {
  if (value === "fallenAngel") {
    return value;
  }

  return "walking";
};

const getFramesDirectory = (source: SpriteSource): string => {
  if (source === "fallenAngel") {
    return process.env.FALLEN_ANGEL_WALKING_FRAMES_DIR
      ?? PROJECT_FALLEN_ANGEL_WALKING_FRAMES_DIR
      ?? DEFAULT_FALLEN_ANGEL_WALKING_FRAMES_DIR;
  }

  return process.env.WALKING_FRAMES_DIR
    ?? PROJECT_WALKING_FRAMES_DIR
    ?? DEFAULT_WALKING_FRAMES_DIR;
};

const parseFrameNumber = (fileName: string): number => {
  const match = fileName.match(/(\d+)(?=\.png$)/i);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};

const listFrameFiles = async (framesDir: string): Promise<string[]> => {
  const entries = await readdir(framesDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const aNumber = parseFrameNumber(a);
      const bNumber = parseFrameNumber(b);
      if (aNumber === bNumber) {
        return a.localeCompare(b);
      }

      return aNumber - bNumber;
    });
};

const toImageResponse = async (framesDir: string, fileName: string): Promise<NextResponse> => {
  const safeName = path.basename(fileName);
  if (safeName !== fileName || !safeName.toLowerCase().endsWith(".png")) {
    return NextResponse.json({ error: "invalid_file" }, { status: 400 });
  }

  const absolutePath = path.join(framesDir, safeName);

  try {
    const allowedFiles = await listFrameFiles(framesDir);
    if (!allowedFiles.includes(safeName)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const baseRealPath = await realpath(framesDir);
    const targetRealPath = await realpath(absolutePath);
    const normalizedBasePath = path.resolve(baseRealPath).toLowerCase();
    const normalizedTargetPath = path.resolve(targetRealPath).toLowerCase();
    if (!normalizedTargetPath.startsWith(`${normalizedBasePath}${path.sep.toLowerCase()}`)) {
      return NextResponse.json({ error: "invalid_file" }, { status: 400 });
    }

    const targetStat = await stat(targetRealPath);
    if (!targetStat.isFile()) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const imageBuffer = await readFile(absolutePath);
    return new NextResponse(imageBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileName = searchParams.get("file");
  const source = parseSpriteSource(searchParams.get("character"));

  const framesDir = getFramesDirectory(source);

  if (fileName) {
    return toImageResponse(framesDir, fileName);
  }

  try {
    const files = await listFrameFiles(framesDir);
    return NextResponse.json({
      frames: files,
      directory: framesDir,
      character: source,
    });
  } catch {
    return NextResponse.json({
      frames: [],
      directory: framesDir,
      character: source,
    });
  }
}
