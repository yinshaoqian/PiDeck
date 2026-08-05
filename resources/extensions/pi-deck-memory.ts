/**
 * PiDeck Memory Extension（跨会话记忆召回）
 *
 * 给 pi agent 暴露两个工具，让对话可以直接"召回"历史会话信息：
 *   1. search_memory(query) —— 检索 PiDeck Viking 记忆库（viking.db，SQLite），
 *      按关键词匹配 l0/l1/l2/tags/thread_id，返回记忆节点（含 thread_id → 关联会话）。
 *   2. read_session(target, {tail}) —— 读取历史会话 JSONL 内容：
 *      target 传 sessionId（记忆节点的 thread_id）或完整会话文件路径；
 *      tail 限制只读尾部 N 条消息（默认 30），避免大会话全量解析。
 *
 * 与 Breezell Viking 的差异：不注入上下文，而是"按需召回"——
 * agent 在对话中判断需要历史信息时主动调用工具，找到当时的会话再读内容。
 *
 * 环境变量 PIDECK_USER_DATA 由 PiDeck 主进程在 spawn pi 时注入（PiLocator.createProcessEnv），
 * 指向 app.getPath("userData")，viking.db 位于其中；sessions 目录位于 ~/.pi/agent/sessions。
 * 无该环境变量时回退：userData = ~/AppData/Roaming/pi-desktop（Windows 打包版）。
 *
 * @packageDocumentation
 */
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

/**
 * node:sqlite 惰性加载：Node ≥ 22.13 才内置此模块（22.5-22.12 需 --experimental-sqlite）。
 * 便携版在用户机器上跑 pi（系统 Node），Node 版本不可控——静态 import 在低版本直接让扩展
 * 加载失败、pi 启动崩溃（实测：No such built-in module: node:sqlite）。
 * 改为惰性 require + 降级：无 SQLite 能力时记忆工具返回提示，pi 正常启动。
 */
function loadSqlite(): { DatabaseSync: new (path?: string, opts?: { readOnly?: boolean }) => {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): { changes: number | bigint } };
  close(): void;
} } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:sqlite");
  } catch {
    return null;
  }
}

/** viking.db 路径：优先 PiDeck 注入的 userData；回退 Windows 打包版路径 */
function resolveVikingDbPath(): string {
  const userData = process.env.PIDECK_USER_DATA;
  if (userData) return join(userData, "viking.db");
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "pi-desktop",
      "viking.db",
    );
  }
  return join(homedir(), ".pideck", "viking.db");
}

