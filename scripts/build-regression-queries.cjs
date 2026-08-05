/**
 * 记忆检索回归测试 —— 精选 query 集构建脚本
 *
 * 从最近历史会话 JSONL 中按（会话文件、候选索引）精确提取真实用户消息，
 * 生成 scripts/.memtest/queries.json（来源会话 + 原文，不做任何改写）。
 *
 * 候选索引 = 该会话中「role=user、去宿主包裹体、去图片占位、清洗空白、
 * 长度>=8」的用户消息顺序号。SELECTION 由人工依据上一步 dump 内容选定，
 * 覆盖记忆召回/注入、性能慢、task_anchor/hook、会话时间线等主题。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "--C--kaifa-PiDeck--");
const OUT = path.join(__dirname, ".memtest", "queries.json");

/** 会话文件前缀 → 精选的候选索引（顺序即最终 query 顺序） */
const SELECTION = [
  { f: "2026-08-05T07-15-06-396Z_019fd0c6", idx: [0, 1] },
  { f: "2026-08-05T07-00-19-165Z_019fd0b9", idx: [1] },
  { f: "2026-08-05T06-39-46-128Z_019fd0a6", idx: [1, 2, 3] },
  { f: "2026-08-05T06-15-11-180Z_019fd08f", idx: [0] },
  { f: "2026-08-04T19-16-17-817Z_019fce34", idx: [0, 2] },
  { f: "2026-08-04T19-22-43-553Z_019fce3a", idx: [0] },
  { f: "2026-08-04T19-09-03-215Z_019fce2d", idx: [1] },
  { f: "2026-08-04T16-17-03-537Z_019fcd90", idx: [1, 2, 3, 5, 6, 8, 9, 10, 13] },
  { f: "2026-08-04T16-07-08-609Z_019fcd87", idx: [0, 1, 3] },
  { f: "2026-08-04T15-41-19-115Z_019fcd6f", idx: [1, 3, 4, 9] },
  { f: "2026-08-04T15-17-43-737Z_019fcd5a", idx: [8] },
  { f: "2026-08-04T14-53-19-397Z_019fcd43", idx: [1, 4] },
];

function stripHostInstruction(text) {
  const m = text.match(/\[PIDECK_HOST_INSTRUCTION\]([\s\S]*?)\[\/PIDECK_HOST_INSTRUCTION\]/);
  if (!m) return text;
  return text.slice(m.index + m[0].length);
}

function clean(text) {
  return text
    .replace(/\[(?:图片|image|图)\s*\d*\]/gi, "")
    .replace(/\(图片\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\r?\n+/g, " ")
    .trim();
}

function msgText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && (p.type === "text" || p.type === undefined))
      .map((p) => p.text || "")
      .join("\n");
  }
  return "";
}

/** 按候选索引提取该会话用户消息 */
function candidates(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "message" || o.message?.role !== "user") continue;
    const t = clean(stripHostInstruction(msgText(o.message)));
    if (!t || t.length < 8) continue;
    out.push(t);
  }
  return out;
}

function main() {
  const all = [];
  for (const sel of SELECTION) {
    const file = fs.readdirSync(SESSION_DIR).find((f) => f.startsWith(sel.f) && f.endsWith(".jsonl"));
    if (!file) throw new Error("session not found: " + sel.f);
    const cands = candidates(path.join(SESSION_DIR, file));
    for (const i of sel.idx) {
      if (!cands[i]) throw new Error(`${sel.f} idx ${i} out of range (${cands.length})`);
      all.push({ source: file.slice(0, 27), query: cands[i] });
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2), "utf8");
  console.log(`queries: ${all.length}\n`);
  all.forEach((q, i) => console.log(`${String(i + 1).padStart(2)}. [${q.source}] ${q.query.slice(0, 60)}`));
  console.log(`\n-> ${OUT}`);
}

main();
