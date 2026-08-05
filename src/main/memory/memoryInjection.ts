/**
 * 触发式记忆注入 —— 用户消息进入 pi 前的记忆召回层
 *
 * 为什么放在主进程而不是依赖 LLM 自觉调用检索工具：
 * LLM 无法可靠判断"自己缺什么记忆"（未知的未知），自觉召回注定低效；
 * 由主进程在每次 prompt 前例行检索并注入 top-K 命中，把"要不要召回"从
 * LLM 的判断题变成宿主进程的例行程序（对应记忆库反馈：别靠提示词保证调工具，
 * 用主进程硬保证）。
 *
 * 注入方式：返回的文本作为宿主指令（[PIDECK_HOST_INSTRUCTION]）的一部分，
 * 展示层会剥离宿主指令只保留用户原文，pi 完整接收。
 *
 * 召回策略：
 *  - 检索 query = 当前消息 + 会话最近几条消息（解决"继续""然后呢"这类短消息
 *    单独检索召回率低的问题）
 *  - 阈值过滤：低于 minScore 的弱命中不注入（宁缺毋滥，避免无关记忆稀释注意力）
 *  - 短期去重：同一记忆在窗口期内不重复注入，避免连续几轮重复塞同一条
 */
import { MemoryService } from "./memoryService";
import type { MemoryInjectionEntry, MemoryPriority } from "../../shared/types";

export const MEMORY_INJECTION_MARKER = "记忆上下文 · 触发式注入";

/** 同一记忆的重复注入窗口：15 分钟内不重复注入同一条 */
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

/** 模块级短期去重表：记忆 id → 最近注入时间戳 */
const recentlyInjected = new Map<string, number>();

/** 相对时间描述（用于记忆的时间标注，避免暴露绝对时间戳给模型） */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  if (diff < 365 * 86_400_000) return `${Math.floor(diff / (30 * 86_400_000))} 个月前`;
  return `${Math.floor(diff / (365 * 86_400_000))} 年前`;
}

/** 记忆有效日期：metadata.updatedAt 优先，否则 createdAt（与 memoryService 一致） */
function effectiveAtOf(node: { createdAt: number; metadata?: { updatedAt?: number } | null }): number {
  const m = node.metadata as { updatedAt?: number } | undefined;
  return typeof m?.updatedAt === "number" && m.updatedAt > 0 ? m.updatedAt : node.createdAt;
}

/** 单条记忆的紧凑格式：优先级 + 摘要 + 时间标注；l1 与 l0 不同且有意义时附上要点 */
function formatEntry(node: {
  priority: MemoryPriority;
  l0: string;
  l1: string;
  createdAt: number;
  metadata?: { updatedAt?: number; kind?: string; causal?: Record<string, string | undefined> } | null;
}): string {
  // causal-case（Breezell entanglement 风格）：按“症状 → 根因 → 修复”格式化，
  // 让未来的 AI 遇到相同症状时能直接看到定位结论和验证过的修法，而不是只看标题。
  const causal = node.metadata?.kind === "causal-case" ? node.metadata.causal : undefined;
  if (causal && (causal.symptom || causal.rootCause || causal.fix)) {
    const symptom = causal.symptom ?? node.l0;
    const rootCause = causal.rootCause;
    const fix = causal.fix;
    const parts = [
      rootCause ? `根因: ${rootCause.length > 60 ? `${rootCause.slice(0, 60)}…` : rootCause}` : undefined,
      fix ? `修复: ${fix.length > 40 ? `${fix.slice(0, 40)}…` : fix}` : undefined,
    ].filter(Boolean).join("；");
    return `- [${node.priority}] 症状: ${symptom}${parts ? ` — ${parts}` : ""}（${relativeTime(effectiveAtOf(node))}）`;
  }
  const l1 = node.l1?.trim();
  // l1 可能自带列表前缀（如 "- 用户偏好：…"），去掉避免与注入分隔符形成双破折号
  const l1Clean = l1 ? l1.replace(/^[-—]\s+/, "") : "";
  const detail = l1Clean && l1Clean !== node.l0 ? ` — ${l1Clean.length > 60 ? `${l1Clean.slice(0, 60)}…` : l1Clean}` : "";
  return `- [${node.priority}] ${node.l0}${detail}（${relativeTime(effectiveAtOf(node))}）`;
}

