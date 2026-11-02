import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
const dir = "/root/armissionweb/public/walkable/raster";
const files = readdirSync(dir).filter(f => f.endsWith(".json"));
const areas = {};
let done = 0;
for (const f of files) {
  const dong = f.slice(0, -5);
  try {
    const data = JSON.parse(readFileSync(`${dir}/${f}`, "utf-8"));
    let filled = 0;
    for (const t of data.tiles ?? []) {
      try {
        const o = inflateSync(Buffer.from(t.f, "base64"));
        const packed = new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
        for (let i = 0; i < packed.length; i++) {
          let b = packed[i];
          while (b) { filled += b & 1; b >>= 1; }
        }
      } catch {}
    }
    areas[dong] = filled * 25;
  } catch {}
  if (++done % 500 === 0) console.log(`... ${done}/${files.length}`);
}
writeFileSync("/root/armissionweb/public/boundaries/dong-walkable-area.json", JSON.stringify(areas));
const jwa = areas["71637012B36687171546688"];
console.log(`dongs=${Object.keys(areas).length} jwa2-area=${jwa}m2`);
