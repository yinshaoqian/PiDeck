/**
 * 记忆检索回归测试 —— 历史 query 提取脚本
 *
 * 从 ~/.pi/agent/sessions/--C--kaifa-PiDeck--/ 最近若干会话 JSONL 中提取
 * 真实用户消息作为检索 query 集（不含当前任务会话）。
 *
 * 清洗规则：
 *  - 去除 [PIDECK_HOST_INSTRUCTION]...[/PIDECK_HOST_INSTRUCTION] 宿主包裹体
 *  - 去除 [图片]/[image]/[图] 等占位
 *  - 去除空白、过短、连续重复的消息
 *  - 每会话最多 N 条（超出则均匀抽样），保持时间覆盖均匀
 *
 * 输出：scripts/.memtest/queries.json  [ { source, query } ]
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "--C--kaifa-PiDeck--");
const MAX_SESSIONS = 5;        // 取最近 5 个会话
const MAX_PER_SESSION = 10;    // 每会话最多 10 条
const MIN_LEN = 10;            // 最小 query 长度（字符）
const EXCLUDE_IDS = ["019fd0c1-77d1-77d3-af88-36510f7f388e"]; // 当前任务会话（019fd0c1）

/** 剥离宿主指令包裹体 */
function stripHostInstruction(text) {
  const m = text.match(/\[PIDECK_HOST_INSTRUCTION\]([\s\S]*?)\[\/PIDECK_HOST_INSTRUCTION\]/);
  if (!m) return text;
  // 包裹体之后的部分是真实用户消息；包裹体内也可能含任务描述，但一律不作为 query
  return text.slice(m.index + m[0].length);
}

/** 去图片占位 */
function stripImagePlaceholders(text) {
  return text.replace(/\[(?:图片|image|图)\s*\d*\]/gi, "").replace(/\(图片\)/g, "");
}

/** 从消息 content 中提取纯文本（text part 拼接） */
function messageText(message) {
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

/** 读取会话文件并返回用户消息列表 */
function extractQueriesFromSession(file) {
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
    let text = messageText(o.message);
    text = stripHostInstruction(text);
    text = stripImagePlaceholders(text);
    text = text.replace(/\s+/g, " ").trim();
    if (!text || text.length < MIN_LEN) continue;
    // 连续重复过滤（上一轮已问过）
    if (out.length > 0 && out[out.length - 1].query === text) continue;
    out.push({ query: text, ts: o.timestamp });
  }
  return out;
}

/** 均匀抽样：每会话最多 MAX_PER_SESSION 条 */
function sample(list, max) {
  if (list.length <= max) return list;
  const out = [];
  const step = list.length / max;
  for (let i = 0; i < max; i++) {
    out.push(list[Math.min(list.length - 1, Math.floor(i * step + step / 2))]);
  }
  return out;
}

function main() {
  const files = fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".edit-backup"))
    .filter((f) => !EXCLUDE_IDS.some((id) => f.includes(id)))
    .map((f) => ({ f, mtime: fs.statSync(path.join(SESSION_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS);

  const all = [];
  for (const { f, mtime } of files) {
    const msgs = extractQueriesFromSession(path.join(SESSION_DIR, f));
    const picked = sample(msgs, MAX_PER_SESSION);
    all.push(...picked.map((m) => ({ source: f.slice(0, 27), query: m.query })));
    console.log(`[${f.slice(0, 27)}] user msgs=${msgs.length} picked=${picked.length}`);
  }
  fs.mkdirSync(path.join(__dirname, ".memtest"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, ".memtest", "queries.json"), JSON.stringify(all, null, 2), "utf8");
  console.log(`\ntotal queries: ${all.length} -> scripts/.memtest/queries.json`);
}

main();
