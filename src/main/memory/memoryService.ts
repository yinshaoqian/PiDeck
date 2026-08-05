/**
 * Viking 记忆系统 —— 核心服务
 *
 * 完整复刻 Breezell viking 语义：
 *  - 节点模型：L0/L1/L2 三级、memory/skill/resource 三类、P0(手动钉)/P1/P2(带过期)
 *  - 检索打分：L0(+2)/tags(+3)/L1(+1)/锚点与 metadata(+3)，P0×1.5、P1×1.2，
 *    60 天时间衰减（lastAccessedAt 与 createdAt 取较强者）
 *  - L0 索引：P0>P1>P2 按预算填充，代码修改单独列为 recent code changes
 *  - 生命周期：24h 周期清理过期 + 同 workspace+category+标题去重（保留最强）
 */
import type { Event } from "electron";
import { EventEmitter } from "node:events";import {
  MemoryCategory,
  MemoryCreateInput,
  MemoryL0Compact,
  MemoryNode,
  MemoryPriority,
  MemorySearchResult,
  MemoryStats,
} from "../../shared/types";
import { VikingDb } from "./vikingDb";
import { EmbeddingService } from "./embeddingService";
const P1_TTL_MS = 90 * 24 * 60 * 60 * 1000; // P1 默认 90 天（与 viking P1 同级，可保留中长期记忆）
const P2_TTL_MS = 7 * 24 * 60 * 60 * 1000; // P2 默认 7 天（短期会话上下文）

function priorityExpiresAt(priority: MemoryPriority, now = Date.now()): number | null {
  switch (priority) {
    case "P0":
      return null;
    case "P1":
      return now + P1_TTL_MS;
    case "P2":
      return now + P2_TTL_MS;
  }
}

const DIR_OF: Record<MemoryCategory, string> = {
  memory: "memories",
  skill: "skills",
  resource: "resources",
};

export function categoryOfDir(dir: string): MemoryCategory | null {
  if (dir === "memories") return "memory";
  if (dir === "skills") return "skill";
  if (dir === "resources") return "resource";
  return null;
}

/** 简单分词：英文按空白切分，中日韩文按 Intl.Segmenter 切词（含 2-gram 兜底） */
function tokenize(text: string): string[] {
  const s = text.toLowerCase();
  const words = s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const cjk = s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  const segs: string[] = [];
  for (const chunk of cjk) {
    try {
      const seg = new Intl.Segmenter("zh", { granularity: "word" });
      for (const part of seg.segment(chunk)) {
        if (part.isWordLike && part.segment.length > 1) segs.push(part.segment);
      }
    } catch {
      /* 无 Intl.Segmenter 时回退 2-gram */
    }
  }
  return [...words, ...segs];
}

/**
 * 检索停用词：纯语法虚词/指示代词/泛化高频词（为什么/这个/可以…）与优先级标记（p1/p2…）。
 * 这类词在几乎每条记忆里都出现，会稀释语义分数（实测 155 token 长 query 下
 * "p1""ai" 命中全部 P1 记忆把分数堆到 241）。领域词（如"记忆""注入""修复"）
 * 不在此表——它们由 IDF 加权自动降权，这里只处理纯噪声。
 */
const STOP_WORDS = new Set([
  // 中文语法词/指示代词
  "为什么", "什么", "怎么", "怎样", "如何", "这个", "这些", "那个", "那些", "一下", "请问", "可以",
  "需要", "是否", "然后", "现在", "刚才", "之前", "之后", "我们", "你们", "他们", "自己",
  "应该", "一个", "一种", "进行", "来说", "就是", "还是", "但是", "因为", "所以", "如果",
  "比较", "大概", "感觉", "觉得", "知道", "看看", "这种", "那种", "还有", "不是", "没有",
  // 英文泛化词
  "ai", "the", "and", "for", "are", "was", "were", "with", "that", "this", "from", "you",
  "your", "have", "has", "not", "but", "can", "will", "p0", "p1", "p2", "p3", "app",
  "dev", "issue", "fix", "doc", "docs", "web", "src", "type", "ui", "api", "get", "set",
]);