/** 提取 causal-case 结构（供结构化 entries 与格式化共用，避免两处各自解析） */
function extractCausal(node: {
  metadata?: { kind?: string; causal?: Record<string, string | undefined> } | null;
}): { symptom?: string; rootCause?: string; fix?: string } | undefined {
  const causal = node.metadata?.kind === "causal-case" ? node.metadata.causal : undefined;
  if (!causal || (!causal.symptom && !causal.rootCause && !causal.fix)) return undefined;
  return {
    symptom: causal.symptom ?? undefined,
    rootCause: causal.rootCause ?? undefined,
    fix: causal.fix ?? undefined,
  };
}

/**
 * 构建触发式记忆注入块（async：内部走语义增强检索，首次调用等模型加载 ~1s，之后毫秒级）。
 * @param queryTexts 检索 query 文本集合（当前消息 + 会话最近消息）
 * @param topK 单次注入条数上限
 * @param minScore 命中阈值：低于该分的弱命中不注入
 * @returns { block, count, entries }：block 为注入块文本（无命中或记忆库为空时为空串），
 *   count 为实际注入条数，entries 为结构化条目（供 UI 弹窗展示“注入了什么”）。
 */
export async function buildMemoryInjection(opts: {
  memory: MemoryService;
  workspaceId: string | null;
  queryTexts: string[];
  topK?: number;
  minScore?: number;
}): Promise<{ block: string; count: number; entries: MemoryInjectionEntry[] }> {
  // 修复 B：minScore 由 2 降至 0.5。新版打分是 IDF×覆盖率，单词命中（覆盖率 1/10）
  // 只有 ~0.4 分，旧阈值 2 会把所有弱命中误杀（实测「面板」命中 0.42 分 < 2 不注入）。
  // 阈值语义从"强命中才注入"改为"最低保障线"，宁滥勿缺交给语义排序兜底。
  const { memory, workspaceId, topK = 3, minScore = 0.5 } = opts;

  // 合并 query 文本：去空、去重、总长限制（防止超长会话文本拖慢检索）
  const texts = [...new Set(
    (opts.queryTexts ?? [])
      .map((s) => (s ?? "").trim())
      .filter((s) => s.length > 0),
  )];
  const query = texts.join("\n").slice(0, 4000);
  if (!query) return { block: "", count: 0, entries: [] };

  const results = await memory.searchSemantic(query, {
    scope: "workspace",
    workspaceId,
    topK: topK * 3, // 多取候选，去重后仍能保证 topK 条
    level: "l1",
  });
  if (results.length === 0) return { block: "", count: 0, entries: [] };

  const now = Date.now();
  const lines: string[] = [];
  const entries: MemoryInjectionEntry[] = [];
  for (const { node, score, hitTerms } of results) {
    if (score < minScore) continue;
    // 短期去重：窗口期内注入过的记忆跳过，避免同一话题连续几轮重复塞同一条
    const last = recentlyInjected.get(node.id);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) continue;
    lines.push(formatEntry(node));
    // 结构化条目与注入文本同源生成，UI 弹窗直接展示，不再二次检索
    entries.push({
      id: node.id,
      priority: node.priority,
      l0: node.l0,
      l1: node.l1?.trim() || undefined,
      timeLabel: relativeTime(effectiveAtOf(node)),
      causal: extractCausal(node),
      hitTerms: hitTerms && hitTerms.length > 0 ? hitTerms : undefined,
    });
    recentlyInjected.set(node.id, now);
    if (lines.length >= topK) break;
  }
  if (lines.length === 0) return { block: "", count: 0, entries: [] };

  return {
    block: [
      `[${MEMORY_INJECTION_MARKER}]`,
      "以下历史记忆与本次对话相关（来自 PiDeck 跨会话记忆库，可能已过期，仅作背景参考；如与当前代码/信息冲突，以当前实际为准）：",
      ...lines,
    ].join("\n"),
    count: lines.length,
    entries,
  };
}
