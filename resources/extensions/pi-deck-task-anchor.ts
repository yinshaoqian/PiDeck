/**
 * PiDeck Task Anchor Extension（任务锚：Agent 状态联动）
 *
 * 任务锚 = 当前核心任务列表（用户输入框添加，持久化在 userData/task-anchors.json）。
 * 本扩展给 pi agent 暴露工具，让 Agent 在执行任务时能更新任务文字/状态：
 *   - 任务开始时：task_anchor add（进行中）
 *   - 任务完成调研/实现后：task_anchor update status=review（调研完成·未确认，等待用户确认）
 *   - 用户确认后：task_anchor update status=done（已完成）
 *
 * 状态机：doing（进行中）→ review（调研完成·未确认）→ done（已完成）；可回退/改文字。
 * 与 renderer 共享同一份文件：主进程 fs.watch 监听文件变化并推送 UI 刷新，
 * 因此 Agent 更新后界面实时可见。
 *
 * 文件：PIDECK_USER_DATA/task-anchors.json（与主进程 TaskAnchorStore 同路径）
 *
 * @packageDocumentation
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

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

/** 任务锚文件路径（与主进程 TaskAnchorStore 一致） */
function taskAnchorFile(): string {
	return join(resolveUserDataDir(), "task-anchors.json");
}

type TaskItem = {
	id: string;
	text: string;
	status: "doing" | "review" | "done";
	updatedAt: number;
	/** 所属 pi 会话 id；未设置 = 全局任务（所有会话可见） */
	sessionId?: string;
};

/** 当前 pi 会话 id（工具执行上下文），拿不到时为 undefined → 新任务记为全局 */
function currentSessionId(ctx?: unknown): string | undefined {
	try {
		const c = ctx as { sessionManager?: { getSessionId?: () => string | undefined } } | undefined;
		const id = c?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.trim() ? id : undefined;
	} catch {
		return undefined;
	}
}

function loadTasks(): TaskItem[] {
	try {
		const raw = readFileSync(taskAnchorFile(), "utf8");
		const parsed = JSON.parse(raw) as { tasks?: TaskItem[] };
		if (Array.isArray(parsed?.tasks)) {
			return parsed.tasks.filter(
				(t) =>
					typeof t?.id === "string" &&
					typeof t?.text === "string" &&
					(t.status === "doing" || t.status === "review" || t.status === "done"),
			);
		}
	} catch {
		// 文件不存在/损坏 → 空列表
	}
	return [];
}

function saveTasks(tasks: TaskItem[]): void {
	try {
		mkdirSync(dirname(taskAnchorFile()), { recursive: true });
		writeFileSync(
			taskAnchorFile(),
			JSON.stringify({ version: 1, tasks }, null, 2),
			"utf8",
		);
	} catch {
		// 写盘失败静默（内存态仍可返回）
	}
}

function genId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const STATUS_LABEL: Record<string, string> = {
	doing: "进行中",
	review: "调研完成·未确认",
	done: "已完成",
};

