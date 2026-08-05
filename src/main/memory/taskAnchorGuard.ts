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
