/**
 * 任务锚强制校验守卫（Task Anchor Guard）
 *
 * 背景：任务锚更新完全依赖 agent 自觉调用 task_anchor 工具（软约束）。
 * 实测发现 agent 会话结束时可能一次都不调用——宿主指令注入了维护规则但 agent 不执行，
 * 任务锚列表因此永远是空的，用户无从追踪「这个会话到底在做什么任务」。
 *
 * 本模块提供「强校验」：agent 正常结束（agent_settled）时由主进程兜底——
 *   1. 扫描本轮对话最近的 user 消息，检测任务型请求（修复/实现/调研/排查…）；
 *   2. 若任务锚中没有任何对应登记 → 强制补登记（doing，绑定当前会话）+ 强提示（toast）；
 *   3. 已有 doing 任务 → 照旧自动推进 review（原 onAgentSettled 逻辑，保留）。
 *
 * 这是「机制性强制」而非「提示性建议」：不依赖 agent 是否执行工具调用，
 * 主进程在会话稳定点直接校验并落盘，杜绝「任务被漏登记」的漏洞。
 *
 * @packageDocumentation
 */
import type { TaskAnchorItem, TaskAnchorStatus } from "../../shared/types";

/** 任务型请求动词（强信号）：命中即视为用户提出了需跨轮跟踪的任务 */
const TASK_VERBS: ReadonlyArray<string> = [
	"修复", "修好", "修一下", "修一修", "解决", "实现", "开发", "重构", "优化",
	"新增", "接入", "集成", "升级", "改造", "排查", "调查", "调研", "处理",
	"调试", "迁移", "移植", "编写", "设计", "完善", "调整", "补上", "搞定",
	"搭建", "部署", "对接", "适配", "添加", "移除", "落实", "跟进", "收口",
];

/** 排除模式：以这些词开头的消息是回顾/问答型，不算任务请求 */
const NON_TASK_PREFIX: ReadonlyArray<RegExp> = [
	/^回顾/, /^总结/, /^解释/, /^介绍一下/, /^什么是/, /^对比/, /^闲聊/,
	/^刚才/,
];

/** 宿主指令包裹体：自动登记时需剔除，避免把注入指令登记成任务 */
const HOST_INSTRUCTION_MARKER = "PIDECK_HOST_INSTRUCTION";

/**
 * 检测一条用户消息是否为任务型请求。
 * 规则（宁多勿漏——漏登记是漏洞，多登记可让用户自行删除）：
 *   - 长度 < 6 字视为短句闲聊，不算；
 *   - 以回顾/总结/解释/介绍等开头视为问答型，不算；
 *   - 命中任务动词（修复/实现/排查…）即算任务。
 */
export function detectTaskIntent(text: string): boolean {
	const t = (text ?? "").trim();
	if (t.length < 6) return false;
	if (NON_TASK_PREFIX.some((re) => re.test(t))) return false;
	return TASK_VERBS.some((verb) => t.includes(verb));
}

/** 从 user 消息文本提取可登记的任务摘要（去掉宿主指令体，截断到 60 字） */
export function summarizeTaskText(text: string): string {
	let t = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.includes(HOST_INSTRUCTION_MARKER) && !l.startsWith("【") && !l.startsWith("[/"))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (t.length > 60) t = `${t.slice(0, 60)}…`;
	return t || "(用户消息)";
}

/**
 * 对话增强：根据当前任务锚状态生成引导段（注入宿主指令，让 agent 引导用户确认任务 + 纠回偏离）。
 * 三部分：
 *  ① 确认意图：用户消息含确认/完成类词 + 有待确认(review)/进行中(doing)任务 → 引导 agent 标记完成
 *  ② 进行中引导：有 doing 任务 → agent 回复结尾引导用户确认任务推进
 *  ③ 任务纠回：当前消息与 doing 任务相关性低（非短句、非确认）→ 提示 agent 提醒用户任务未完成/需登记新任务
 */
