/**
 * Viking 记忆系统 —— SQLite 存储层
 *
 * 复刻 Breezell viking.db 的完整 schema：viking_nodes 存记忆节点（L0/L1/L2 三级 +
 * 优先级 + 标签 + 访问统计 + 过期），viking_embeddings 存向量（JSON 文本列，
 * 供可选的 embedding 检索增强；无 embedding 服务时纯关键词检索不受影响）。
 *
 * 数据库文件位于 app.getPath("userData")/viking.db，与 settings.json 同级，
 * 开发/打包环境自动隔离（userData 随应用实例切换）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryCategory, MemoryNode } from "../../shared/types";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS viking_nodes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'memory',
  l0 TEXT NOT NULL DEFAULT '',
  l1 TEXT NOT NULL DEFAULT '',
  l2 TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'P1',
  tags TEXT NOT NULL DEFAULT '[]',
  parent_dir TEXT NOT NULL DEFAULT 'memories',
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  source TEXT NOT NULL DEFAULT 'conversation',
  thread_id TEXT,
  metadata TEXT,
  workspace_id TEXT
);

CREATE TABLE IF NOT EXISTS viking_embeddings (
  node_id TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES viking_nodes(id) ON DELETE CASCADE
);

-- 已提取会话标记：低频轮询提取（每 1h 一次）只扫描 1 小时前结束且从未提取过的会话，
-- 每个会话只提取一次（用户要求：不重复扫描、不频繁调用）。
CREATE TABLE IF NOT EXISTS extracted_sessions (
  session_id TEXT PRIMARY KEY,
  extracted_at INTEGER NOT NULL
);

-- LLM 提取消耗统计：每次提取/去重/蒸馏调用记录 tokens（用户要求可查看消耗）。
-- 只增不删（周期性的清理由 runLifecycle 控制，保留最近 30 天）。
CREATE TABLE IF NOT EXISTS extraction_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_extraction_usage_at ON extraction_usage(at);

CREATE INDEX IF NOT EXISTS idx_viking_nodes_category ON viking_nodes(category);
CREATE INDEX IF NOT EXISTS idx_viking_nodes_priority ON viking_nodes(priority);
CREATE INDEX IF NOT EXISTS idx_viking_nodes_parent_dir ON viking_nodes(parent_dir);
CREATE INDEX IF NOT EXISTS idx_viking_nodes_expires ON viking_nodes(expires_at);
CREATE INDEX IF NOT EXISTS idx_viking_nodes_workspace ON viking_nodes(workspace_id);
`;

function parseTags(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string | null) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * workspace 路径归一化：统一小写 + 正斜杠。
 * 消除跨会话路径大小写（C: vs c:）与分隔符（\ vs /）不一致导致的
 * workspace_id 精确匹配漏配（历史记忆可能存了小写/正斜杠，projectStore 可能返回大写/反斜杠）。
 */
function normalizeWorkspaceKey(workspaceId: string | null): string | null {
	if (!workspaceId) return null;
	return workspaceId.toLowerCase().replace(/\\/g, "/");
}

/** 数据库行 → MemoryNode */
function rowToNode(row: Record<string, unknown>): MemoryNode {
  return {
    id: String(row.id),
    path: String(row.path),
    category: String(row.category) as MemoryCategory,
    l0: String(row.l0 ?? ""),
    l1: String(row.l1 ?? ""),
    l2: String(row.l2 ?? ""),
    priority: (String(row.priority ?? "P1")) as MemoryNode["priority"],
    tags: parseTags(row.tags as string | null),
    parentDir: String(row.parent_dir ?? "memories"),
    createdAt: Number(row.created_at ?? 0),
    lastAccessedAt: Number(row.last_accessed_at ?? 0),
    accessCount: Number(row.access_count ?? 0),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    source: String(row.source ?? "conversation") as MemoryNode["source"],
    threadId: row.thread_id ? String(row.thread_id) : undefined,
    metadata: parseMetadata(row.metadata as string | null),
    workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
  };
}

