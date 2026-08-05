import { app, shell } from "electron";
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppLogEntry, AppLogLevel, AppLogQuery } from "../../shared/types";

const MAX_LOG_FILES = 14;
const MAX_READ_LINES = 5000;

function formatDate(value: Date) {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function normalizeDetail(detail: unknown) {
	if (detail instanceof Error) {
		return { name: detail.name, message: detail.message, stack: detail.stack };
	}
	return detail;
}

/**
 * 主进程应用日志服务。
 * 日志按天写入 userData/logs,既避免 renderer 崩溃丢失关键诊断信息,
 * 也避免记录到项目目录导致用户代码仓库被污染。
 */
export class AppLogger {
	private readonly dir = join(app.getPath("userData"), "logs");
	private writeQueue: Promise<void> = Promise.resolve();
	/**
	 * 惰性 mkdir：只在首次写日志时创建一次目录。
	 * 洪流期间若每条日志都 mkdir({recursive:true})，会放大磁盘 IO（曾拖慢 pi 子进程启动）。
	 */
	private dirReady: Promise<void> | null = null;
	/** 旧日志清理限频：避免每次 writeEntry 都 readdir 扫目录（洪流时同样放大磁盘 IO）。 */
	private lastCleanupAt = 0;
	private static readonly CLEANUP_INTERVAL_MS = 10 * 60_000;

	log(level: AppLogLevel, scope: string, message: string, detail?: unknown) {
		const entry: AppLogEntry = {
			id: crypto.randomUUID(),
			time: Date.now(),
			level,
			scope,
			message,
			detail: normalizeDetail(detail),
		};
		// 串行写入队列，fire-and-forget，绝不 await 阻塞调用方
		this.writeQueue = this.writeQueue
			.then(() => this.writeEntry(entry))
			.catch((error) => {
				console.warn("Failed to write app log:", error);
			});
		return this.writeQueue;
	}

	debug(scope: string, message: string, detail?: unknown) {
		return this.log("debug", scope, message, detail);
	}

	info(scope: string, message: string, detail?: unknown) {
		return this.log("info", scope, message, detail);
	}

	warn(scope: string, message: string, detail?: unknown) {
		return this.log("warn", scope, message, detail);
	}

	error(scope: string, message: string, detail?: unknown) {
		return this.log("error", scope, message, detail);
	}

	async list(query: AppLogQuery = {}): Promise<AppLogEntry[]> {
		await mkdir(this.dir, { recursive: true });
		const files = (await readdir(this.dir))
			.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file))
			.sort()
			.slice(-MAX_LOG_FILES);
		const lines: string[] = [];
		for (const file of files) {
			const raw = await readFile(join(this.dir, file), "utf8").catch(() => "");
			lines.push(...raw.split(/\r?\n/).filter(Boolean));
		}

		const search = query.search?.trim().toLowerCase();
		const limit = Math.max(1, Math.min(query.limit ?? 500, 2000));
		return lines
			.slice(-MAX_READ_LINES)
			.map((line) => {
				try {
					return JSON.parse(line) as AppLogEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is AppLogEntry => Boolean(entry))
			.filter((entry) => !query.from || entry.time >= query.from!)
			.filter((entry) => !query.to || entry.time <= query.to!)
			.filter((entry) => !query.level || query.level === "all" || entry.level === query.level)
			.filter((entry) => {
				if (!search) return true;
				const haystack = `${entry.level} ${entry.scope} ${entry.message} ${JSON.stringify(entry.detail ?? "")}`.toLowerCase();
				return haystack.includes(search);
			})
			.slice(-limit)
			.reverse();
	}

	async clear() {
		await mkdir(this.dir, { recursive: true });
		const files = await readdir(this.dir);
		await Promise.all(
			files
				.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file))
				.map((file) => unlink(join(this.dir, file)).catch(() => undefined)),
		);
		await this.info("logs", "Logs cleared");
	}

	/** 计算所有应用日志文件的总字节数 */
	async getSize(): Promise<number> {
		await mkdir(this.dir, { recursive: true });
		const files = (await readdir(this.dir))
			.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file));
		let total = 0;
		for (const file of files) {
			try { total += (await stat(join(this.dir, file))).size; } catch { /* 单个文件统计失败不影响整体 */ }
		}
		return total;
	}

	async openFolder() {
		await mkdir(this.dir, { recursive: true });
		await shell.openPath(this.dir);
	}

	private async writeEntry(entry: AppLogEntry) {
		// mkdir 只执行一次（首次写日志时），后续复用已就绪的目录。
		if (!this.dirReady) {
			// then 显式转为 void：mkdir 的返回值类型是 string，Promise 链需对齐到 Promise<void>。
			this.dirReady = mkdir(this.dir, { recursive: true }).then(
				() => undefined,
				() => undefined,
			);
		}
		await this.dirReady;
		// cleanupOldFiles 限频：10 分钟最多清理一次，避免每次 append 前 readdir 扫目录。
		const now = Date.now();
		if (now - this.lastCleanupAt >= AppLogger.CLEANUP_INTERVAL_MS) {
			this.lastCleanupAt = now;
			await this.cleanupOldFiles();
		}
		const filePath = join(this.dir, `app-${formatDate(new Date(entry.time))}.log`);
		await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	private async cleanupOldFiles() {
		const files = (await readdir(this.dir).catch(() => []))
			.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file))
			.sort();
		const expired = files.slice(0, Math.max(0, files.length - MAX_LOG_FILES));
		await Promise.all(expired.map((file) => unlink(join(this.dir, file)).catch(() => undefined)));
	}
}