/** 会话根目录：~/.pi/agent/sessions */
function sessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/** 关键词切分：中英文混合，按空白/标点拆分；含中文的片段再拆 bigram 提升召回 */
function tokenize(query: string): string[] {
  // 防御：工具参数异常（undefined/非字符串）时不崩溃，返回空集（调用方按无命中处理）
  if (typeof query !== "string" || !query.trim()) return [];
  const tokens: string[] = [];
  const parts = query
    .replace(/[，。！？；：、,.;:!?"'（）()【】\[\]{}<>《》\/\\|·\s]+/g, " ")
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  for (const part of parts) {
    if (/[\u4e00-\u9fff]/.test(part)) {
      // 含中文的片段（如「子agent上下文会不会爆炸」）：中英混合 bigram + 保留整串，
      // 让记忆库里的「上下文」「worktree」等片段可被召回；纯英文 token 不需要拆。
      const chars = part.replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, "");
      for (let i = 0; i + 1 < chars.length; i++) {
        tokens.push(chars.slice(i, i + 2));
      }
      tokens.push(part);
    } else {
      tokens.push(part);
    }
  }
  return [...new Set(tokens)].slice(0, 16);
}

/** 从 threadId（pi sessionId）定位会话文件：扫描 sessions 目录树，文件名含 sessionId */
function findSessionFileByThreadId(threadId: string): string | null {
  const stack = [sessionsRoot()];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) {
          stack.push(full);
          continue;
        }
      } catch {
        continue;
      }
      if (name.endsWith(".jsonl") && name.includes(threadId)) return full;
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // ── 工具①：检索历史记忆（召回） ─────────────────────────────
  pi.registerTool({
    name: "search_memory",
    label: "PiDeck: 检索历史会话记忆",
    description:
      "检索 PiDeck 跨会话记忆库（viking.db）。用于回答涉及“之前/昨天/上次讨论过某事”“某需求做到哪一步”“之前的结论/方案是什么”等需要历史上下文的问题。" +
      "返回记忆节点列表（L0 一句话摘要 + L1 要点 + tags + threadId 关联原始会话）。" +
      "命中后如需细节，用 read_session 传 threadId 读取原始会话内容。",
    parameters: Type.Object({
      query: Type.String({ description: "要召回的内容描述，如「埋点 SDKv3 实施」「抽屉布局方案」" }),
      topK: Type.Optional(Type.Number({ description: "返回条数，默认 5", default: 5 })),
      // 注意：typebox 本身没有 StringEnum，必须用 pi 导出的兼容版（内部是 Type.Unsafe({type:"string",enum:[...]})），
      // 否则扩展加载时报 _typebox.Type.StringEnum is not a function 导致整个 pi 启动失败。
      category: Type.Optional(StringEnum(["memory", "skill", "resource"], { description: "限定类型" })),
    }),
    async execute(_toolCallId: string, params: { query: string; topK?: number; category?: string }) {
      const args = params ?? {};
      const sqlite = loadSqlite();
      if (!sqlite) {
        // Node < 22.13：无 node:sqlite，记忆功能降级——不阻塞 pi，工具返回明确提示
        return {
          content: [{ type: "text", text: "记忆库功能需要 Node ≥ 22.13（内置 node:sqlite 模块）。当前 Node 版本不支持，请升级 Node 后重启 pi 再试。" }],
          details: { ok: false, reason: "no_sqlite" },
        };
      }
      const dbPath = resolveVikingDbPath();
      let db: InstanceType<ReturnType<typeof loadSqlite>>["DatabaseSync"] | null = null;
      try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `无法打开记忆库 ${dbPath}：${String(err)}。若记忆尚未建立，可先告知用户进行几次对话后再试。`,
          }],
          details: { ok: false, error: String(err) },
        };
      }
      try {
        const tokens = tokenize(args.query);
        const topK = Math.min(Math.max(args.topK ?? 5, 1), 20);
        if (tokens.length === 0) {
          return {
            content: [{ type: "text", text: "查询过短，无法提取关键词。" }],
            details: { ok: false, reason: "empty_query" },
          };
        }

        // LIKE 检索：每个关键词需命中 l0/l1/l2/tags 任一；关键词越多优先级越高（命中数排序）
        const rows = db
          .prepare(
            "SELECT id, path, category, priority, l0, l1, tags, thread_id, workspace_id, last_accessed_at, access_count FROM viking_nodes",
          )
          .all() as Array<{
            id: string;
            path: string;
            category: string;
            priority: string;
            l0: string;
            l1: string;
            tags: string;
            thread_id: string | null;
            workspace_id: string | null;
            last_accessed_at: number;
            access_count: number;
          }>;

        const scored: Array<{ node: (typeof rows)[number]; score: number }> = [];
        for (const node of rows) {
          if (args.category && node.category !== args.category) continue;
          const haystack = `${node.l0}\n${node.l1}\n${node.tags}`.toLowerCase();
          let hits = 0;
          for (const tk of tokens) {
            if (haystack.includes(tk.toLowerCase())) hits++;
          }
          if (hits === 0) continue;
          // 优先级加权：P0×2 / P1×1.5 / P2×1；命中词数为主序
          const prioWeight = node.priority === "P0" ? 2 : node.priority === "P1" ? 1.5 : 1;
          scored.push({ node, score: hits * prioWeight });
        }
        scored.sort((a, b) => b.score - a.score);

        const top = scored.slice(0, topK);
        if (top.length === 0) {
          return {
            content: [{
              type: "text",
              text: `记忆库中未找到与「${args.query}」相关的内容（共 ${rows.length} 条记忆）。`,
            }],
            details: { ok: true, total: rows.length, hits: 0 },
          };
        }

        const lines = top.map(({ node, score }) => {
          const tags = safeParseTags(node.tags);
          return [
            `# ${node.l0}`,
            node.l1 ? node.l1.split("\n").filter(Boolean).map((l) => `  - ${l}`).join("\n") : "",
            `  [type=${node.category} priority=${node.priority} score=${score.toFixed(1)}]${node.thread_id ? ` threadId=${node.thread_id}` : ""}${tags.length ? ` tags=${tags.join(",")}` : ""}`,
            `  sessionPath=${node.path}`,
          ].filter(Boolean).join("\n");
        });

        return {
          content: [{
            type: "text",
            text: `记忆库命中 ${top.length}/${rows.length} 条（关键词：${tokens.join(", ")}）：\n\n${lines.join("\n\n")}\n\n需要看某个会话的完整内容时，用 read_session 传 threadId。`,
          }],
          details: { ok: true, total: rows.length, hits: top.length },
        };
      } finally {
        try { db.close(); } catch { /* noop */ }
      }
    },
  });

  // ── 工具②：读取历史会话内容 ───────────────────────────────
  pi.registerTool({
    name: "read_session",
    label: "PiDeck: 读取历史会话内容",
    description:
      "读取一个历史会话（JSONL）的消息内容。target 传 sessionId（search_memory 返回的 threadId）或完整会话文件路径。" +
      "【两种模式】1) grep 传关键词：按关键词定位会话中相关内容，返回命中消息及其前后 context 条消息（默认 5）——" +
      "这是查找“会话中段讨论了什么”的首选方式，不要用 bash grep 手动翻 JSONL。" +
      "2) 不传 grep：tail 限制只读尾部 N 条 user/assistant 消息（默认 30）。",
    parameters: Type.Object({
      target: Type.String({ description: "sessionId（threadId）或会话文件路径" }),
      tail: Type.Optional(Type.Number({ description: "读取尾部消息条数（grep 未命中时用），默认 30", default: 30 })),
      grep: Type.Optional(Type.String({ description: "关键词：定位会话中相关消息并返回上下文，避免手动翻文件" })),
      context: Type.Optional(Type.Number({ description: "grep 模式：命中消息前后各取几条（默认 5）", default: 5 })),
    }),
    async execute(_toolCallId: string, params: { target: string; tail?: number; grep?: string; context?: number }) {
      const args = params ?? {};
      let filePath = args.target;
      if (!filePath.includes(".jsonl")) {
        const resolved = findSessionFileByThreadId(args.target);
        if (!resolved) {
          return {
            content: [{
              type: "text",
              text: `未找到 sessionId=${args.target} 对应的会话文件（已扫描 ${sessionsRoot()}）。可能该会话已删除，或 threadId 不是 pi sessionId。`,
            }],
            details: { ok: false, reason: "session_not_found" },
          };
        }
        filePath = resolved;
      }

      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (err) {
        return {
          content: [{ type: "text", text: `读取会话失败：${String(err)}` }],
          details: { ok: false, error: String(err) },
        };
      }

      const tail = Math.min(Math.max(args.tail ?? 30, 5), 200);
      const entries: Array<{ role: string; text: string; ts?: number }> = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const msg = entry.message ?? entry;
          if (!msg?.role) continue;
          if (msg.role !== "user" && msg.role !== "assistant") continue;
          const text = extractText(msg.content);
          if (!text) continue;
          // 消息时间戳：内层 message.timestamp（ms）优先，外层 timestamp（ISO 字符串）兑底；统一转 ms 便于本地化显示
          const rawTs = msg.timestamp ?? entry.timestamp;
          const ts = typeof rawTs === "number" ? rawTs : typeof rawTs === "string" ? new Date(rawTs).getTime() : undefined;
          entries.push({ role: msg.role, text, ts: Number.isFinite(ts as number) ? (ts as number) : undefined });
        } catch {
          // 单行损坏跳过
        }
      }
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `会话 ${sessionDisplayName(filePath)} 暂无消息内容。` }],
          details: { ok: true, file: filePath, count: 0 },
        };
      }

      // grep 模式：按关键词定位会话中段内容，返回命中消息及其前后 context 条
      // （替代 bash grep 手动翻 JSONL；关键词大小写不敏感）
      const grepKw = args.grep?.trim();
      if (grepKw) {
        const context = Math.min(Math.max(args.context ?? 5, 0), 10);
        const kw = grepKw.toLowerCase();
        const hitIndexes: number[] = [];
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].text.toLowerCase().includes(kw)) hitIndexes.push(i);
        }
        if (hitIndexes.length === 0) {
          return {
            content: [{
              type: "text",
              text: `会话 ${sessionDisplayName(filePath)} 中未找到包含「${grepKw}」的消息（共 ${entries.length} 条）。可换关键词或用 tail 读尾部。`,
            }],
            details: { ok: true, file: filePath, total: entries.length, grepHits: 0 },
          };
        }
        // 命中消息去重并带上上下文（相邻命中合并窗口）
        const selected = new Set<number>();
        for (const idx of hitIndexes) {
          for (let j = Math.max(0, idx - context); j <= Math.min(entries.length - 1, idx + context); j++) {
            selected.add(j);
          }
        }
        const indexes = [...selected].sort((a, b) => a - b);
        const hitSet = new Set(hitIndexes);
        const lines = indexes.map((idx) => {
          const m = entries[idx];
          const mark = hitSet.has(idx) ? "【命中】" : "";
          const ts = m.ts ? `（${formatMsgLocalTime(m.ts)}）` : "";
          return `### ${m.role === "user" ? "用户" : "助手"}${ts}${mark}\n${truncate(m.text, 1500)}`;
        });
        return {
          content: [{
            type: "text",
            text: `会话：${sessionDisplayName(filePath)}（关键词「${grepKw}」命中 ${hitIndexes.length} 条消息，展示命中及前后 ${context} 条，共 ${indexes.length} 条）：\n\n${lines.join("\n\n")}`,
          }],
          details: { ok: true, file: filePath, total: entries.length, grepHits: hitIndexes.length, shown: indexes.length },
        };
      }

      const recent = entries.slice(-tail);
      const summary = entries.length > tail
        ? `（会话共 ${entries.length} 条消息，展示末尾 ${tail} 条）`
        : `（会话共 ${entries.length} 条消息）`;
      const lines = recent.map((m) => `### ${m.role === "user" ? "用户" : "助手"}${m.ts ? `（${formatMsgLocalTime(m.ts)}）` : ""}\n${truncate(m.text, 2000)}`);
      return {
        content: [{
          type: "text",
          text: `会话：${sessionDisplayName(filePath)}\n${summary}\n\n${lines.join("\n\n")}`,
        }],
        details: { ok: true, file: filePath, total: entries.length, shown: recent.length },
      };
    },
  });

  // ── 工具③：跨会话全文检索（search_sessions） ────────────────────
  pi.registerTool({
    name: "search_sessions",
    label: "PiDeck: 跨会话全文检索历史会话",
    description:
      "全文检索 PiDeck 所有历史会话（~/.pi/agent/sessions 下的 JSONL），中英文关键词均可命中任意位置。" +
      "用于回答涉及“之前/昨天/之前某次讨论/某个方案/某段代码是在哪个会话里聊的”等问题。\n" +
      "【使用规范】返回的是“会话目录”（每个会话一行：项目/日期/主题/命中数），不要把所有内容展示给用户，" +
      "也不要直接凭 snippet 下结论——先向用户呈现目录，由用户指定要看哪个（如“看 1”），" +
      "再用 read_session 读取该会话完整内容后回答。这避免把大量历史文本灌入上下文。" +
      "【防重复】对同一话题不要连续多次换关键词搜索——第一次结果即代表最佳匹配；" +
      "若命中会话不足或用户明确要求，才换关键词重搜。",
    parameters: Type.Object({
      query: Type.String({ description: "要检索的内容，如「埋点 SDKv3」「抽屉布局」「agent 慢启动」" }),
      topK: Type.Optional(Type.Number({ description: "返回会话目录条数，默认 5", default: 5 })),
      detail: Type.Optional(Type.Boolean({ description: "true 时附带命中片段（默认 false 只回目录）", default: false })),
    }),
    async execute(_toolCallId: string, params: { query: string; topK?: number; detail?: boolean }) {
      const args = params ?? {};
      const topK = Math.min(Math.max(args.topK ?? 5, 1), 10);
      try {
        const indexer = new SessionIndexer(resolveUserDataDir());
        const t0 = Date.now();
        // 增量同步索引（首次全量，之后只处理新增/变化文件）
        const stats = indexer.sync();
        const hits = indexer.search(args.query, topK);
        const syncMs = Date.now() - t0;

        if (hits.length === 0) {
          return {
            content: [{
              type: "text",
              text: `所有会话中未找到与「${args.query}」相关的内容（已索引 ${stats.sessions} 个会话，同步 ${syncMs}ms）。`,
            }],
            details: { ok: true, sessions: stats.sessions, hits: 0, syncMs },
          };
        }

        // 目录级输出：每个会话一行（项目/创建时间/主题/命中数），正文交给用户选择后再读
        const lines = hits.map((h, i) => {
          const meta = h.projectPath ? `[${h.projectPath}]` : "";
          const topic = (h.topic || "").replace(/\s+/g, " ").slice(0, 60);
          const detailLine = args.detail && h.snippet ? `   …${h.snippet}…` : "";
          // 会话名 + 本地创建时间标注：文件名时间戳是 UTC，不换算会把 06:15Z 误读为本地 06:15（偏移 8 小时）
          const timeTag = (() => {
            const t = localTimeFromSessionFile(h.sessionFile);
            return t ? `（创建于 ${t} 本地）` : "";
          })();
          return [
            `${i + 1}. ${meta} ${h.sessionName || basename(h.sessionFile)}${timeTag}（命中 ${h.hitCount} 处）`,
            `   主题：${topic || "（无主题摘要）"}`,
            detailLine,
          ].filter(Boolean).join("\n");
        });
        return {
          content: [{
            type: "text",
            text: `检索「${args.query}」命中 ${hits.length} 个会话（索引 ${stats.sessions} 个，同步 ${syncMs}ms）：\n\n${lines.join("\n\n")}\n\n请告诉我要看哪个（如“看 1”），我会读取该会话的完整内容。不要一次性展示全部会话内容。`,
          }],
          details: { ok: true, sessions: stats.sessions, hits: hits.length, syncMs },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `跨会话检索失败：${String(err instanceof Error ? err.message : err)}`,
          }],
          details: { ok: false, error: String(err) },
        };
      }
    },
  });
}