export function buildAnchorGuidance(message: string, tasks: TaskAnchorItem[]): string[] {
  const t = (message ?? "").trim();
  const guidance: string[] = [];
  const doing = tasks.filter((x) => x.status === "doing");
  const review = tasks.filter((x) => x.status === "review");
  if (doing.length === 0 && review.length === 0) return guidance;
  // 短句（继续/然后呢/好的）不做纠回，避免误报
  if (t.length < 6) return guidance;

  // ① 确认意图检测
  const CONFIRM_WORDS = ["确认", "完成", "搞定", "结束了", "可以了", "就这", "标完成", "done", "收工"];
  const wantsConfirm = CONFIRM_WORDS.some((w) => t.includes(w));
  if (wantsConfirm && review.length > 0) {
    guidance.push(
      `⚠️ 用户表达了确认/完成意图（涉及待确认任务：${review.map((x) => x.text).join("、")}）。请用 task_anchor update 将确认的任务标记 done（不确定时先与用户确认具体哪个）。`,
    );
  }

  // ② 进行中任务引导
  if (doing.length > 0) {
    guidance.push(
      `进行中任务：${doing.map((x) => x.text).join("、")}。回复结尾请引导用户确认任务推进：已完成/可以标记完成？还是继续推进？`,
    );
  }

  // ③ 任务纠回：消息与 doing 任务相关性低时提醒（确认意图/新任务登记除外）
  if (doing.length > 0 && !wantsConfirm) {
    const relevant = doing.some((x) => textOverlap(t, x.text) >= 0.25);
    if (!relevant) {
      guidance.push(
        `⚠️ 当前消息与进行中任务（${doing.map((x) => x.text).join("、")}）相关性低。若这是新任务请先 task_anchor add 登记；若是闲聊，请提醒用户任务尚未完成。`,
      );
    }
  }

  // ④ 任务积压清理引导：待确认(review)或进行中(doing)任务过多时，主动引导用户清理——
  // 用户反馈：任务锚积累大量未确认/过时任务时 agent 从不主动询问。
  const stale = [...review, ...doing];
  if (stale.length >= 4) {
    guidance.push(
      `⚠️ 当前有 ${stale.length} 个待确认/进行中任务（review=${review.length}, doing=${doing.length}），列表可能积压过时或重复登记。` +
        `回复时请主动引导用户清理：确认完成的用 task_anchor update/complete 标记 done；过时/重复的用 task_anchor action=remove 删除（task_anchor action=list 查看 id）。`,
    );
  }
  return guidance;
}

/** 文本重叠率：按双字组(bigram)重叠——单字符重叠会被「的/了/一」等常用字虚高 */
function textOverlap(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let hits = 0;
  for (const g of sa) if (sb.has(g)) hits++;
  return hits / Math.min(sa.size, sb.size);
}

/**
 * 任务锚强校验（agent_settled 时由主进程调用）：
 *   - 本轮存在任务型 user 消息但任务锚无对应登记 → 强制补登记 + 强提示。
 * 返回本次动作描述（供日志与通知使用）。
 *
 * 【2026-08 修复】移除「doing 任务自动推进 review」：
 *   agent_settled 仅代表「agent 本轮回复结束」，不代表任务完成——
 *   后台异步 subagent 仍在运行、或 agent 仅汇报中间进度时，
 *   无条件推进会把进行中任务误标为「调研完成·未确认」。
 *   任务状态由 agent 显式维护（task_anchor update），守卫只负责兜底补登记。
 */
export function enforceTaskAnchor(opts: {
	/** 最近的用户消息（已过滤宿主指令），用于任务意图检测 */
	recentUserTexts: string[];
	/** 当前 agent 会话 id；用于会话级隔离与去重 */
	sessionId?: string;
	/** 读取当前任务列表 */
	load: () => TaskAnchorItem[];
	/** 落盘任务列表 */
	save: (tasks: TaskAnchorItem[]) => void;
	/** 状态更新回调（兼容保留：当前守卫不再自动推进状态，状态由 agent 通过 task_anchor 工具维护） */
	update: (id: string, patch: { status?: TaskAnchorStatus }) => TaskAnchorItem[];
	/** 强提示回调（主进程 → renderer toast） */
	notify: (message: string) => void;
	/** 日志回调 */
	log: (scope: string, message: string, detail?: unknown) => void;
}): string {
	const { recentUserTexts, sessionId } = opts;
	const tasks = opts.load();
	const sid = sessionId;

	// ── ① 任务遗漏检测：本轮有任务型请求但任务锚无对应登记 → 强制补登记 ──
	const userTexts = recentUserTexts.filter((t) => detectTaskIntent(t));
	if (userTexts.length === 0) return "noop";

	// 去重：本会话已有任意登记（doing/review/done）时不再重复补登记，避免每轮 settled 都新增
	const hasSessionTask = sid ? tasks.some((t) => t.sessionId === sid) : false;
	// 全局任务若文字包含摘要前 12 字也视为已登记（跨会话防重）
	const summary = summarizeTaskText(userTexts[userTexts.length - 1]);
	const key = summary.slice(0, 12);
	const hasSimilar = tasks.some((t) => !t.sessionId && t.text.includes(key));
	if (hasSessionTask || hasSimilar) return "existing";

	// 强制补登记：主进程兜底写入，即使 agent 从未调用 task_anchor
	const item: TaskAnchorItem = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		text: summary,
		status: "doing",
		updatedAt: Date.now(),
		...(sid ? { sessionId: sid } : {}),
	};
	opts.save([...tasks, item]);
	const message = `任务锚强校验：本轮对话含任务型请求但未登记，已自动登记「${summary}」。请确认任务内容，确认完成后可标记完成。`;
	opts.notify(message);
	opts.log("task-anchor", "Guard: auto-registered task", {
		agentSession: sid ?? "global",
		summary,
	});
	return "auto_registered";
}
