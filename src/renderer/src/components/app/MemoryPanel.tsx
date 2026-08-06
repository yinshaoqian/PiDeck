import { useEffect, useMemo, useState } from "react";
import {
	Activity,
	AlertCircle,
	Brain,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Database,
	FileText,
	Flame,
	Layers,
	Loader2,
	MapPin,
	Pin,
	Plus,
	Search,
	Sparkles,
	Tag,
	Trash2,
	Wand2,
	Zap,
} from "lucide-react";
import type {
	ExtractionUsageStats,
	MemoryCategory,
	MemoryExtractInput,
	MemoryExtractionEvent,
	MemoryNode,
	MemoryPriority,
	MemoryStats,
} from "../../../../shared/types";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { showNotice } from "../../utils/notice";

type MemoryPanelProps = {
	/** 当前会话消息（用于「从当前会话提取」与「对话轮次」统计）；无会话时返回 null */
	getSessionMessages: () => MemoryExtractInput["messages"] | null;
	workspaceId?: string | null;
};

const PRIORITY_LABEL: Record<MemoryPriority, string> = { P0: "P0", P1: "P1", P2: "P2" };
const CAT_LABEL: Record<MemoryCategory, string> = { memory: "记忆", skill: "技能", resource: "资源", profile: "画像" };