/** userData 目录：优先 PIDECK_USER_DATA 环境变量（PiDeck 注入），回退 Windows 打包版 */
function resolveUserDataDir(): string {
  const userData = process.env.PIDECK_USER_DATA;
  if (userData) return userData;
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "pi-desktop",
    );
  }
  return join(homedir(), ".pideck");
}

function safeParseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const o = c as Record<string, unknown>;
          return typeof o.text === "string" ? o.text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/** 从命中 chunk 截取关键词上下文片段（替代 SQLite snippet()，兼容 MATCH 与 LIKE） */
function makeSnippet(text: string, query: string): string {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return truncate(text.replace(/\s+/g, " "), 160);
  const start = Math.max(0, idx - 50);
  return `${start > 0 ? "…" : ""}${text.slice(start, idx + 120).replace(/\s+/g, " ")}${idx + 120 < text.length ? "…" : ""}`;
}

// ─────────────────────────────────────────────────────────────
// 跨会话全文索引（SessionIndexer）：SQLite FTS5 trigram + 增量水印
// ─────────────────────────────────────────────────────────────

/** 递归收集会话 JSONL 文件 */
function collectJsonl(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) files.push(...collectJsonl(full));
    else if (name.endsWith(".jsonl") && !name.includes(".edit-backup")) files.push(full);
  }
  return files;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 从文件路径推断项目（encoded-cwd 目录段） */
