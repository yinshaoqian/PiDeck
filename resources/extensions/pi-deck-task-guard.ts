/**
 * PiDeck Task Anchor Guard Extension v4（按用户最终需求重构）
 *
 * 用户需求（原话）：
 *   「当我提出一个问题，你在解决它之前，先把任务给我写好更新到锚点中；
 *     当你完成这个任务之后，对这个任务进行更新，标记完成。
 *     弱提示（提示词）模型不遵守规矩，所以不用提示，打算使用 Hook 工具强制。」
 *
 * 设计（v4）：
 *   开始侧（强制登记）——用户提出新任务 → agent 解决前必须先登记：
 *     input 检测到新任务意图（任务动词）且任务锚中无对应登记
 *     → 之后的工具调用被 block（reason：先调用 task_anchor add 登记该任务），
 *       直到 agent 调用 task_anchor（add/list/update 任一）才解除。
 *     【关键边界】仅「本轮用户消息含新任务意图且未登记」才拦：
 *     普通问答轮、已有进行中任务的轮次绝不拦（v1 的「每轮每工具强制更新」是错的）。
 *
 *   完成侧（强制标记完成）——任务完成后 agent 必须更新标记 done：
 *     message_end（严格 role === "assistant"）时，若本会话存在 doing 任务
 *     且 agent 尚未调用 task_anchor 维护过 → 在最终消息尾部附加提醒一次
 *     （提示先 update 标记完成）。每会话只出现一次（去重），不产生每轮噪声
 *     （v2 的「每轮都附加」是错的）。
 *
 *   移除（历史教训）：
 *     - tool_result 替换（v1：污染工具结果）
 *     - message_end 未过滤 role 的替换（v1：把用户消息替换成守卫文本 → 渲染崩溃）
 *     - 每轮 message_end 附加（v2：噪声）
 *     - before_provider_request 过滤（v3：方向误判，context-mode 与守卫无关）
 *
 *   主进程 agent_settled 兜底保留（src/main/memory/taskAnchorGuard.ts）：
 *   会话结束时自动补登记 doing + 自动推进 review + toast——机制性强校验，
 *   与扩展侧的强制配合形成双保险。
 *
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** userData 目录：优先 PIDECK_USER_DATA（PiDeck 注入），回退 Windows 打包版 */
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

/** 任务锚文件路径（与主进程 TaskAnchorStore / pi-deck-task-anchor 一致） */
function taskAnchorFile(): string {
	return join(resolveUserDataDir(), "task-anchors.json");
}

type TaskItem = {
	id: string;
	text: string;
	status: "doing" | "review" | "done";
	updatedAt: number;
	sessionId?: string;
};

/** 读取任务锚列表（文件缺失/损坏 → 空列表） */
function loadTasks(): TaskItem[] {
	try {
		const parsed = JSON.parse(readFileSync(taskAnchorFile(), "utf8")) as { tasks?: TaskItem[] };
		if (Array.isArray(parsed?.tasks)) {
			return parsed.tasks.filter(
				(t) =>
					typeof t?.id === "string" &&
					typeof t?.text === "string" &&
					(t.status === "doing" || t.status === "review" || t.status === "done"),
			);
		}
	} catch {
		// 文件不存在/损坏 → 无任务，守卫放行
	}
	return [];
}

// ── 任务意图检测（与主进程 src/main/memory/taskAnchorGuard.ts 保持一致的规则）──

/** 任务型请求动词（强信号）：命中即视为用户提出了需跨轮跟踪的任务 */
const TASK_VERBS: ReadonlyArray<string> = [
	"修复", "修好", "修一下", "修一修", "解决", "实现", "开发", "重构", "优化",
	"新增", "接入", "集成", "升级", "改造", "排查", "调查", "调研", "处理",
	"调试", "迁移", "移植", "编写", "设计", "完善", "调整", "补上", "搞定",
	"搭建", "部署", "对接", "适配", "添加", "移除", "落实", "跟进", "收口",
];

/** 排除模式：回顾/问答型开头不算任务 */
const NON_TASK_PREFIX: ReadonlyArray<RegExp> = [
	/^回顾/, /^总结/, /^解释/, /^介绍一下/, /^什么是/, /^对比/, /^闲聊/,
	/^刚才/,
];

/** 宿主指令包裹体：PiDeck 每轮注入，检测前必须剥离，否则其规则文本会误触发动词匹配 */
const HOST_MARKER_START = "[PIDECK_HOST_INSTRUCTION]";
const HOST_MARKER_END = "[/PIDECK_HOST_INSTRUCTION]";

/** 剥离宿主指令体，只保留真正的用户消息 */
function stripHostInstruction(text: string): string {
	const t = text ?? "";
	const start = t.indexOf(HOST_MARKER_START);
	const end = t.indexOf(HOST_MARKER_END);
	if (start !== -1 && end !== -1 && end > start) {
		return (t.slice(0, start) + " " + t.slice(end + HOST_MARKER_END.length)).trim();
	}
	return t;
}

/** 检测用户消息是否为任务型请求（规则与主进程守卫一致，宁多勿漏） */
function detectTaskIntent(text: string): boolean {
	const t = stripHostInstruction(text).trim();
	if (t.length < 6) return false;
	if (NON_TASK_PREFIX.some((re) => re.test(t))) return false;
	return TASK_VERBS.some((verb) => t.includes(verb));
}

/** 当前 pi 会话 id（事件上下文），拿不到时为 undefined */
function currentSessionId(ctx?: unknown): string | undefined {
	try {
		const c = ctx as { sessionManager?: { getSessionId?: () => string | undefined } } | undefined;
		const id = c?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.trim() ? id : undefined;
	} catch {
		return undefined;
	}
}

