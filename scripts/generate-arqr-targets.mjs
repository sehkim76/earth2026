import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadImage } from "canvas";
import { OfflineCompiler } from "@zenith-xperience/mindar-offline-compiler";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const sourceDir = path.join(rootDir, "public", "arqr-assets", "image-targets", "sources");
const outputPath = path.join(rootDir, "public", "arqr-assets", "image-targets", "paperar.mind");

const targetFiles = [
  "Cube_TOP.png",
  "Cube_BOTTOM.png",
  "Cube_LEFT.png",
  "Cube_RIGHT.png",
  "Cube_FRONT.png",
  "Cube_BACK.png",
  "PaperAR_King.png",
  "PaperAR_Drinker.png",
  "PaperAR_Businessman.png",
  "PaperAR_Scholor.png",
  "PaperAR_Streetlight.png",
  "PaperAR_Vanity.png",
];

const images = await Promise.all(
  targetFiles.map(async (fileName) => {
    const filePath = path.join(sourceDir, fileName);
    return loadImage(filePath);
  })
);

const compiler = new OfflineCompiler();

await compiler.compileImageTargets(images, (progress) => {
  const rounded = Math.max(0, Math.min(100, Math.round(progress)));
  process.stdout.write(`\rCompiling image targets: ${rounded}%`);
});

const compiled = compiler.exportData();
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.from(compiled));

process.stdout.write("\n");
console.log(`MindAR target file generated: ${outputPath}`);