function inferProject(filePath: string): string {
  const marker = "/.pi/agent/sessions/";
  const idx = normalizePath(filePath).indexOf(marker);
  if (idx === -1) return "";
  const seg = normalizePath(filePath).slice(idx + marker.length).split("/")[0] ?? "";
  // --C--kaifa-web-tracing-docs-- → C:/kaifa/web-tracing-docs（近似，连字符有歧义）
  if (seg.startsWith("--")) {
    const inner = seg.replace(/^--|--$/g, "");
    const m = inner.match(/^([a-z])--(.+)$/);
    if (m) return `${m[1].toUpperCase()}:/${m[2].replace(/-/g, "/")}`;
    return inner.replace(/-/g, "/");
  }
  return seg;
}

/**
 * 精确项目路径：从会话文件首行的 session header 读 pi 写入的 cwd。
 * encoded 目录名反推有歧义（pi 把路径段与名字里的连字符混用：
 * web-tracing-docs 会被拆成 web/tracing/docs），必须用文件内的 cwd 字段。
 */
function readSessionCwd(filePath: string): string {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const br = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, br).toString("utf8");
      const line = head.split("\n")[0];
      if (line && line.trim()) {
        const entry = JSON.parse(line);
        const cwd = entry?.cwd ?? entry?.data?.cwd ?? entry?.session?.cwd;
        if (typeof cwd === "string" && cwd.trim()) return cwd;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // 首行解析失败时回退到 encoded 反推（近似值）
  }
  return inferProject(filePath);
}