export default function (pi: ExtensionAPI) {
	// ── 任务锚：Agent 查看/新增/更新任务（状态联动） ───────────────
	pi.registerTool({
		name: "task_anchor",
		label: "PiDeck: 当前任务锚（查看/新增/更新）",
		description:
			"管理 PiDeck 的“当前任务锚”列表（用户设定的核心任务，输入框上方可见）。" +
			"任务状态机：doing（进行中）→ review（调研完成·未确认）→ done（已完成）。" +
			"【使用规范】agent 应主动维护任务锚：开始执行某个用户任务时 add（doing）；" +
			"完成调研/实现后 update 为 review 并可在 text 中补充结论摘要（等待用户确认）；" +
			"用户确认后 update 为 done。改动会实时同步到桌面 UI（主进程监听文件变化）。" +
			"action 说明：list=查看全部；add=新增任务；update=按 id 更新文字/状态；complete=快捷标已完成。",
		parameters: Type.Object({
			action: StringEnum(["list", "add", "update", "complete"], { description: "操作类型" }),
			text: Type.Optional(Type.String({ description: "add/update 时的任务文字" })),
			id: Type.Optional(Type.String({ description: "update/complete 时的任务 id" })),
			status: Type.Optional(
				StringEnum(["doing", "review", "done"], { description: "update 时的新状态" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { action: string; text?: string; id?: string; status?: string },
			_signal?: unknown,
			_onUpdate?: unknown,
			ctx?: unknown,
		) {
			const args = params ?? {};
			const tasks = loadTasks();
			// 会话级隔离：add 绑定当前会话；list 只返回「本会话 + 全局」任务
			const sid = currentSessionId(ctx);

			switch (args.action) {
				case "add": {
					const text = (args.text ?? "").trim();
					if (!text) {
						return {
							content: [{ type: "text", text: "任务文字不能为空（text 参数）。" }],
							details: { ok: false, reason: "empty_text" },
						};
					}
					const item: TaskItem = {
						id: genId(),
						text,
						status: (args.status === "review" || args.status === "done"
							? args.status
							: "doing") as TaskItem["status"],
						updatedAt: Date.now(),
						...(sid ? { sessionId: sid } : {}),
					};
					tasks.push(item);
					saveTasks(tasks);
					return {
						content: [{
							type: "text",
							text: `已添加任务 #${item.id}：${text}（状态：${STATUS_LABEL[item.status]}）。当前共 ${tasks.length} 条。`,
						}],
						details: { ok: true, task: item, total: tasks.length },
					};
				}
				case "update": {
					if (!args.id) {
						return {
							content: [{ type: "text", text: "update 需要 id 参数。" }],
							details: { ok: false, reason: "missing_id" },
						};
					}
					let found = false;
					const next = tasks.map((t) => {
						if (t.id !== args.id) return t;
						found = true;
						return {
							...t,
							...(args.text !== undefined && args.text.trim()
								? { text: args.text.trim() }
								: {}),
							...(args.status !== undefined
								? { status: args.status as TaskItem["status"] }
								: {}),
							updatedAt: Date.now(),
						};
					});
					if (!found) {
						return {
							content: [{ type: "text", text: `未找到 id=${args.id} 的任务。可用 task_anchor action=list 查看当前任务。` }],
							details: { ok: false, reason: "not_found" },
						};
					}
					saveTasks(next);
					const updated = next.find((t) => t.id === args.id);
					return {
						content: [{
							type: "text",
							text: `任务 #${args.id} 已更新：${updated?.text}（状态：${STATUS_LABEL[updated?.status ?? "doing"]}）。`,
						}],
						details: { ok: true, task: updated, total: next.length },
					};
				}
				case "complete": {
					if (!args.id) {
						return {
							content: [{ type: "text", text: "complete 需要 id 参数。" }],
							details: { ok: false, reason: "missing_id" },
						};
					}
					let found = false;
					const next = tasks.map((t) => {
						if (t.id !== args.id) return t;
						found = true;
						return { ...t, status: "done" as const, updatedAt: Date.now() };
					});
					if (!found) {
						return {
							content: [{ type: "text", text: `未找到 id=${args.id} 的任务。` }],
							details: { ok: false, reason: "not_found" },
						};
					}
					saveTasks(next);
					return {
						content: [{ type: "text", text: `任务 #${args.id} 已标记完成 ✅。` }],
						details: { ok: true, total: next.length },
					};
				}
				case "list":
				default: {
					// 会话级隔离视图：只返回「本会话任务 + 全局任务」；拿不到会话 id 时返回全部
					const visible = sid ? tasks.filter((t) => !t.sessionId || t.sessionId === sid) : tasks;
					if (visible.length === 0) {
						return {
							content: [{ type: "text", text: "当前没有任务锚（输入框上方可添加）。" }],
							details: { ok: true, total: 0 },
						};
					}
					const lines = visible.map((t) => {
						const mark = t.status === "done" ? "☑" : t.status === "review" ? "◐" : "☐";
						const scope = t.sessionId ? "本会话" : "全局";
						return `${mark} #${t.id.slice(0, 8)} [${STATUS_LABEL[t.status]}] [${scope}] ${t.text}`;
					});
					return {
						content: [{
							type: "text",
							text: `当前任务锚（本会话可见 ${visible.length} 条）：\n${lines.join("\n")}\n\n执行/完成某任务后用 task_anchor update/complete 推进状态。`,
						}],
						details: { ok: true, total: visible.length, tasks: visible },
					};
				}
			}
		},
	});
}