/** 过滤停用词后的 token 序列 */
function cleanTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOP_WORDS.has(t));
}

/** 节点有效日期：metadata.updatedAt 优先，否则 createdAt */
function effectiveAtOf(node: MemoryNode): number {
  const m = node.metadata as { updatedAt?: number } | undefined;
  return typeof m?.updatedAt === "number" && m.updatedAt > 0 ? m.updatedAt : node.createdAt;
}

/** 节点检索文本：l0 + l1 + tags，用于 IDF 文档频率统计（tags 用原文匹配） */
function nodeSearchText(node: MemoryNode): string {
  return `${node.l0}\n${node.l1}\n${node.tags.join(" ")}`;
}

/** 归一化标题（去空白小写），用于重复检测 */
function titleKey(node: MemoryNode): string {
  return node.l0.toLowerCase().replace(/\s+/g, "");
}

export class MemoryService {
  readonly onDidChange: (listener: () => void) => { dispose(): void };
  private readonly emitter = new EventEmitter();
  /** 存储层（embeddingService 复用同一实例读写向量表） */
  readonly db: VikingDb;
  /** 语义检索服务（可选注入）：未注入或模型不可用时自动降级纯关键词 */
  semantic: EmbeddingService | null = null;

  constructor(dbPath: string) {
    this.db = new VikingDb(dbPath);
    this.onDidChange = (listener) => {
      this.emitter.on("change", listener);
      return { dispose: () => this.emitter.off("change", listener) };
    };
    // 启动即跑一次生命周期：清过期 + 去重
    void this.runLifecycle();
  }

  private emitChange() {
    this.emitter.emit("change");
  }

  // ── 已提取会话标记（低频轮询去重：每会话只提取一次） ──

  /** 标记会话已自动提取（避免下轮重复扫描/重复调用 LLM） */
  markSessionExtracted(sessionId: string): void {
    this.db.markSessionExtracted(sessionId);
  }

  /** 会话是否已被自动提取过 */
  isSessionExtracted(sessionId: string): boolean {
    return this.db.isSessionExtracted(sessionId);
  }

  // ── 节点生成 ──────────────────────────────────────────