/** 从文件名取会话名（不含扩展名与时间戳前缀） */
function inferSessionName(filePath: string): string {
  const base = basename(filePath).replace(/\.jsonl$/, "");
  // 2026-08-03T18-56-49-564Z_019fcb03-.... → 截断为可读短名
  const m = base.match(/^([\d-]+T[\d-]+Z)_(.+)$/);
  return m ? m[2].slice(0, 24) : base.slice(0, 40);
}

/**
 * 从 pi 会话文件名解析 UTC 时间戳并换算成本地时间字符串（如 "2026-08-05 14:15:11"）。
 * pi 文件名格式为 <UTC时间>_<ULID>.jsonl（如 2026-08-05T06-15-11-180Z_019fd08f...jsonl），
 * 时分秒用连字符且带 Z 后缀——必须按 UTC 解析再 +8（本地时区）显示，否则读文件名的 AI/用户
 * 会把 06:15 当成本地时间，系统性偏移 8 小时（此前多次误判会话为"几小时前创建"）。
 */
function localTimeFromSessionFile(filePath: string): string | null {
  const base = basename(filePath);
  // 兼容连字符（06-15-11）与冒号（06:15:11）两种分隔，毫秒段可选
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})(?:-\d{3})?Z/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  if (Number.isNaN(dt.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

/** 任意消息时间戳（ISO 字符串或 ms 数字）→ 本地时间字符串；解析失败返回 null */
function formatMsgLocalTime(ts: unknown): string | null {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toLocaleString("zh-CN");
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString("zh-CN");
  }
  return null;
}

/** 会话展示名：短名 + （本地创建时间）标注，明确标注时区避免误判 */
function sessionDisplayName(filePath: string): string {
  const name = inferSessionName(filePath);
  const t = localTimeFromSessionFile(filePath);
  return t ? `${name}（创建于 ${t} 本地）` : name;
}

/** toolCall → 元信息文本（工具名 + 关键参数） */
function describeToolCall(c: { name?: string; arguments?: unknown }): string {
  const args = (c.arguments ?? {}) as Record<string, unknown>;
  const keys = ["command", "path", "filePath", "file", "url", "query", "pattern", "source"];
  const picked: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v) picked.push(`${k}=${v}`);
  }
  return `[tool:${c.name ?? ""}] ${picked.join(" ")}`.trim();
}

