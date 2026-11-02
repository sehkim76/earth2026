import { readFileSync } from "node:fs";
const BASE = "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com";
const titles = JSON.parse(readFileSync("/root/armissionweb/public/boundaries/quiz_titles.json", "utf-8"));
const keys = Object.keys(titles);
console.log("total keys:", keys.length);

function parseCsvLite(text) {
  const rows = []; let field = ""; let row = []; let inQuotes = false;
  const clean = text.replace(/^﻿/, "");
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') { if (clean[i+1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); field = ""; if (row.some(c => c.trim() !== "")) rows.push(row); row = []; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); if (row.some(c => c.trim() !== "")) rows.push(row); }
  return rows;
}

async function check(key) {
  const url = `${BASE}/${key}`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return `${key} :: HTTP ${res.status}`;
    if (key.toLowerCase().endsWith(".json")) {
      const p = await res.json().catch(() => null);
      if (!p || typeof p !== "object") return `${key} :: bad JSON`;
      const a = typeof p.Answer === "string" ? p.Answer.trim() : "";
      const d = Number(p.Difficulty);
      if (!a) return `${key} :: empty Answer`;
      if (!Number.isFinite(d) || d < 1 || d > 5) return `${key} :: bad Difficulty (${p.Difficulty})`;
      return null;
    }
    const text = (await res.text()).slice(0, 512 * 1024);
    const rows = parseCsvLite(text);
    if (rows.length < 2) return `${key} :: <2 rows`;
    const h = rows[0].map(c => c.trim());
    const ci = n => h.indexOf(n);
    const get = (r, n) => { const i = ci(n); return i >= 0 ? (r[i] ?? "").trim() : ""; };
    const valid = rows.slice(1).filter(r => {
      const a = get(r, "Answer"); const d = Number(get(r, "Difficulty"));
      return a.length > 0 && Number.isFinite(d) && d >= 1 && d <= 5;
    });
    if (valid.length === 0) return `${key} :: 0 valid rows (rows=${rows.length - 1}, header=[${h.join("|")}], title=${JSON.stringify(titles[key])})`;
    return null;
  } catch (e) {
    return `${key} :: FETCH FAIL ${e.cause?.code ?? e.message}`;
  }
}

const CONC = 12;
const problems = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const k = queue.shift();
    const p = await check(k);
    if (p) problems.push(p);
    if (++done % 50 === 0) console.log(`... ${done}/${keys.length}`);
  }
}
const q = [...keys];
await Promise.all(Array.from({ length: CONC }, () => worker(q)));
console.log(`\nDONE: ${keys.length} checked, ${problems.length} problems`);
problems.forEach(p => console.log("NG:", p));