  private newId(): string {
    return `vk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /** 构建完整节点：id/path/父目录/时间戳/过期时间 */
  private buildNode(input: {
    l0: string;
    l1?: string;
    l2?: string;
    priority?: MemoryPriority;
    category?: MemoryCategory;
    tags?: string[];
    source: MemoryNode["source"];
    threadId?: string;
    metadata?: MemoryNode["metadata"];
    workspaceId: string | null;
  }): MemoryNode {
    const category = input.category ?? "memory";
    const priority = input.priority ?? "P1";
    const id = this.newId();
    const now = Date.now();
    const dir = DIR_OF[category];
    return {
      id,
      path: `${dir}/${id}`,
      category,
      l0: input.l0.trim(),
      l1: (input.l1 ?? "").trim() || input.l0.trim(),
      l2: (input.l2 ?? "").trim() || (input.l1 ?? "").trim() || input.l0.trim(),
      priority,
      tags: input.tags ?? [],
      parentDir: dir,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      expiresAt: priorityExpiresAt(priority, now),
      source: input.source,
      threadId: input.threadId,
      metadata: input.metadata,
      workspaceId: input.workspaceId,
    };
  }

  // ── 公共 API ──────────────────────────────────────────

  async addNode(input: Omit<Parameters<MemoryService["buildNode"]>[0], "source"> & {
    source?: MemoryNode["source"];
  }): Promise<MemoryNode> {
    const node = this.buildNode({ ...input, source: input.source ?? "user" });
    this.db.addNode(node);
    this.invalidateDfCache();
    this.emitChange();
    // 新节点异步补向量：语义检索已就绪时让新记忆立即可被语义召回（幂等，preload 也会跳过已存在的）
    const sem = this.semantic;
    if (sem?.isReady) {
      void sem
        .embed(`${node.l0}\n${node.l1 ?? ""}`)
        .then((vec) => {
          if (vec) this.db.setEmbedding(node.id, vec);
        })
        .catch(() => {
          /* 补向量失败不影响主流程，下次启动 preload 会再补 */
        });
    }
    return node;
  }

  getNode(id: string): MemoryNode | null {
    return this.db.getNode(id);
  }

  updateNode(id: string, patch: Partial<MemoryNode>): boolean {
    const current = this.db.getNode(id);
    if (!current) return false;
    const next: Partial<MemoryNode> = { ...patch };
    // 优先级变化时重算过期时间；P0 永久
    if (patch.priority && patch.priority !== current.priority) {
      next.expiresAt = priorityExpiresAt(patch.priority);
    }
    this.db.updateNode(id, next);
    this.invalidateDfCache();
    this.emitChange();
    return true;
  }

  removeNode(id: string): boolean {
    const ok = this.db.removeNode(id);
    if (ok) {
      this.invalidateDfCache();
      this.emitChange();
    }
    return ok;
  }

  list(scope: "all" | "global" | "workspace", workspaceId: string | null, category?: MemoryCategory): MemoryNode[] {
    const ws = scope === "all" ? undefined : scope === "global" ? null : workspaceId;
    return this.db.getAllNodes(ws, category);
  }

  /** 手动新增（面板入口） */
  async createFromInput(input: MemoryCreateInput, currentWorkspace: string | null): Promise<MemoryNode> {
    return this.addNode({
      l0: input.l0,
      l1: input.l1,
      l2: input.l2,
      priority: input.priority ?? "P1",
      category: input.category ?? "memory",
      tags: input.tags ?? [],
      metadata: input.retrievalAnchor ? { retrievalAnchor: input.retrievalAnchor } : undefined,
      workspaceId: input.workspaceId !== undefined ? input.workspaceId : currentWorkspace,
      source: "user",
    });
  }

  /** 钉住/取消钉住（P0 永久） */
  pin(id: string, pinned: boolean): boolean {
    return this.updateNode(id, pinned ? { priority: "P0" } : { priority: "P1" });
  }

  // ── IDF 文档频率缓存（token → 出现节点数） ────────────────

  /**
   * IDF 加权需要知道每个 token 在多少条记忆里出现（文档频率 df）。
   * df 缓存按节点总数惰性重建：节点增删改时置 null，search 前若缺失则重建。
   * 量级 50 左右重建是毫秒级；增长后仍为 O(N×tokenize)，可控。
   */
  private dfCache: Map<string, number> | null = null;
  private dfNodeCount = 0;

  private ensureDfCache(): void {
    const all = this.db.getAllNodes();
    if (this.dfCache !== null && this.dfNodeCount === all.length) return;
    const df = new Map<string, number>();
    for (const node of all) {
      const toks = new Set(cleanTokens(nodeSearchText(node)));
      for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.dfCache = df;
    this.dfNodeCount = all.length;
  }

  /** 节点增删改都会改变文档频率，缓存失效在下一轮 search 自动重建 */
  private invalidateDfCache(): void {
    this.dfCache = null;
  }

  /** 记录记忆被检索命中：刷新访问时间与热度，让时间衰减真实生效 */
  recordAccess(id: string): void {
    const node = this.db.getNode(id);
    if (!node) return;
    this.db.updateNode(id, {
      lastAccessedAt: Date.now(),
      accessCount: node.accessCount + 1,
      expiresAt: node.priority === "P0" ? null : priorityExpiresAt(node.priority, Date.now()),
    });
  }

  getStats(workspaceId: string | null): MemoryStats {
    const s = this.db.getStats();
    const all = this.db.getAllNodes();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // 新鲜度分布：按有效日期（updatedAt 优先）
    let last24h = 0, last7d = 0, last30d = 0, older = 0;
    for (const n of all) {
      const age = now - effectiveAtOf(n);
      if (age <= day) last24h++;
      else if (age <= 7 * day) last7d++;
      else if (age <= 30 * day) last30d++;
      else older++;
    }

    // 轨迹 / 经验计数
    const trajectories = all.filter((n) => n.metadata?.kind === "trajectory").length;
    const experience = all.filter((n) => n.metadata?.kind === "experience").length;

    // 访问频率 Top 5
    const accessTop = [...all]
      .sort((a, b) => b.accessCount - a.accessCount || b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, 5)
      .map((n) => ({ id: n.id, l0: n.l0, accessCount: n.accessCount, expiresAt: n.expiresAt }));

    // 即将过期明细：未过期且 7 天内到期（P0 无过期）
    const expiringSoonList = all
      .filter((n) => n.expiresAt != null && n.expiresAt > now && n.expiresAt - now <= 7 * day)
      .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
      .slice(0, 5)
      .map((n) => ({ id: n.id, l0: n.l0, priority: n.priority, expiresAt: n.expiresAt }));

    return {
      total: s.total,
      memories: s.memories,
      skills: s.skills,
      resources: s.resources,
      byPriority: s.byPriority,
      expiringSoon: s.expiringSoon,
      dbPath: (this.db as unknown as { dbPath: string }).dbPath,
      byFreshness: { last24h, last7d, last30d, older },
      experience,
      trajectories,
      accessTop,
      expiringSoonList,
    };
  }

  // ── 检索（Viking 打分） ───────────────────────────────

  /**
   * 关键词检索：对候选节点打分排序。
   * 打分规则（复刻 vikingRetriever.B）：
   *  - metadata/锚点命中 +3，tags 命中 +3，l0 命中 +2，l1 命中 +1
   *  - P0 ×1.5、P1 ×1.2
   *  - 时间衰减：距最近访问/有效日期越久分数越低，60 天半衰、下限 0.5
   */
  /**
   * 关键词检索：对候选节点打分排序。
   * 打分规则（IDF 加权 BM25 风格，替代原始累加）：
   *  - 命中层：anchor/metadata +3、tags +3、l0 +2、l1 +1
   *  - 每个命中 token 乘 IDF 权重：log((N+1)/(df+0.5))——出现文档越多的词权重越低，
   *    根治长 query 下高频 token（p1/ai/修复）命中全部记忆把分数堆爆的问题
   *  - 覆盖率归一化：score × 命中token数/querytoken数，让 minScore 阈值跨 query 一致
   *  - P0 ×1.5、P1 ×1.2；时间衰减（最近访问/有效日期，60 天半衰、下限 0.5）
   * 副作用：命中 topK 的记忆会 recordAccess（反馈回路——时间衰减的"最近访问"信号
   * 从此真实变化，热记忆自然浮上来）。
   */
  search(query: string, opts: {
    scope?: "all" | "global" | "workspace";
    workspaceId?: string | null;
    category?: MemoryCategory;
    topK?: number;
    level?: "l0" | "l1" | "l2";
  } = {}): MemorySearchResult[] {
    const ws = opts.scope === "global" ? null : opts.scope === "workspace" ? (opts.workspaceId ?? null) : undefined;
    const nodes = this.db.getAllNodes(ws, opts.category);
    const tokens = cleanTokens(query);
    if (tokens.length === 0) return [];
    this.ensureDfCache();
    const N = this.dfNodeCount || tokens.length;
    const df = this.dfCache!;

    const results: MemorySearchResult[] = [];
    for (const node of nodes) {
      const scored = this.scoreNode(node, tokens, N, df);
      if (scored.score > 0) {
        results.push({
          node: this.clipLevel(node, opts.level ?? "l1"),
          score: scored.score,
          source: "local",
          hitTerms: scored.hitTerms,
        });
      }
    }
    // 语义增强（两段式）：
    // ① 对已命中的候选加余弦 bonus（提升排序，cosine > 0.35 起加）
    // ② 对 BM25 零命中的节点做语义补召回（cosine > 0.45 才进）——解决同义/改述表达
    //    关键词完全打不中的问题（如"页面加载很慢" vs 记忆里的"卡 20 秒"）。
    //    阈值宁高勿低：0.45 是 MiniLM 中文短文本的强相关线，避免引入噪声。
    if (this.semantic?.isReady) {
      const qv = this.semantic.getQueryVectorSync(query);
      if (qv) {
        for (const r of results) {
          const nv = this.semantic.getNodeVector(r.node.id);
          if (!nv) continue;
          const cos = EmbeddingService.cosine(qv, nv);
          if (cos > 0.35) r.score += (cos - 0.35) * 2;
        }
        const hitIds = new Set(results.map((r) => r.node.id));
        for (const node of nodes) {
          if (hitIds.has(node.id)) continue;
          const nv = this.semantic.getNodeVector(node.id);
          if (!nv) continue;
          const cos = EmbeddingService.cosine(qv, nv);
          if (cos > 0.45) {
            results.push({
              node: this.clipLevel(node, opts.level ?? "l1"),
              // 修复 D：语义补召回分数改为 cos×10（0.45→4.5、0.6→6、0.8→8），
              // 与 BM25 常见 3~50 分同量级。旧公式 (cos−0.45)×5 上限仅 2.75，
              // 回归实测 46 个候选全被 BM25 挤出 top-3——语义对排序零贡献。
              score: cos * 10,
              source: "embedding",
              hitTerms: [],
            });
          }
        }
      }
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, opts.topK ?? 10);
    // 反馈回路：被检索命中的记忆记录访问（时间衰减/热记忆信号），命中本身 = 被使用
    for (const r of top) this.recordAccess(r.node.id);
    return top;
  }

  /**
   * 语义增强版检索（注入链路用）：先确保 query 向量就绪（首次等模型加载，之后 4ms），
   * 再走带语义增强的 search。模型缺失时 embed 返回 null，自动降级纯 BM25，不阻塞。
   */
  async searchSemantic(
    query: string,
    opts: {
      scope?: "all" | "global" | "workspace";
      workspaceId?: string | null;
      category?: MemoryCategory;
      topK?: number;
      level?: "l0" | "l1" | "l2";
    } = {},
  ): Promise<MemorySearchResult[]> {
    const sem = this.semantic;
    if (sem && !sem.isQueryCached(query)) {
      const qv = await sem.embed(query);
      if (qv) sem.cacheQueryVector(query, qv);
    }
    return this.search(query, opts);
  }

  private scoreNode(
    node: MemoryNode,
    tokens: string[],
    totalDocs: number,
    df: Map<string, number>,
  ): { score: number; hitTerms: string[] } {
    const l0 = node.l0.toLowerCase();
    const l1 = node.l1.toLowerCase();
    const tags = node.tags.map((t) => t.toLowerCase());
    const anchor = ((node.metadata as { retrievalAnchor?: string } | undefined)?.retrievalAnchor ?? "").toLowerCase();
    const metaText = node.metadata ? JSON.stringify(node.metadata).toLowerCase() : "";

    let score = 0;
    let matched = 0;
    const hitTerms: string[] = [];
    for (const tok of tokens) {
      // IDF：出现文档越多权重越低；log 里含 0.5 平滑避免 df=N 时出现负权重
      const idf = Math.log((totalDocs + 1) / ((df.get(tok) ?? 0) + 0.5));
      if (idf <= 0.01) continue; // 超高频词（几乎所有文档都有）直接跳过
      let hit = 0;
      if (anchor.includes(tok)) hit = 3;
      else if (metaText.includes(tok)) hit = 3;
      if (hit === 0 && tags.some((t) => t.includes(tok))) hit = 3;
      if (hit === 0 && l0.includes(tok)) hit = 2;
      else if (hit === 0 && l1.includes(tok)) hit = 1;
      if (hit > 0) {
        score += hit * idf;
        matched++;
        if (!hitTerms.includes(tok)) hitTerms.push(tok);
      }
    }
    if (matched === 0) return { score: 0, hitTerms: [] };

    // 覆盖率归一化：命中比例越高越好，防止长 query 靠少数词堆分
    score *= matched / tokens.length;

    if (node.priority === "P0") score *= 1.5;
    else if (node.priority === "P1") score *= 1.2;

    // 时间衰减：最近访问与有效日期，60 天衰减至 0.5
    const daysSinceAccess = (Date.now() - node.lastAccessedAt) / (24 * 60 * 60 * 1000);
    const accessFactor = Math.max(0.5, 1 - daysSinceAccess / 60);
    const daysSinceEffective = (Date.now() - effectiveAtOf(node)) / (24 * 60 * 60 * 1000);
    const effectiveFactor = Math.max(0.5, 1 - daysSinceEffective / 60);
    score *= Math.max(accessFactor, effectiveFactor);
    return { score, hitTerms };
  }

  /** 按检索层级裁剪：l0 只留摘要、l1 去掉 l2、l2 完整 */
  private clipLevel(node: MemoryNode, level: "l0" | "l1" | "l2"): MemoryNode {
    if (level === "l0") return { ...node, l1: "", l2: "" };
    if (level === "l1") return { ...node, l2: "" };
    return node;
  }

  // ── L0 索引（上下文注入） ─────────────────────────────

  /**
   * 生成 L0 摘要索引文本（仿 viking:// 索引）。
   * 预算内按 P0 > P1 > P2 填充；code-edit 类记忆单独列为 recent code changes。
   * memoryEntries 供 UI 展示「可召回条目」。
   */
  getL0Compact(workspaceId: string | null, budget = 3200, includeResources = true): MemoryL0Compact {
    const nodes = this.db.getAllNodes(workspaceId);
    if (nodes.length === 0) return { text: "", memoryEntries: [] };

    const lines: Array<{
      dir: string;
      priority: MemoryPriority;
      line: string;
      isCodeEdit: boolean;
      effectiveAt: number;
      path: string;
      l0: string;
    }> = [];

    for (const node of nodes) {
      const tags = node.tags.length > 0 ? ` ${node.tags.map((t) => `#${t}`).join(" ")}` : "";
      if (node.metadata?.kind === "trajectory") continue; // 轨迹不进入索引
      lines.push({
        dir: node.parentDir,
        priority: node.priority,
        line: `  [${node.priority}]${tags}: ${node.l0}`,
        isCodeEdit: node.tags.includes("code-edit"),
        effectiveAt: effectiveAtOf(node),
        path: node.path,
        l0: node.l0,
      });
    }

    const byDir: Record<string, Array<(typeof lines)[number]>> = { memories: [], skills: [], resources: [] };
    const codeEdits: Array<(typeof lines)[number]> = [];
    for (const l of lines) {
      if (l.isCodeEdit) codeEdits.push(l);
      byDir[l.dir]?.push(l);
    }

    // P0 全部、P1、P2 按预算填充
    const pick = (list: Array<(typeof lines)[number]>, remaining: number) => {
      const out: Array<(typeof lines)[number]> = [];
      const sorted = [...list].sort((a, b) => b.priority.localeCompare(a.priority) || b.effectiveAt - a.effectiveAt);
      const prioOrder: Record<MemoryPriority, number> = { P0: 0, P1: 1, P2: 2 };
      sorted.sort((a, b) => prioOrder[a.priority] - prioOrder[b.priority] || b.effectiveAt - a.effectiveAt);
      for (const item of sorted) {
        if (item.line.length + 1 > remaining) continue;
        out.push(item);
        remaining -= item.line.length + 1;
      }
      return out;
    };

    const dirs = includeResources ? ["memories", "skills", "resources"] : ["memories"];
    const parts: string[] = [];
    const memoryEntries: MemoryL0Compact["memoryEntries"] = [];

    for (const dir of dirs) {
      const total = byDir[dir].length;
      if (total === 0) continue;
      const picked = pick(byDir[dir], budget);
      const skipped = total - picked.length;
      if (dir === "resources") {
        const recent = codeEdits.slice(0, 5);
        const recentText = recent.length > 0
          ? `\n  Recent code changes:\n${recent.map((r) => r.line).join("\n")}${codeEdits.length > recent.length ? `\n  ... +${codeEdits.length - recent.length} older edits` : ""}`
          : "";
        parts.push(`viking://resources/ (${total} total)${recentText}`);
      } else {
        const body = picked.length > 0 ? `\n${picked.map((p) => p.line).join("\n")}` : "";
        const more = skipped > 0 ? `\n  ... +${skipped} more (use memories_recall for details)` : "";
        parts.push(`viking://${dir}/ (${total})${body}${more}`);
        if (dir === "memories") {
          for (const p of picked) memoryEntries.push({ id: p.path.slice(p.path.lastIndexOf("/") + 1), l0: p.l0, priority: p.priority, effectiveAt: p.effectiveAt });
        }
      }
    }

    return { text: parts.join("\n\n"), memoryEntries };
  }

  // ── 生命周期 ──────────────────────────────────────────

  /**
   * 清理：① 过期节点删除；② 同 workspace+category+标题去重（保留最强）。
   * 排序规则：source user>tool>conversation>auto，priority P0>P1>P2，
   * l2 长度长优先，accessCount 高优先，updatedAt 新优先。
   */
  runLifecycle(): { purged: number; duplicatesRemoved: number } {
    const purged = this.db.purgeExpired();
    const all = this.db.getAllNodes();
    const dupTargets = new Set<string>();

    // 按 workspace + category + 归一化标题分组
    const groups = new Map<string, MemoryNode[]>();
    for (const node of all) {
      if (node.category !== "memory" && node.category !== "skill") continue;
      const key = `${node.workspaceId ?? ""}\0${node.category}\0${titleKey(node)}`;
      const list = groups.get(key);
      if (list) list.push(node);
      else groups.set(key, [node]);
    }

    const sourceRank = (s: MemoryNode["source"]) => (s === "user" ? 0 : s === "tool" ? 1 : s === "conversation" ? 2 : 3);
    const prioRank = (p: MemoryPriority) => (p === "P0" ? 0 : p === "P1" ? 1 : 2);

    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => {
        const bySource = sourceRank(a.source) - sourceRank(b.source);
        if (bySource !== 0) return bySource;
        const byPrio = prioRank(a.priority) - prioRank(b.priority);
        if (byPrio !== 0) return byPrio;
        const byLen = (b.l2?.length ?? 0) - (a.l2?.length ?? 0);
        if (byLen !== 0) return byLen;
        const byAccess = (b.accessCount ?? 0) - (a.accessCount ?? 0);
        if (byAccess !== 0) return byAccess;
        return effectiveAtOf(b) - effectiveAtOf(a);
      });
      // 保留第一条（最强），其余标记删除
      for (let i = 1; i < list.length; i++) dupTargets.add(list[i].id);
    }

    let duplicatesRemoved = 0;
    if (dupTargets.size > 0) {
      duplicatesRemoved = this.db.removeNodes([...dupTargets]);
    }
    if (purged > 0 || duplicatesRemoved > 0) this.emitChange();
    return { purged, duplicatesRemoved };
  }
}