/** 是否存在「需要 agent 维护」的进行中任务（本会话或全局；会话级隔离） */
function hasOngoingTasks(sessionId?: string): boolean {
	return loadTasks().some(
		(t) => t.status === "doing" && (!t.sessionId || !sessionId || t.sessionId === sessionId),
	);
}

/** 摘要任务文本（与主进程 summarizeTaskText 一致：去宿主指令、去括号行、截 60 字） */
function summarizeTaskText(text: string): string {
	let t = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.includes("PIDECK_HOST_INSTRUCTION") && !l.startsWith("【") && !l.startsWith("[/"))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (t.length > 60) t = `${t.slice(0, 60)}…`;
	return t || "(用户消息)";
}

// ── v4 守卫文案 ──

/** 开始侧：新任务未登记时 block 工具的理由 */
const BLOCK_REASON =
	"【任务锚强制】本轮对话包含新的任务型请求，但任务锚中尚无登记。请先调用 task_anchor（action=add，" +
	"text=任务摘要）登记该任务，再开始解决。登记后工具即可正常执行；任务完成时再调用 task_anchor" +
	"（action=update, status=done）标记完成。";

/** 完成侧：存在本会话 doing 任务但未维护时，附加到 assistant 最终消息的提醒（每会话一次） */
const DONE_REMINDER =
	"\n\n【任务锚提醒】本会话仍有进行中任务未标记完成。若任务已解决，请先调用 task_anchor（action=update, status=done）" +
	"标记完成，再输出最终结论。若尚未解决，请说明当前进度。";

/** 开始侧每任务最多硬拦截次数：超过后降级放行（防死锁），由主进程 agent_settled 兜底补登记 */
const MAX_BLOCK = 2;

/** 提取消息可读文本（content 为 parts 数组或字符串两种形态） */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join(" ");
	}
	return "";
}

/** 在消息 content 尾部追加提醒（content 为 parts 数组或字符串两种形态都兼容） */
function appendReminder(content: unknown, reminder: string): unknown {
	if (Array.isArray(content)) {
		return [...content, { type: "text", text: reminder }];
	}
	if (typeof content === "string") return content + reminder;
	// 非预期结构：不动内容，避免破坏消息
	return content;
}

export default function (pi: ExtensionAPI) {
	// 守卫状态（模块级：一个 pi 进程 = 一个 agent 会话，天然隔离）
	let pendingRegistration = false; // 开始侧：存在「新任务意图但未登记」，需要强制先 add
	let blockCount = 0; // 开始侧已 block 次数（防死锁）
	let doneReminded = false; // 完成侧：本会话是否已附加过「标记完成」提醒（只一次）
	let anchorMaintained = false; // 本会话 agent 是否调用过 task_anchor（add/update 任一）

	// ── 工具调用监听 ──
	pi.on("tool_call", (event: { toolName?: string; args?: unknown }) => {
		if (event.toolName === "task_anchor") {
			// agent 已维护任务锚：解除开始侧强制，记录完成侧已维护
			anchorMaintained = true;
			pendingRegistration = false;
			return undefined;
		}
		// 开始侧强制：本轮有「新任务意图但未登记」→ block 工具，逼 agent 先 add
		if (pendingRegistration && blockCount < MAX_BLOCK) {
			blockCount++;
			return { block: true, reason: BLOCK_REASON };
		}
		return undefined;
	});

	// ── 开始侧：用户消息到达（input）——评估是否出现「新任务意图且未登记」──
	pi.on("input", (event: { text?: string }, ctx?: unknown) => {
		const text = typeof event.text === "string" ? event.text : "";
		const sid = currentSessionId(ctx);
		const hasIntent = detectTaskIntent(text);
		// 已有进行中任务（本会话/全局）→ 视为已登记，不触发强制（普通问答轮也绝不拦）
		const alreadyTracked = hasOngoingTasks(sid);
		if (hasIntent && !alreadyTracked) {
			pendingRegistration = true;
			blockCount = 0;
		}
		// 无新任务意图 → 不强制（不返回任何 transform，保持输入干净）
		return undefined;
	});

	// ── turn 开始：兜底（RPC 模式若 input 未触发，仅在「新任务且未登记」时设置）──
	pi.on("turn_start", (_event: unknown, ctx?: unknown) => {
		if (!pendingRegistration && !anchorMaintained) {
			// 不臆造任务意图：turn_start 无用户文本，仅维持 input 已判定的状态
			const sid = currentSessionId(ctx);
			if (!hasOngoingTasks(sid)) pendingRegistration = false;
		}
	});

	// ── 完成侧：消息最终化（message_end，仅处理 assistant）──
	// 本会话存在 doing 任务 且 agent 从未维护过任务锚 且本会话未提醒过
	// → 在 assistant 消息尾部附加「标记完成」提醒一次（去重，不刷屏）。
	// 【安全】严格 role === "assistant" 过滤：绝不替换 user / toolResult 消息。
	pi.on(
		"message_end",
		(event: { message?: { role?: string; content?: unknown } }, ctx?: unknown) => {
			if (event.message?.role !== "assistant") return undefined;
			if (doneReminded) return undefined;
			if (anchorMaintained) return undefined; // agent 已调过 task_anchor，视为会维护
			if (!hasOngoingTasks(currentSessionId(ctx))) return undefined;
			doneReminded = true;
			return {
				message: {
					...event.message,
					content: appendReminder(event.message.content, DONE_REMINDER),
				},
			};
		},
	);

	// ── turn 结束：清理跨轮状态（但完成侧去重标记跨会话保留，避免重复提醒）──
	pi.on("turn_end", () => {
		pendingRegistration = false;
		blockCount = 0;
	});
}