/** toolResult → 元信息 + 输出摘要（前 500 字符） */
function describeToolResult(msg: { toolName?: string; isError?: boolean; content?: unknown }): string {
  const text = extractText(msg.content);
  const head = text.slice(0, 500);
  return `[result:${msg.toolName ?? ""}${msg.isError ? " ERROR" : ""}] ${head}`.trim();
}

/**
 * 净化提取：只取有检索价值的文本入索引。
 * - user/assistant：全部文本（讨论/决策主体）
 * - assistant 内嵌 toolCall：工具名 + 命令/文件参数（“做了什么”）
 * - toolResult：工具名 + isError + 输出前 500 字符（“发生了什么/报错”）
 * - 跳过：thinking、系统元数据、超长输出尾巴、JSON 序列化噪音
 */
function extractIndexTextFromRaw(raw: string): string {
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过
    }
    const msg = entry.message ?? entry;
    const role = msg.role;
    if (role === "user" || role === "assistant") {
      const text = extractText(msg.content);
      if (text) parts.push(text);
      // assistant 消息里的 toolCall 提取元信息
      if (role === "assistant" && Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c && typeof c === "object" && (c as { type?: string }).type === "toolCall") {
            const t = describeToolCall(c as { name?: string; arguments?: unknown });
            if (t) parts.push(t);
          }
        }
      }
    } else if (role === "toolResult") {
      const t = describeToolResult(msg as { toolName?: string; isError?: boolean; content?: unknown });
      if (t) parts.push(t);
    }
    // 其它角色（thinking 等）不索引
  }
  return parts.join("\n");
}