/** 相对时间：3d / 7d / 30d */
function formatAge(ts: number): string {
	if (!ts) return "";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
	if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}d`;
	return `${Math.floor(diff / (30 * 86400_000))}mo`;
}

/** 绝对时间：MM-DD HH:mm */
function formatDate(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 过期倒计时：2d / 7d */
function formatExpiry(ts: number): string {
	if (!ts) return "";
	const diff = ts - Date.now();
	if (diff <= 0) return "已过期";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
	return `${Math.floor(diff / 86400_000)}d`;
}

/** 粗略 token 估算：按字符数（中文 ~1.5 字/token，英文 ~4 字符/token，取 3 折中） */
function estTokens(text: string): number {
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / 3));
}

type TabKey = "memories" | "trajectories" | "context";

/**
 * 提取状态机：idle 隐藏 / running 进行中 / done 完成 / error 失败。
 * done、error 短暂展示后自动回到 idle，避免状态条永久停留在界面上（旧版 bug：
 * 会话自动提取后「调用 LLM 提取记忆…」永远不消失）。
 */
type ExtractState =
	| { phase: "idle" }
	| { phase: "running"; stage: string }
	| { phase: "done"; created: number; merged: number; skipped: number; message: string }
	| { phase: "error"; message: string };

export function MemoryPanel(props: MemoryPanelProps) {
	const [nodes, setNodes] = useState<MemoryNode[]>([]);
	const [stats, setStats] = useState<MemoryStats | null>(null);
	// 提取 LLM 消耗统计（今日/累计/分阶段/分模型）
	const [usage, setUsage] = useState<ExtractionUsageStats | null>(null);
	const [tab, setTab] = useState<TabKey>("memories");
	// 记忆 tab 筛选
	const [priorityFilter, setPriorityFilter] = useState<MemoryPriority | "all">("all");
	const [typeFilter, setTypeFilter] = useState<MemoryCategory | "all">("all");
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	// 批量
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [batchPriority, setBatchPriority] = useState<MemoryPriority>("P1");
	// 提取状态（结构化事件驱动：start/progress/done/error）
	const [extractState, setExtractState] = useState<ExtractState>({ phase: "idle" });
	const [showCreate, setShowCreate] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// 上下文 tab
	const [l0Index, setL0Index] = useState<{ text: string; memoryEntries: { id: string; l0: string; priority: MemoryPriority }[] }>({ text: "", memoryEntries: [] });
	// 新建表单：必须用受控 state 而非 ref——ref 不触发 re-render，
	// 任何后续 setState（load 完成、onChanged、搜索防抖）都会让受控 input 回写旧值，用户输入会丢失
	const [createForm, setCreateForm] = useState({
		l0: "",
		l1: "",
		l2: "",
		priority: "P1" as MemoryPriority,
		category: "memory" as MemoryCategory,
		tags: "",
		anchor: "",
	});
	// 新建弹框内的就近错误提示（与面板顶部全局 error 区分开）
	const [createError, setCreateError] = useState("");

	const setCreateField = <K extends keyof typeof createForm>(key: K, value: (typeof createForm)[K]) =>
		setCreateForm((prev) => ({ ...prev, [key]: value }));

	/** 关闭/保存成功后清空表单，保证下次打开是干净的「新建」语义 */
	const resetCreateForm = () => {
		setCreateForm({ l0: "", l1: "", l2: "", priority: "P1", category: "memory", tags: "", anchor: "" });
		setCreateError("");
	};

	const load = async () => {
		try {
			const [list, s, u] = await Promise.all([
				window.piDesktop.memory.list({ scope: "all" }),
				window.piDesktop.memory.stats(),
				window.piDesktop.memory.usage(),
			]);
			setNodes(list);
			setStats(s);
			setUsage(u);
			const idx = await window.piDesktop.memory.l0Index({ budget: 3200 });
			setL0Index(idx);
		} catch (e) {
			setError(String((e as Error)?.message ?? e));
		}
	};

	useEffect(() => {
		void load();
		const unsub = window.piDesktop.memory.onChanged(() => void load());
		// 主进程推送结构化提取事件：进行中 → 阶段文本；完成/失败 → 对应终态
		const unsubProg = window.piDesktop.memory.onExtractionEvent((ev) => {
			if (ev.type === "start" || ev.type === "progress") {
				setExtractState({ phase: "running", stage: ev.stage });
			} else if (ev.type === "done") {
				setExtractState({ phase: "done", created: ev.created, merged: ev.merged, skipped: ev.skipped, message: ev.message });
			} else {
				setExtractState({ phase: "error", message: ev.message });
			}
		});
		return () => {
			unsub();
			unsubProg();
		};
	}, []);

	// 完成/失败状态短暂展示后自动消失（5s），避免状态条残留
	useEffect(() => {
		if (extractState.phase !== "done" && extractState.phase !== "error") return;
		const t = setTimeout(() => setExtractState({ phase: "idle" }), 5000);
		return () => clearTimeout(t);
	}, [extractState]);

	useEffect(() => {
		if (!query.trim()) {
			void load();
			return;
		}
		const t = setTimeout(async () => {
			try {
				const res = await window.piDesktop.memory.search(query, { scope: "all", topK: 50 });
				setNodes(res.map((r) => r.node));
			} catch (e) {
				setError(String((e as Error)?.message ?? e));
			}
		}, 300);
		return () => clearTimeout(t);
	}, [query]);

	// ── 记忆 tab 列表（优先级 + 类型筛选） ────────────────
	const filtered = useMemo(() => {
		let list = nodes;
		if (tab === "trajectories") {
			list = nodes.filter((n) => n.metadata?.kind === "trajectory" || n.tags.includes("trajectory"));
			return list;
		}
		// 记忆 tab 只展示提炼后的记忆/经验：工具轨迹（会话原文摘要）另设「轨迹」tab，
		// 混进来会让「记忆」列表被会话原话灌满（此前 50 条里 20 条是轨迹原文），
		// 观感就是「记了一堆有的没的」。
		list = list.filter((n) => n.metadata?.kind !== "trajectory" && !n.tags.includes("trajectory"));
		if (priorityFilter !== "all") list = list.filter((n) => n.priority === priorityFilter);
		if (typeFilter !== "all") list = list.filter((n) => n.category === typeFilter);
		return list;
	}, [nodes, tab, priorityFilter, typeFilter]);

	// ── 上下文 tab 统计 ───────────────────────────────────
	const context = useMemo(() => {
		const injectedTokens = estTokens(l0Index.text);
		const fullText = nodes.map((n) => `${n.l0}\n${n.l1}\n${n.l2}`).join("\n");
		const fullTokens = estTokens(fullText);
		const saved = Math.max(0, fullTokens - injectedTokens);
		const userRounds = (props.getSessionMessages() ?? []).filter((m) => m.role === "user" && !m.isHidden).length;
		return { injectedTokens, fullTokens, saved, userRounds };
	}, [l0Index, nodes, props]);

	const toggleExpand = (id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleSelect = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const batchSetPriority = async () => {
		for (const id of selected) await window.piDesktop.memory.update(id, { priority: batchPriority });
		setSelected(new Set());
		void load();
	};

	const batchRemove = async () => {
		for (const id of selected) await window.piDesktop.memory.remove(id);
		setSelected(new Set());
		void load();
	};

	const doExtract = async () => {
		const messages = props.getSessionMessages();
		if (!messages || messages.length === 0) {
			setError("当前没有可提取的会话消息");
			return;
		}
		setExtractState({ phase: "running", stage: "正在提取记忆…" });
		setError("");
		try {
			const res = await window.piDesktop.memory.extract({ messages, workspaceId: props.workspaceId ?? null });
			// 手动提取以 IPC 返回为最终结果（比事件流多「轨迹已记录」等信息）；
			// 期间主进程推送的 done/error 事件会被这里的终态覆盖，保证一致性
			if (res.status === "saved") {
				setExtractState({ phase: "done", created: res.created ?? 0, merged: res.merged ?? 0, skipped: res.skipped ?? 0, message: res.message ?? "" });
				setError("");
			} else {
				setExtractState({ phase: "error", message: res.message ?? "提取未完成" });
			}
		} catch (e) {
			setExtractState({ phase: "error", message: `提取失败：${String((e as Error)?.message ?? e)}` });
		}
	};

	const doCreate = async () => {
		if (!createForm.l0.trim()) {
			setCreateError("L0 摘要不能为空");
			return;
		}
		setBusy(true);
		setCreateError("");
		try {
			await window.piDesktop.memory.add({
				l0: createForm.l0.trim(),
				l1: createForm.l1.trim() || undefined,
				l2: createForm.l2.trim() || undefined,
				priority: createForm.priority,
				category: createForm.category,
				tags: createForm.tags.split(/[,\s#]+/).filter(Boolean),
				retrievalAnchor: createForm.anchor.trim() || undefined,
				workspaceId: props.workspaceId ?? null,
			});
			resetCreateForm();
			setShowCreate(false);
			setError("");
			// 保存成功给显式反馈，避免筛选/搜索把新记忆过滤掉时看起来「什么都没发生」
			showNotice("记忆已保存", 2500, "info");
			void load();
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			setCreateError(msg);
			showNotice(`保存失败：${msg}`, 4000, "error");
		} finally {
			setBusy(false);
		}
	};

	const doPin = async (node: MemoryNode) => {
		await window.piDesktop.memory.pin(node.id, node.priority !== "P0");
		void load();
	};

	const doRemove = async (id: string) => {
		await window.piDesktop.memory.remove(id);
		void load();
	};

	// ── 渲染记忆卡片 ─────────────────────────────────────
	const renderItem = (node: MemoryNode, selectable: boolean) => {
		const isOpen = expanded.has(node.id);
		const anchor = node.metadata?.retrievalAnchor as string | undefined;
		return (
			<div key={node.id} className={`memory-item${isOpen ? " open" : ""}${selected.has(node.id) ? " sel" : ""}`}>
				<div className="memory-item-head" onClick={() => toggleExpand(node.id)}>
					{selectable && (
						<input
							type="checkbox"
							className="memory-check"
							checked={selected.has(node.id)}
							onChange={() => toggleSelect(node.id)}
							onClick={(e) => e.stopPropagation()}
						/>
					)}
					<span className={`memory-cat cat-${node.category}`}>{CAT_LABEL[node.category]}</span>
					<span className={`memory-prio p${node.priority.slice(1)}`}>{PRIORITY_LABEL[node.priority]}</span>
					<span className="memory-l0" title={node.l0}>{node.l0}</span>
					<span className="memory-item-actions" onClick={(e) => e.stopPropagation()}>
						<button className={node.priority === "P0" ? "pinned" : ""} title={node.priority === "P0" ? "取消钉住" : "钉住（P0 永久）"} onClick={() => void doPin(node)}>
							<Pin size={12} />
						</button>
						<button title="删除" onClick={() => void doRemove(node.id)}>
							<Trash2 size={12} />
						</button>
					</span>
					{isOpen ? <ChevronDown size={13} className="memory-chev" /> : <ChevronRight size={13} className="memory-chev" />}
				</div>
				{isOpen && (
					<div className="memory-item-body">
						{node.l1 && (
							<div className="memory-l1"><Sparkles size={11} /><span>{node.l1}</span></div>
						)}
						{node.l2 && <div className="memory-l2">{node.l2}</div>}
						{anchor && (
							<div className="memory-anchor"><MapPin size={11} /><span>{anchor}</span></div>
						)}
						{node.tags.length > 0 && (
							<div className="memory-tags">
								{node.tags.map((t) => (
									<span key={t} className="memory-tag"><Tag size={10} />#{t}</span>
								))}
							</div>
						)}
						<div className="memory-meta">
							<span>{formatAge(node.createdAt)} · {formatDate(node.createdAt)}</span>
							<span>访问 {node.accessCount}x</span>
							{node.expiresAt && node.priority !== "P0" && (
								<span className={node.expiresAt - Date.now() < 86400_000 ? "expiring" : ""}>过期 {formatExpiry(node.expiresAt)}</span>
							)}
							{node.source !== "user" && <span>{node.source}</span>}
						</div>
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="memory-panel">
			{/* 顶部工具栏 */}
			<div className="memory-toolbar">
				<div className="memory-stats">
					<strong>{stats?.total ?? 0}</strong>
					<span className="memory-stats-sub">
						<span className="prio-dot p0">P0 {stats?.byPriority?.P0 ?? 0}</span>
						<span className="prio-dot p1">P1 {stats?.byPriority?.P1 ?? 0}</span>
						<span className="prio-dot p2">P2 {stats?.byPriority?.P2 ?? 0}</span>
					</span>
				</div>
				<div className="memory-actions">
					<button className="memory-action-btn primary" disabled={extractState.phase === "running"} title="从当前会话提取记忆（LLM 分析 + 去重）" onClick={() => void doExtract()}>
						{extractState.phase === "running" ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}提取
					</button>
					<button className="memory-action-btn" title="手动新建记忆" onClick={() => setShowCreate(true)}>
						<Plus size={13} />新建
					</button>
				</div>
			</div>

			{/* 三子 tab：记忆 / 轨迹 / 上下文 */}
			<div className="memory-subtabs" role="tablist">
				{([["memories", "记忆"], ["trajectories", "轨迹"], ["context", "上下文"]] as [TabKey, string][]).map(([k, label]) => (
					<button
						key={k}
						role="tab"
						className={`memory-subtab${tab === k ? " active" : ""}`}
						onClick={() => setTab(k)}
					>
						{label}
						{k === "memories" && <span className="memory-subtab-count">{stats?.total ?? 0}</span>}
						{k === "trajectories" && <span className="memory-subtab-count">{stats?.trajectories ?? 0}</span>}
					</button>
				))}
			</div>

			{/* 提取状态条：进行中（spinner + 阶段）/ 完成（成功色 + 摘要）/ 失败（错误色 + 原因），
			    完成与失败 5s 后自动消失 */}
			{extractState.phase !== "idle" && (
				<div className={`memory-progress ${extractState.phase}`} role="status" aria-live="polite">
					{extractState.phase === "running" && <Loader2 size={12} className="spin" />}
					{extractState.phase === "done" && <CheckCircle2 size={12} />}
					{extractState.phase === "error" && <AlertCircle size={12} />}
					<span>
						{extractState.phase === "running" && extractState.stage}
						{extractState.phase === "done" && `提取完成：${extractState.message}`}
						{extractState.phase === "error" && extractState.message}
					</span>
				</div>
			)}
			{error && <div className="memory-error">{error}</div>}

			{/* ── 记忆 / 轨迹 tab ── */}
			{tab !== "context" && (
				<>
					{tab === "memories" && (
						<>
							<div className="memory-filter-bar">
								<div className="memory-filter-group">
									{(["all", "P0", "P1", "P2"] as const).map((p) => (
										<button key={p} className={`memory-chip${priorityFilter === p ? " active" : ""}`} onClick={() => setPriorityFilter(p)}>
											{p === "all" ? "全部" : p}
										</button>
									))}
								</div>
								<div className="memory-filter-group">
									{(["all", "memory", "skill", "resource", "profile"] as const).map((c) => (
										<button key={c} className={`memory-chip${typeFilter === c ? " active" : ""}`} onClick={() => setTypeFilter(c)}>
											{c === "all" ? "所有类型" : CAT_LABEL[c]}
										</button>
									))}
								</div>
							</div>
							{/* 批量操作条 */}
							{selected.size > 0 && (
								<div className="memory-batch">
									<span>已选 {selected.size} 条</span>
									<select value={batchPriority} onChange={(e) => setBatchPriority(e.target.value as MemoryPriority)}>
										<option value="P0">P0 永久</option>
										<option value="P1">P1 长期</option>
										<option value="P2">P2 短期</option>
									</select>
									<button className="memory-action-btn" onClick={() => void batchSetPriority()}>批量设优先级</button>
									<button className="memory-action-btn danger" onClick={() => void batchRemove()}>批量删除</button>
									<button className="memory-action-btn" onClick={() => setSelected(new Set())}>取消</button>
								</div>
							)}
						</>
					)}
					<div className="memory-count-line">
						{tab === "memories" ? `${filtered.length} 条` : `${filtered.length} 条轨迹`}
					</div>
					<div className="memory-list">
						{filtered.length === 0 && (
							<div className="memory-empty">
								<Brain size={22} />
								<div>
									<strong>{tab === "trajectories" ? "还没有轨迹" : "还没有记忆"}</strong>
									<p>{tab === "trajectories" ? "会话的工具调用轨迹会沉淀在这里" : "点「提取」从当前会话自动沉淀，或「新建」手动添加"}</p>
								</div>
							</div>
						)}
						{filtered.map((node) => renderItem(node, tab === "memories"))}
					</div>
				</>
			)}

			{/* ── 上下文 tab：L0 索引 + 洞察 ── */}
			{tab === "context" && (
				<div className="memory-context">
					{/* Viking 上下文 L0 索引 */}
					<div className="memory-ctx-card">
						<div className="memory-ctx-head">
							<Layers size={13} />
							<strong>Viking 上下文 (L0 索引)</strong>
						</div>
						<div className="memory-ctx-tokens">
							实际注入 <strong>~{context.injectedTokens} tokens</strong>（全量 ~{context.fullTokens} tokens）
						</div>
						{l0Index.text ? (
							<div className="memory-ctx-body">
								{l0Index.text.split("\n\n").map((block, i) => {
									const [header, ...rest] = block.split("\n");
									return (
										<div key={i} className="memory-ctx-block">
											<div className="memory-ctx-dir">{header}</div>
											{rest.map((line, j) => (
												<div key={j} className="memory-ctx-line">{line}</div>
											))}
										</div>
									);
								})}
							</div>
						) : (
							<div className="memory-ctx-empty">暂无索引内容，先添加记忆</div>
						)}
						<div className="memory-ctx-rounds">
							<Activity size={11} /> 当前会话 {context.userRounds} 轮
						</div>
					</div>

					{/* Token 节省 */}
					<div className="memory-ctx-card">
						<div className="memory-ctx-head"><Zap size={13} /><strong>Token 节省</strong></div>
						<div className="memory-insight-grid">
							<div className="memory-insight-metric">
								<span className="metric-value">{context.injectedTokens}</span>
								<span className="metric-label">L0 Tokens（当前）</span>
							</div>
							<div className="memory-insight-metric">
								<span className="metric-value">{context.fullTokens}</span>
								<span className="metric-label">完整加载（旧）</span>
							</div>
							<div className="memory-insight-metric accent">
								<span className="metric-value">-{context.fullTokens > 0 ? Math.round((context.saved / context.fullTokens) * 100) : 0}%</span>
								<span className="metric-label">节省 {context.saved} tokens</span>
							</div>
						</div>
					</div>

					{/* 提取 LLM 消耗（今日/累计/分阶段/分模型） */}
					<div className="memory-ctx-card">
						<div className="memory-ctx-head"><Wand2 size={13} /><strong>提取消耗（LLM）</strong></div>
						{usage ? (
							<>
								<div className="memory-insight-grid">
									<div className="memory-insight-metric">
										<span className="metric-value">{usage.today.calls}</span>
										<span className="metric-label">今日调用</span>
									</div>
									<div className="memory-insight-metric">
										<span className="metric-value">{usage.today.totalTokens.toLocaleString()}</span>
										<span className="metric-label">今日 tokens</span>
									</div>
									<div className="memory-insight-metric accent">
										<span className="metric-value">{usage.total.calls}</span>
										<span className="metric-label">累计调用</span>
									</div>
								</div>
								<div className="memory-ctx-expiry">
									<span className="memory-l0">分阶段</span>
									<span className="memory-access-count">
										提取 {usage.byStage.extract?.calls ?? 0} 次 · 去重 {usage.byStage.dedup?.calls ?? 0} 次 · 蒸馏 {usage.byStage.distill?.calls ?? 0} 次
									</span>
								</div>
								{usage.byModel.map((m) => (
									<div key={`${m.provider}/${m.model}`} className="memory-ctx-expiry">
										<span className="memory-l0" title={`${m.provider}/${m.model}`}>{m.model}</span>
										<span className="memory-access-count">{m.calls} 次 · {m.totalTokens.toLocaleString()} tokens</span>
									</div>
								))}
								{usage.total.calls === 0 && <div className="memory-ctx-empty">暂无消耗记录（升级后新提取才会计入）</div>}
							</>
						) : (
							<div className="memory-ctx-empty">消耗统计不可用</div>
						)}
					</div>

					{/* 文件系统统计 */}
					<div className="memory-ctx-card">
						<div className="memory-ctx-head"><Database size={13} /><strong>Viking 文件系统</strong></div>
						<div className="memory-insight-grid cols5">
							<div className="memory-insight-metric"><span className="metric-value">{stats?.memories ?? 0}</span><span className="metric-label">记忆</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.skills ?? 0}</span><span className="metric-label">技能</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.experience ?? 0}</span><span className="metric-label">经验</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.trajectories ?? 0}</span><span className="metric-label">轨迹</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.profiles ?? 0}</span><span className="metric-label">画像</span></div>
						</div>
					</div>

					{/* 优先级分布 */}
					<div className="memory-ctx-card">
						<div className="memory-ctx-head"><Pin size={13} /><strong>优先级分布</strong></div>
						<div className="memory-insight-grid cols4">
							<div className="memory-insight-metric"><span className="metric-value p0v">{stats?.byPriority?.P0 ?? 0}</span><span className="metric-label">P0 永久</span></div>
							<div className="memory-insight-metric"><span className="metric-value p1v">{stats?.byPriority?.P1 ?? 0}</span><span className="metric-label">P1（10天）</span></div>
							<div className="memory-insight-metric"><span className="metric-value p2v">{stats?.byPriority?.P2 ?? 0}</span><span className="metric-label">P2（5天）</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.expiringSoon ?? 0}</span><span className="metric-label">即将过期</span></div>
						</div>
					</div>

					{/* 新鲜度脉冲 */}
					<div className="memory-ctx-card">
						<div className="memory-ctx-head"><Flame size={13} /><strong>新鲜度脉冲</strong></div>
						<div className="memory-insight-grid cols4">
							<div className="memory-insight-metric"><span className="metric-value">{stats?.byFreshness?.last24h ?? 0}</span><span className="metric-label">24 小时</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.byFreshness?.last7d ?? 0}</span><span className="metric-label">7 天</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.byFreshness?.last30d ?? 0}</span><span className="metric-label">30 天</span></div>
							<div className="memory-insight-metric"><span className="metric-value">{stats?.byFreshness?.older ?? 0}</span><span className="metric-label">更早</span></div>
						</div>
					</div>

					{/* 即将过期明细 */}
					{(stats?.expiringSoonList?.length ?? 0) > 0 && (
						<div className="memory-ctx-card">
							<div className="memory-ctx-head"><Clock size={13} /><strong>即将过期</strong></div>
							{stats?.expiringSoonList.map((m) => (
								<div key={m.id} className="memory-ctx-expiry">
									<span className={`memory-prio p${m.priority.slice(1)}`}>{m.priority}</span>
									<span className="memory-l0">{m.l0}</span>
									<span className="memory-expiry-countdown">{m.expiresAt ? formatExpiry(m.expiresAt) : ""}</span>
								</div>
							))}
						</div>
					)}

					{/* 访问频率 */}
					{(stats?.accessTop?.length ?? 0) > 0 && (
						<div className="memory-ctx-card">
							<div className="memory-ctx-head"><Activity size={13} /><strong>访问频率</strong></div>
							{stats?.accessTop.map((m) => (
								<div key={m.id} className="memory-ctx-expiry">
									<span className="memory-l0">{m.l0}</span>
									<span className="memory-access-count">{m.accessCount}x</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* 新建记忆：居中 Modal（Radix，自带 Escape / 遮罩点击关闭、焦点陷阱），
			    避免旧版表单内嵌在 overflow:hidden 面板底部被裁掉、点了像没反应 */}
			<Modal
				open={showCreate}
				onClose={resetCreateForm}
				title="新建记忆"
				size="medium"
				contentClassName="memory-create-modal"
			>
				<div className="memory-create">
					<TextField
						label="L0 摘要 *"
						value={createForm.l0}
						onChange={(v) => setCreateField("l0", v)}
						placeholder="一句话摘要（<50 字）"
					/>
					<TextField
						label="L1 要点"
						value={createForm.l1}
						onChange={(v) => setCreateField("l1", v)}
						placeholder="2-5 条要点"
					/>
					<label className="memory-create-textarea">
						<span className="ui-field-label">L2 详情</span>
						<textarea rows={3} value={createForm.l2} onChange={(e) => setCreateField("l2", e.target.value)} placeholder="详细内容" />
					</label>
					<div className="memory-create-row">
						<SelectField
							label="类别"
							value={createForm.category}
							onChange={(v) => setCreateField("category", v as MemoryCategory)}
							options={[
								{ value: "memory", label: "记忆" },
								{ value: "skill", label: "技能" },
								{ value: "resource", label: "资源" },
								{ value: "profile", label: "画像" },
							]}
						/>
						<SelectField
							label="优先级"
							value={createForm.priority}
							onChange={(v) => setCreateField("priority", v as MemoryPriority)}
							options={[
								{ value: "P1", label: "P1 长期" },
								{ value: "P2", label: "P2 短期" },
								{ value: "P0", label: "P0 永久钉住" },
							]}
						/>
					</div>
					<TextField
						label="标签"
						value={createForm.tags}
						onChange={(v) => setCreateField("tags", v)}
						placeholder="逗号分隔，如：build, shell"
					/>
					<TextField
						label="召回锚点（何时召回）"
						value={createForm.anchor}
						onChange={(v) => setCreateField("anchor", v)}
						placeholder="触发场景，如：运行构建命令时"
					/>
					{createError && <div className="memory-create-error">{createError}</div>}
					<div className="memory-create-actions">
						<Button variant="primary" disabled={busy} onClick={() => void doCreate()}>
							{busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}保存
						</Button>
						<Button variant="ghost" onClick={resetCreateForm}>取消</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}
