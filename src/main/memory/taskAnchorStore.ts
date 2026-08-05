/**
 * Task Anchor（任务锚）存储层。
 *
 * 任务锚是"当前核心任务列表"——用户在输入框添加任务，Agent 通过扩展工具
 * 更新任务文字/状态（进行中 → 调研完成·未确认 → 已完成）。
 *
 * 存储：userData/task-anchors.json（持久化，重启保留）。
 * 模型：全局一份任务列表（任务锚语义是"当前任务"，多 agent 共享同一份）；
 * 若将来需要 per-session 隔离，给条目加 sessionKey 字段即可。
 *
 * 并发：Agent 扩展（pi 进程）与主进程都可能写该文件，采用"读-改-写"整体替换 +
 * 简单版本号校验，避免互相覆盖。
 */
import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskAnchorItem, TaskAnchorStatus } from "../../shared/types";

const FILE_VERSION = 1;

/**
 * 自动清理（防任务堆积）：
 *  - done 超过 7 天未更新 → 移除（已确认完成，彻底归档，不再显示）
 *  - review 超过 14 天未更新 → 自动降级 done（调研完成但无人确认，超时视为归档）
 *  - 活动任务（doing+review）超过上限 → 最旧的 review 逐个降级 done（兜底，防无限膨胀）
 *
 * 清理是惰性的：在任何 load() 读盘后顺带执行，有变化才落盘。
 * 无论任务是由主进程还是 pi 扩展（直接写文件）产生，watch 触发重新 load 时都会自愈。
 */
const DONE_RETENTION_MS = 7 * 24 * 3600 * 1000;
const REVIEW_STALE_MS = 14 * 24 * 3600 * 1000;
const MAX_ACTIVE_TASKS = 30;

/**
 * 文件变化（pi 扩展工具写入）→ 回调，用于主进程向 renderer 推送刷新事件。
 * 返回取消函数。
 */
export type TaskAnchorWatchFn = (tasks: TaskAnchorItem[]) => void;

export class TaskAnchorStore {
	private readonly filePath: string;
	private watcher: FSWatcher | null = null;
	private watchTimer: NodeJS.Timeout | null = null;

	constructor(fileName = "task-anchors.json") {
		this.filePath = join(app.getPath("userData"), fileName);
	}

	/**
	 * 读取任务列表。
	 * 注意：不做内存缓存——pi 扩展（Agent 工具）也会直接写这个文件，
	 * 缓存会导致主进程读到旧数据；文件很小（几十条），每次读磁盘开销可忽略。
	 */
	load(): TaskAnchorItem[] {
		let tasks: TaskAnchorItem[] = [];
		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as { version?: number; tasks?: TaskAnchorItem[] };
			if (Array.isArray(parsed?.tasks)) {
				tasks = parsed.tasks.filter(
					(t) =>
						typeof t?.id === "string" &&
						typeof t?.text === "string" &&
						(t.status === "doing" || t.status === "review" || t.status === "done"),
				);
			}
		} catch {
			// 文件不存在/损坏 → 空列表，首次保存时重建
		}
		// 惰性自动清理：读盘后顺带清理超期/超量任务并落盘，避免历史任务无限堆积
		const cleaned = this.applyAutoCleanup(tasks);
		if (cleaned.length !== tasks.length) {
			this.save(cleaned);
		}
		return cleaned;
	}

	/**
	 * 自动清理规则（只对 done/review 生效，doing 任务绝不触碰）：
	 * 1. done 超期移除；
	 * 2. review 超期自动降级 done；
	 * 3. 活动任务超上限时按 updatedAt 从旧到新降级 review。
	 *
	 * 依赖 updatedAt（最后更新时间）而非 createdAt：任务被 agent 维护时会刷新
	 * updatedAt，因此“长时间没人动”才能触发清理，正在被跟踪的任务不会被误清。
	 */
	private applyAutoCleanup(tasks: TaskAnchorItem[]): TaskAnchorItem[] {
		const now = Date.now();
		let changed = false;
		const afterTimeout = tasks
			.filter((t) => {
				if (t.status === "done" && now - (t.updatedAt ?? 0) > DONE_RETENTION_MS) {
					changed = true;
					return false;
				}
				return true;
			})
			.map((t) => {
				if (t.status === "review" && now - (t.updatedAt ?? 0) > REVIEW_STALE_MS) {
					changed = true;
					return { ...t, status: "done" as const, updatedAt: now };
				}
				return t;
			});
		// 活动上限兜底：从最旧的 review 开始降级，直到活动数不超过上限
		const activeCount = afterTimeout.filter(
			(t) => t.status === "doing" || t.status === "review",
		).length;
		if (activeCount > MAX_ACTIVE_TASKS) {
			const staleReviews = afterTimeout
				.filter((t) => t.status === "review")
				.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
			const toDowngrade = new Set(
				staleReviews.slice(0, activeCount - MAX_ACTIVE_TASKS).map((t) => t.id),
			);
			if (toDowngrade.size > 0) changed = true;
			return afterTimeout.map((t) =>
				toDowngrade.has(t.id) ? { ...t, status: "done" as const, updatedAt: now } : t,
			);
		}
		return changed ? afterTimeout : tasks;
	}

	/** 整体替换任务列表并落盘 */
	save(tasks: TaskAnchorItem[]): TaskAnchorItem[] {
		const normalized = this.applyAutoCleanup(
			tasks.filter(
				(t) =>
					typeof t?.id === "string" &&
					typeof t?.text === "string" &&
					(t.status === "doing" || t.status === "review" || t.status === "done"),
			),
		);
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(
				this.filePath,
				JSON.stringify({ version: FILE_VERSION, tasks: normalized }, null, 2),
				"utf8",
			);
		} catch {
			// 写盘失败不抛（内存态仍可用），避免任务锚故障影响主流程
		}
		return normalized;
	}

	/** 更新单条：按 id 找到后替换 text/status，无 id 匹配则忽略 */
	update(
		id: string,
		patch: { text?: string; status?: TaskAnchorStatus },
	): TaskAnchorItem[] {
		const tasks = this.load();
		let changed = false;
		const next = tasks.map((t) => {
			if (t.id !== id) return t;
			changed = true;
			return {
				...t,
				...(patch.text !== undefined && patch.text.trim() ? { text: patch.text.trim() } : {}),
				...(patch.status !== undefined ? { status: patch.status } : {}),
				updatedAt: Date.now(),
			};
		});
		return changed ? this.save(next) : tasks;
	}

	/**
	 * 监听文件变化（pi 扩展工具写文件时触发），防抖后回调最新任务列表。
	 * 返回取消函数。
	 */
	watch(callback: TaskAnchorWatchFn): () => void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
		} catch {
			/* ignore */
		}
		// 文件可能不存在（首次），watch 需要父目录
		const dir = dirname(this.filePath);
		this.watcher = watch(dir, (_event, filename) => {
			if (filename && String(filename) !== "task-anchors.json") return;
			// 防抖：写文件可能有多次事件
			if (this.watchTimer) clearTimeout(this.watchTimer);
			this.watchTimer = setTimeout(() => {
				callback(this.load());
			}, 200);
		});
		return () => {
			if (this.watchTimer) clearTimeout(this.watchTimer);
			this.watcher?.close();
			this.watcher = null;
		};
	}
}