/** 按固定大小切块（每块约 8KB），块内文本独立可检索 */
function chunkText(text: string, size = 8000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/**
 * 跨会话全文索引器：
 * - FTS5 trigram（中文/英文任意子串命中，已实测）
 * - 增量水印：会话文件是追加写，只读新增字节重建增量块
 * - 生命周期：文件被删除/重写时同步清理/重建该会话索引
 * - 共享存储：userData/session_index.db，所有 pi 进程可读（跨会话真正可用）
 */
class SessionIndexer {
  private db: InstanceType<ReturnType<typeof loadSqlite>>["DatabaseSync"] | null;

  constructor(userDataDir: string) {
    const sqlite = loadSqlite();
    if (!sqlite) {
      // Node < 22.13：无 node:sqlite，全文索引降级（search_sessions 不可用，不阻塞 pi）
      this.db = null;
      return;
    }
    this.db = new sqlite.DatabaseSync(join(userDataDir, "session_index.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scan_state (
        session_file TEXT PRIMARY KEY,
        indexed_size INTEGER NOT NULL DEFAULT 0,
        indexed_mtime REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_meta (
        session_file TEXT PRIMARY KEY,
        project_path TEXT NOT NULL DEFAULT '',
        session_name TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS session_chunks USING fts5(
        session_file, project_path, session_name, chunk_text, chunk_index,
        tokenize="trigram"
      );
    `);
    this.migrateMetaOnce();
  }

  /**
   * 旧库一次性迁移：早期版本把 project_path/session_name 存在 FTS5 虚拟表里，
   * sync() 里每次对水印命中会话刷新 project_path 时，FTS5 会把 UPDATE 模拟成
   * 每行 DELETE+INSERT + 倒排重写（trigram 索引 300MB+），274 个会话要 27s+，
   * 导致 search_sessions 每次调用都卡近一分钟。
   * 元数据挪进普通表 session_meta 后，FTS5 表只承载 chunk 正文（旧列保留为死列，
   * 避免重建大索引；新写入的 project_path/session_name 恒为空串）。
   */
  private migrateMetaOnce(): void {
    const cnt = this.db.prepare("SELECT COUNT(*) c FROM session_meta").get() as { c: number };
    if (cnt.c > 0) return;
    // 从历史 FTS5 列回填（MAX 对字符串比较取非空优先；GROUP BY 每会话一行）
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_meta (session_file, project_path, session_name)
         SELECT session_file, MAX(project_path), MAX(session_name)
         FROM session_chunks GROUP BY session_file`,
      )
      .run();
  }

  /** 增量同步全部会话索引；返回统计 */
  sync(): { sessions: number; chunks: number; removed: number } {
    if (!this.db) return { sessions: 0, chunks: 0, removed: 0 }; // Node 无 node:sqlite：索引不可用
    const files = collectJsonl(sessionsRoot());
    const seen = new Set<string>();
    let chunks = 0;
    for (const f of files) {
      seen.add(normalizePath(f));
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      const state = this.db
        .prepare("SELECT indexed_size, indexed_mtime FROM scan_state WHERE session_file = ?")
        .get(f) as { indexed_size: number; indexed_mtime: number } | undefined;
      // mtime 需用数值（mtimeMs），Date 对象无法绑定 SQLite 参数
      if (state && state.indexed_size === st.size && state.indexed_mtime === st.mtimeMs) {
        // 水印命中：索引未变，零操作直接跳过。
        // ⚠️ 早期版本曾在此刷新 project_path：对 FTS5 虚拟表执行 UPDATE 会被模拟成
        // 每行 DELETE+INSERT + 倒排重写（trigram 索引 300MB+），274 个会话要 27s+，
        // 导致 search_sessions 每次调用都卡近一分钟。现元数据已挪到普通表
        // session_meta，reindex 时才更新，此处不再有任何数据库写操作。
        continue;
      }
      chunks += this.reindexSession(f, st.size, st.mtimeMs, state);
    }
    // 清理已删除文件的残留索引
    let removed = 0;
    const indexed = this.db.prepare("SELECT DISTINCT session_file FROM session_chunks").all() as Array<{ session_file: string }>;
    for (const row of indexed) {
      if (!seen.has(normalizePath(row.session_file))) {
        this.db.prepare("DELETE FROM session_chunks WHERE session_file = ?").run(row.session_file);
        this.db.prepare("DELETE FROM session_meta WHERE session_file = ?").run(row.session_file);
        this.db.prepare("DELETE FROM scan_state WHERE session_file = ?").run(row.session_file);
        removed++;
      }
    }
    return { sessions: files.length, chunks, removed };
  }

  private reindexSession(
    filePath: string,
    size: number,
    mtime: number,
    state?: { indexed_size: number },
  ): number {
    // 文件重写（size 变小或首建）→ 整会话重建；追加写 → 只读新增字节
    const start = state && size >= state.indexed_size ? state.indexed_size : 0;
    if (start === 0) {
      this.db.prepare("DELETE FROM session_chunks WHERE session_file = ?").run(filePath);
      this.db.prepare("DELETE FROM session_meta WHERE session_file = ?").run(filePath);
    }
    let raw = "";
    try {
      if (size > start) {
        const buf = Buffer.alloc(size - start);
        const fd = openSync(filePath, "r");
        try {
          const bytesRead = readSync(fd, buf, 0, buf.length, start);
          raw = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      return 0;
    }
    const text = extractIndexTextFromRaw(raw);
    if (!text) {
      // 无新增可索引内容也更新水印，避免反复重读
      this.db.prepare("INSERT OR REPLACE INTO scan_state (session_file, indexed_size, indexed_mtime) VALUES (?,?,?)").run(filePath, size, mtime);
      return 0;
    }
    const chunks = chunkText(text);
    const project = readSessionCwd(filePath);
    const name = inferSessionName(filePath);
    // 元数据写普通表（廉价）；FTS5 虚拟表的 project_path/session_name 是历史遗留
    // 死列，恒写空串——对 FTS5 表执行 UPDATE/DELETE 会触发整行倒排重写，代价极高
    this.db
      .prepare("INSERT OR REPLACE INTO session_meta (session_file, project_path, session_name) VALUES (?,?,?)")
      .run(filePath, project, name);
    const ins = this.db.prepare(
      "INSERT INTO session_chunks (session_file, project_path, session_name, chunk_text, chunk_index) VALUES (?,?,?,?,?)",
    );
    for (let i = 0; i < chunks.length; i++) {
      ins.run(filePath, "", "", chunks[i], i);
    }
    this.db.prepare("INSERT OR REPLACE INTO scan_state (session_file, indexed_size, indexed_mtime) VALUES (?,?,?)").run(filePath, size, mtime);
    return chunks.length;
  }

  /**
   * 检索：≥3 字词用 FTS5 MATCH（OR 组合，trigram 子串命中），
   * 2 字中文词（trigram 盲区）用 LIKE 兜底；合并打分后返回结构化结果。
   * snippet 不用 SQLite snippet()（GROUP BY/聚合下不可用），改由命中 chunk 自行截取。
   */
  search(query: string, topK: number): Array<{
    sessionFile: string;
    sessionName: string;
    projectPath: string;
    hitCount: number;
    snippet: string;
  }> {
    if (!this.db) return []; // Node 无 node:sqlite：索引不可用
    // 防御：query 异常（undefined/非字符串）时返回空结果，不崩溃
    if (typeof query !== "string" || !query.trim()) return [];
    const parts = query
      .replace(/[，。！？；：、,.;:!?"'（）()【】\[\]{}<>《》\/\\|·\s]+/g, " ")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);
    const longParts = parts.filter((p) => p.length >= 3);
    const shortParts = parts.filter((p) => p.length === 2);
    if (parts.length === 0) return [];

    // 候选会话打分：session_file -> score
    const scores = new Map<string, number>();
    // 每个命中 chunk 记一句片段（取最早的）
    const snippets = new Map<string, { text: string; query: string }>();

    if (longParts.length > 0) {
      const matchQuery = longParts.map((p) => p.replace(/"/g, "")).join(" OR ");
      const rows = this.db
        .prepare(
          "SELECT session_file, chunk_text, chunk_index FROM session_chunks WHERE session_chunks MATCH ?",
        )
        .all(matchQuery) as Array<{ session_file: string; chunk_text: string; chunk_index: number }>;
      for (const r of rows) {
        scores.set(r.session_file, (scores.get(r.session_file) ?? 0) + 1);
        if (!snippets.has(r.session_file)) {
          snippets.set(r.session_file, { text: r.chunk_text, query: longParts[0] });
        }
      }
    }

    // 2 字词 LIKE 兜底（FTS5 虚拟表支持 LIKE，线性扫描毫秒级）
    for (const sp of shortParts) {
      const likeRows = this.db
        .prepare("SELECT session_file, chunk_text FROM session_chunks WHERE chunk_text LIKE ?")
        .all(`%${sp}%`) as Array<{ session_file: string; chunk_text: string }>;
      for (const r of likeRows) {
        scores.set(r.session_file, (scores.get(r.session_file) ?? 0) + 2);
        if (!snippets.has(r.session_file)) {
          snippets.set(r.session_file, { text: r.chunk_text, query: sp });
        }
      }
    }

    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    return ranked.map(([sessionFile, score]) => {
      const snip = snippets.get(sessionFile);
      // 元数据从普通表读（FTS5 表只承载 chunk 正文）
      const meta = this.db
        .prepare("SELECT session_name, project_path FROM session_meta WHERE session_file = ?")
        .get(sessionFile) as { session_name: string; project_path: string } | undefined;
      return {
        sessionFile,
        sessionName: meta?.session_name ?? "",
        projectPath: meta?.project_path ?? "",
        hitCount: score,
        // 会话主题：命中 chunk 的开头文本（通常是会话早期讨论，代表“这是什么会话”）
        topic: snip?.text ? snip.text.replace(/\s+/g, " ").slice(0, 120) : "",
        // 命中片段：detail 模式才展示（目录模式下不占用上下文）
        snippet: snip ? makeSnippet(snip.text, snip.query) : "",
      };
    });
  }
}