export class VikingDb {
  private db: DatabaseSync | null = null;

  constructor(private readonly dbPath: string) {}

  /** 惰性打开（首次访问时建库），WAL 模式 + 索引 */
  private ensureOpen(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec(SCHEMA);
    this.db = db;
    return db;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  // ── 已提取会话标记（低频轮询去重） ────────────────

  markSessionExtracted(sessionId: string): void {
    this.ensureOpen()
      .prepare("INSERT OR REPLACE INTO extracted_sessions (session_id, extracted_at) VALUES (?, ?)")
      .run(sessionId, Date.now());
  }

  isSessionExtracted(sessionId: string): boolean {
    const row = this.ensureOpen()
      .prepare("SELECT 1 FROM extracted_sessions WHERE session_id = ?")
      .get(sessionId);
    return Boolean(row);
  }

  // ── 提取消耗统计（LLM usage） ────────────────────────

  recordUsage(rec: { at: number; stage: string; provider: string; model: string; promptTokens: number; completionTokens: number }): void {
    this.ensureOpen()
      .prepare("INSERT INTO extraction_usage (at, stage, provider, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run(rec.at, rec.stage, rec.provider, rec.model, Math.max(0, rec.promptTokens | 0), Math.max(0, rec.completionTokens | 0));
  }

  /** 提取消耗汇总：今日/累计/分阶段/分模型 + 最近 20 条明细 */
  getUsageStats(): {
    today: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
    total: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
    byStage: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
    byModel: Array<{ provider: string; model: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
    recent: Array<{ id: number; at: number; stage: string; provider: string; model: string; promptTokens: number; completionTokens: number }>;
  } {
    const db = this.ensureOpen();
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const sum = (rows: Array<{ calls: number; prompt_tokens: number; completion_tokens: number }>) =>
      rows.reduce(
        (acc, r) => ({
          calls: acc.calls + Number(r.calls ?? 0),
          promptTokens: acc.promptTokens + Number(r.prompt_tokens ?? 0),
          completionTokens: acc.completionTokens + Number(r.completion_tokens ?? 0),
        }),
        { calls: 0, promptTokens: 0, completionTokens: 0 },
      );
    const todayRows = db
      .prepare("SELECT COUNT(*) calls, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens FROM extraction_usage WHERE at >= ?")
      .get(dayStart) as { calls: number; prompt_tokens: number; completion_tokens: number };
    const totalRows = db
      .prepare("SELECT COUNT(*) calls, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens FROM extraction_usage")
      .get() as { calls: number; prompt_tokens: number; completion_tokens: number };
    const stageRows = db
      .prepare("SELECT stage, COUNT(*) calls, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens FROM extraction_usage GROUP BY stage")
      .all() as Array<{ stage: string; calls: number; prompt_tokens: number; completion_tokens: number }>;
    const modelRows = db
      .prepare("SELECT provider, model, COUNT(*) calls, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens FROM extraction_usage GROUP BY provider, model ORDER BY calls DESC")
      .all() as Array<{ provider: string; model: string; calls: number; prompt_tokens: number; completion_tokens: number }>;
    const recent = db
      .prepare("SELECT id, at, stage, provider, model, prompt_tokens, completion_tokens FROM extraction_usage ORDER BY id DESC LIMIT 20")
      .all() as Array<{ id: number; at: number; stage: string; provider: string; model: string; prompt_tokens: number; completion_tokens: number }>;
    const mk = (r: { calls: number; prompt_tokens: number; completion_tokens: number }) => ({
      calls: Number(r.calls ?? 0),
      promptTokens: Number(r.prompt_tokens ?? 0),
      completionTokens: Number(r.completion_tokens ?? 0),
    });
    return {
      today: { ...mk(todayRows), totalTokens: Number(todayRows.prompt_tokens ?? 0) + Number(todayRows.completion_tokens ?? 0) },
      total: { ...mk(totalRows), totalTokens: Number(totalRows.prompt_tokens ?? 0) + Number(totalRows.completion_tokens ?? 0) },
      byStage: Object.fromEntries(stageRows.map((r) => [r.stage, mk(r)])),
      byModel: modelRows.map((r) => ({
        provider: r.provider,
        model: r.model,
        calls: Number(r.calls ?? 0),
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
        totalTokens: Number(r.prompt_tokens ?? 0) + Number(r.completion_tokens ?? 0),
      })),
      recent: recent.map((r) => ({
        id: Number(r.id),
        at: Number(r.at),
        stage: r.stage,
        provider: r.provider,
        model: r.model,
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
      })),
    };
  }

  /** 清理 30 天前的消耗记录（防表无限膨胀），返回删除数 */
  purgeOldUsage(now = Date.now()): number {
    const r = this.ensureOpen()
      .prepare("DELETE FROM extraction_usage WHERE at < ?")
      .run(now - 30 * 24 * 60 * 60 * 1000);
    return Number(r.changes);
  }

  // ── 节点 CRUD ─────────────────────────────────────────

  addNode(node: MemoryNode): void {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT OR REPLACE INTO viking_nodes
        (id, path, category, l0, l1, l2, priority, tags, parent_dir,
         created_at, last_accessed_at, access_count, expires_at, source, thread_id, metadata, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      node.id, node.path, node.category, node.l0, node.l1, node.l2, node.priority,
      JSON.stringify(node.tags ?? []), node.parentDir,
      node.createdAt, node.lastAccessedAt, node.accessCount, node.expiresAt,
      node.source, node.threadId ?? null,
      node.metadata ? JSON.stringify(node.metadata) : null,
      normalizeWorkspaceKey(node.workspaceId ?? null),
    );
  }

  getNode(id: string): MemoryNode | null {
    const row = this.ensureOpen()
      .prepare("SELECT * FROM viking_nodes WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToNode(row) : null;
  }

  updateNode(id: string, patch: Partial<MemoryNode>): void {
    const db = this.ensureOpen();
    const current = this.getNode(id);
    if (!current) return;
    const merged: MemoryNode = { ...current, ...patch, id };
    db.prepare(
      `UPDATE viking_nodes SET
        l0=?, l1=?, l2=?, priority=?, tags=?, parent_dir=?,
        last_accessed_at=?, access_count=?, expires_at=?, source=?, thread_id=?, metadata=?, workspace_id=?
       WHERE id=?`
    ).run(
      merged.l0, merged.l1, merged.l2, merged.priority, JSON.stringify(merged.tags ?? []),
      merged.parentDir, merged.lastAccessedAt, merged.accessCount, merged.expiresAt,
      merged.source, merged.threadId ?? null,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      merged.workspaceId ?? null, id,
    );
  }

  removeNode(id: string): boolean {
    const r = this.ensureOpen()
      .prepare("DELETE FROM viking_nodes WHERE id = ?")
      .run(id);
    return Number(r.changes) > 0;
  }

  removeNodes(ids: string[]): number {
    if (ids.length === 0) return 0;
    const db = this.ensureOpen();
    const stmt = db.prepare("DELETE FROM viking_nodes WHERE id = ?");
    let n = 0;
    for (const id of ids) n += Number(stmt.run(id).changes);
    return n;
  }

  /** 全量节点（可选按 workspace / category 过滤） */
  getAllNodes(workspaceId?: string | null, category?: MemoryCategory): MemoryNode[] {
    const db = this.ensureOpen();
    const conditions: string[] = [];
    const params: Array<string | null> = [];
    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }
    if (workspaceId !== undefined) {
      if (workspaceId === null) {
        conditions.push("workspace_id IS NULL");
      } else {
        // workspace 路径大小写/分隔符归一化后匹配（与写入侧 normalizeWorkspaceKey 一致）
        conditions.push("lower(replace(workspace_id, '\\', '/')) = ?");
        params.push(normalizeWorkspaceKey(workspaceId));
      }
    }
    const sql =
      `SELECT * FROM viking_nodes` +
      (conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "") +
      ` ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToNode);
  }

  /** 按父目录（memories/skills/resources）列出 */
  getNodesByDir(parentDir: string, workspaceId?: string | null): MemoryNode[] {
    const db = this.ensureOpen();
    const conditions = ["parent_dir = ?"];
    const params: Array<string | null> = [parentDir];
    if (workspaceId === null) {
      conditions.push("workspace_id IS NULL");
    } else if (workspaceId !== undefined) {
      conditions.push("lower(replace(workspace_id, '\\', '/')) = ?");
      params.push(normalizeWorkspaceKey(workspaceId));
    }
    const rows = db
      .prepare(`SELECT * FROM viking_nodes WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToNode);
  }

  // ── 生命周期（过期清理） ──────────────────────────────

  /** 删除所有已过期节点，返回删除数 */
  purgeExpired(now = Date.now()): number {
    const r = this.ensureOpen()
      .prepare("DELETE FROM viking_nodes WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now);
    return Number(r.changes);
  }

  // ── Embedding 存储（可选增强） ────────────────────────

  setEmbedding(nodeId: string, embedding: number[]): void {
    this.ensureOpen()
      .prepare("INSERT OR REPLACE INTO viking_embeddings (node_id, embedding) VALUES (?, ?)")
      .run(nodeId, JSON.stringify(embedding));
  }

  getEmbedding(nodeId: string): number[] | null {
    const row = this.ensureOpen()
      .prepare("SELECT embedding FROM viking_embeddings WHERE node_id = ?")
      .get(nodeId) as { embedding?: string } | undefined;
    if (!row?.embedding) return null;
    try {
      const v = JSON.parse(row.embedding);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  getAllEmbeddings(): Map<string, number[]> {
    const rows = this.ensureOpen()
      .prepare("SELECT node_id, embedding FROM viking_embeddings")
      .all() as Array<{ node_id: string; embedding: string }>;
    const map = new Map<string, number[]>();
    for (const row of rows) {
      try {
        const v = JSON.parse(row.embedding);
        if (Array.isArray(v)) map.set(row.node_id, v);
      } catch {
        /* 损坏行跳过 */
      }
    }
    return map;
  }

  // ── 统计 ──────────────────────────────────────────────

  getStats(): {
    total: number;
    memories: number;
    skills: number;
    resources: number;
    profiles: number;
    byPriority: Record<string, number>;
    expiringSoon: number;
  } {
    const db = this.ensureOpen();
    const total = Number((db.prepare("SELECT COUNT(*) c FROM viking_nodes").get() as { c: number }).c);
    const byCat = db.prepare("SELECT category, COUNT(*) c FROM viking_nodes GROUP BY category").all() as Array<{ category: string; c: number }>;
    const byPrio = db.prepare("SELECT priority, COUNT(*) c FROM viking_nodes GROUP BY priority").all() as Array<{ priority: string; c: number }>;
    const expiring = Number(
      (db.prepare("SELECT COUNT(*) c FROM viking_nodes WHERE expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?")
        .get(Date.now() + 24 * 60 * 60 * 1000, Date.now()) as { c: number }).c
    );
    const cat = { memories: 0, skills: 0, resources: 0, profiles: 0 };
    for (const row of byCat) cat[row.category as keyof typeof cat] = Number(row.c);
    const prio: Record<string, number> = { P0: 0, P1: 0, P2: 0 };
    for (const row of byPrio) prio[row.priority] = Number(row.c);
    return { total, ...cat, byPriority: prio, expiringSoon: expiring };
  }
}
