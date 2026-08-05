import { useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowLeft,
	ArrowRight,
	ExternalLink,
	Home,
	Maximize2,
	Minus,
	MousePointerClick,
	Plus,
	RefreshCw,
	Smartphone,
	Tablet,
	TriangleAlert,
	X,
} from "lucide-react";
import { t } from "../../i18n";

const DEFAULT_HOME = "https://ayuayue.github.io/PiDeck/";

type DeviceType = "pc" | "mobile" | "tablet";

interface TabEntry {
	id: string;
	title: string;
	url: string;
}

interface DevicePreset {
	id: DeviceType;
	label: string;
	userAgent: string | null;
}

interface ConsoleErrorEntry {
	id: number;
	level: number; // 0 verbose / 1 info / 2 warning / 3 error
	message: string;
	sourceId?: string;
	line?: number;
	time: string;
}

const DEVICE_PRESETS: DevicePreset[] = [
	{ id: "pc", label: "browser.devicePC", userAgent: null },
	{
		id: "mobile",
		label: "browser.deviceMobile",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	},
	{
		id: "tablet",
		label: "browser.deviceTablet",
		userAgent:
			"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	},
];

let nextTabId = 1;
function genTabId(): string {
	return `tab-${nextTabId++}`;
}

/**
 * 轻量 DOM 选择脚本（注入 webview）：hover 高亮圈选目标，点击确认后把
 * 元素信息经 console.log("__LIGHTSELECT__"+JSON) 回传，由 BrowserPanel 捕获。
 */
const LIGHT_SELECT_SCRIPT = `
(() => {
  if (window.__lightSelectStop) { window.__lightSelectStop(); return; }
  let current = null;
  const genSelector = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      // 仅目标元素附加一个短且稳定的 class（Tailwind 长类 / 含 / 与 : 的跳过）
      if (node === el && typeof node.className === "string") {
        const cls = node.className
          .trim()
          .split(/\s+/)
          .find((c) => c.length <= 24 && !c.includes("/") && !c.includes(":"));
        if (cls) sel += "." + CSS.escape(cls);
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(" > ");
  };
  const highlight = (el) => {
    if (current) current.style.outline = "";
    current = el;
    if (el) el.style.outline = "2px solid #3b82f6";
  };
  const onMove = (e) => {
    const t = e.target;
    if (t === document.body || t === document.documentElement) { highlight(null); return; }
    highlight(t);
  };
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    const selector = genSelector(el);
    const text = (el.innerText || el.textContent || "").trim().slice(0, 200);
    const html = el.outerHTML.slice(0, 400);
    window.__lightSelectStop();
    // 结果写入 guest window 变量，由 BrowserPanel 通过 executeJavaScript 轮询读取
    // （Electron webview 的 console-message 事件在 contextIsolation 下不可靠，弃用）
    window.__lightSelectResult = { selector, tag: el.tagName.toLowerCase(), text, html };
  };
  window.__lightSelectStop = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    if (current) current.style.outline = "";
    window.__lightSelectStop = null;
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
})();
`;

/**
 * 错误捕获脚本（注入 webview，常驻）：拦截 window.onerror / unhandledrejection /
 * console.error/warn，写入 window.__pideckErrors，由 BrowserPanel 轮询读取。
 * （Electron webview 的 console-message 事件在 contextIsolation 下不可靠，弃用）
 */
const ERROR_CAPTURE_SCRIPT = `
(() => {
  if (window.__pideckErrorHookInstalled) return;
  window.__pideckErrorHookInstalled = true;
  if (!window.__pideckErrors) window.__pideckErrors = [];
  const cap = (level, message, sourceId, line) => {
    const text = String(message || "").slice(0, 600);
    if (!text) return;
    window.__pideckErrors.push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      level,
      message: text,
      sourceId: sourceId || "",
      line: line || 0,
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    });
    if (window.__pideckErrors.length > 50) {
      window.__pideckErrors.splice(0, window.__pideckErrors.length - 50);
    }
  };
  window.addEventListener("error", (e) => {
    const msg = e.message || (e.error && (e.error.stack || e.error.message)) || "";
    cap(3, msg, e.filename || "", e.lineno || 0);
  }, true);
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? (r.stack || r.message) : String(r);
    cap(3, msg, "", 0);
  }, true);
  const origError = console.error;
  const origWarn = console.warn;
  console.error = function (...args) { cap(3, args.map(String).join(" "), "", 0); return origError.apply(console, args); };
  console.warn = function (...args) { cap(2, args.map(String).join(" "), "", 0); return origWarn.apply(console, args); };
})();
`;

/**
 * 浏览器状态要跨"抽屉模式/弹框模式"保留。
 * 这里用模块级状态保存轻量 tab 元数据，避免切换容器时丢 URL/标题/设备模式。
 * 真正的 WebContents 仍随组件挂载重建，避免同时运行两个 webview 实例。
 */
export const moduleState: { tabs: TabEntry[]; activeTabId: string | null; device: DeviceType; navigateKey: number } = {
	tabs: [],
	activeTabId: null,
	device: "pc",
	navigateKey: 0,
};

function ensureInitialTab() {
	if (moduleState.tabs.length > 0) return;
	const id = genTabId();
	moduleState.tabs = [{ id, title: "PiDeck", url: DEFAULT_HOME }];
	moduleState.activeTabId = id;
}

function getInitialActiveTab(): TabEntry {
	ensureInitialTab();
	return (
		moduleState.tabs.find((tab) => tab.id === moduleState.activeTabId) ??
		moduleState.tabs[0]
	);
}

/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 如果没有标签页则创建一个，然后切换到该标签页并加载 URL。
 */
/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 如果没有标签页则创建一个，然后切换到该标签页并加载 URL。
 * 通过递增 navigateKey 触发 BrowserPanel 的 useEffect 执行导航。
 */
/** 待消费的外部导航 URL，BrowserPanel 通过轮询检测。 */
let pendingNavigateUrl: string | null = null;

export function navigateTo(url: string) {
	// 每次外部导航创建新 tab，避免多个链接复用同一个 tab
	const id = genTabId();
	// 初始 title 留空，tab 渲染 fallback 到 url，等 page-title-updated 更新真实标题
	moduleState.tabs.push({ id, title: "", url });
	moduleState.activeTabId = id;
	moduleState.navigateKey += 1;
	// 直接设 pendingUrl，轮询会立即检测到，无需等 re-render
	pendingNavigateUrl = url;
}

type WebviewEvent<T extends string> = T extends "did-navigate"
	? { url: string }
	: T extends "did-navigate-in-page"
		? { url: string; isMainFrame: boolean }
		: T extends "page-title-updated"
			? { title: string }
			: T extends "new-window"
				? { url: string; preventDefault: () => void }
				: T extends "load-progress"
					? { progress: number }
					: Event;

export function BrowserPanel(props: {
	isFullscreen?: boolean;
	onClose?: () => void;
	onToggleFullscreen?: () => void;
	/** 最小化：关闭全屏弹框，回到抽屉模式。 */
	onMinimize?: () => void;
	/** 嵌入右侧统一 Tab 栏时隐藏关闭按钮，避免与 drawer-chrome 重复 */
	hideChromeClose?: boolean;
}) {
	const { onClose, onMinimize, onToggleFullscreen } = props;
	const [initialTab] = useState(() => getInitialActiveTab());
	const webviewRef = useRef<any>(null);
	const defaultUARef = useRef<string | null>(null);
	const [tabs, setTabs] = useState<TabEntry[]>(() => [...moduleState.tabs]);
	const [activeTabId, setActiveTabId] = useState<string | null>(
		() => moduleState.activeTabId,
	);
	const [url, setUrl] = useState(initialTab.url);
	const [inputValue, setInputValue] = useState(initialTab.url);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [loadProgress, setLoadProgress] = useState(0);
	const [device, setDevice] = useState<DeviceType>(() => moduleState.device);
	const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
	const deviceMenuRef = useRef<HTMLDivElement | null>(null);
	// 轻量 DOM 选择：注入 hover 高亮/点击选中脚本，选中后回填聊天输入框
	const [lightSelectActive, setLightSelectActive] = useState(false);
	const lightSelectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// webview 错误捕获（注入拦截 + 轮询读取），保留最近 50 条
	const [consoleErrors, setConsoleErrors] = useState<ConsoleErrorEntry[]>([]);
	const [consolePanelOpen, setConsolePanelOpen] = useState(false);
	const errorPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 弹出独立窗口后卸载侧边栏 webview（避免侧边栏/独立窗口双加载历史页面）
	const [suspended, setSuspended] = useState(false);
	// webview guest preload 路径（错误捕获最早阶段注入；就绪后才加载 src，保证 preload 先于页面执行）
	const [guestPreload, setGuestPreload] = useState("");

	const persistTabs = useCallback((nextTabs: TabEntry[], nextActiveId: string | null) => {
		moduleState.tabs = nextTabs;
		moduleState.activeTabId = nextActiveId;
		setTabs([...nextTabs]);
		setActiveTabId(nextActiveId);
	}, []);

	const applyDeviceUserAgent = useCallback((wv: any, nextDevice: DeviceType) => {
		const preset = DEVICE_PRESETS.find((item) => item.id === nextDevice);
		if (preset?.userAgent) {
			wv.setUserAgent(preset.userAgent);
		} else if (defaultUARef.current) {
			wv.setUserAgent(defaultUARef.current);
		}
	}, []);

	/** 注入错误捕获脚本（常驻）+ 启动轮询读取 guest 的错误日志（替代不可靠的 console-message） */
	const startErrorCapture = useCallback(() => {
		const wv = webviewRef.current;
		if (!wv) return;
		wv.executeJavaScript(ERROR_CAPTURE_SCRIPT).catch(() => {
			/* ignore */
		});
		if (errorPollTimerRef.current) return; // 轮询已运行，幂等
		const poll = async () => {
			const cur = webviewRef.current;
			if (!cur) return;
			try {
				const res = await cur.executeJavaScript(
					"window.__pideckErrors && window.__pideckErrors.length ? JSON.stringify(window.__pideckErrors) : null",
				);
				if (res) {
					const remote = JSON.parse(res);
					setConsoleErrors((prev) => {
						const seen = new Set(prev.map((e) => e.id));
						const merged = [...prev];
						for (const e of remote) {
							if (!seen.has(e.id)) merged.push(e);
						}
						return merged.slice(-50);
					});
				}
			} catch {
				/* webview 未就绪/已卸载时忽略 */
			}
			errorPollTimerRef.current = setTimeout(() => void poll(), 1500);
		};
		void poll();
	}, []);

	const updateActiveTab = useCallback(
		(patch: Partial<TabEntry>) => {
			if (!moduleState.activeTabId) return;
			const nextTabs = moduleState.tabs.map((tab) =>
				tab.id === moduleState.activeTabId ? { ...tab, ...patch } : tab,
			);
			moduleState.tabs = nextTabs;
			setTabs([...nextTabs]);
		},
		[],
	);

	const loadUrl = useCallback(
		(targetUrl: string, nextDevice = moduleState.device) => {
			const wv = webviewRef.current;
			if (!wv) return;
			applyDeviceUserAgent(wv, nextDevice);
			setUrl(targetUrl);
			setInputValue(targetUrl);
			wv.loadURL(targetUrl);
		},
		[applyDeviceUserAgent],
	);

	useEffect(() => {
		const wv = webviewRef.current;
		if (!wv) return;

		if (!defaultUARef.current) {
			try {
				defaultUARef.current = wv.getUserAgent();
			} catch {
				defaultUARef.current = null;
			}
		}
		applyDeviceUserAgent(wv, moduleState.device);

		const onDomReady = () => {
			webviewReadyRef.current = true;
			// 注入错误捕获脚本（常驻）+ 启动轮询
			startErrorCapture();
		};
		wv.addEventListener("dom-ready", onDomReady);

		const onDidNavigate = (event: Event) => {
			const nextUrl = (event as unknown as WebviewEvent<"did-navigate">).url;
			setUrl(nextUrl);
			setInputValue(nextUrl);
			setCanGoBack(wv.canGoBack());
			setCanGoForward(wv.canGoForward());
			updateActiveTab({ url: nextUrl });
			// 跨文档导航后 guest 重建，重新注入错误捕获
			startErrorCapture();
		};
		const onDidNavigateInPage = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"did-navigate-in-page">;
			if (!evt.isMainFrame) return;
			setUrl(evt.url);
			setInputValue(evt.url);
			updateActiveTab({ url: evt.url });
		};
		const onDidStartLoading = () => setIsLoading(true);
		const onDidStopLoading = () => {
			setIsLoading(false);
			setLoadProgress(0);
			setCanGoBack(wv.canGoBack());
			setCanGoForward(wv.canGoForward());
		};
		const onProgress = (event: Event) => {
			const progress = (event as unknown as WebviewEvent<"load-progress">).progress;
			setLoadProgress(progress);
		};
		// page-title-updated 只接收真实 title，不 fallback 到 url/DEFAULT_HOME，
		// 避免 tab 标题闪烁。初始空 title 由 tab 渲染 fallback 到 url。
		const onPageTitleUpdated = (event: Event) => {
			const title = (event as unknown as WebviewEvent<"page-title-updated">).title;
			if (title) {
				updateActiveTab({ title });
			}
		};
		const onNewWindow = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"new-window">;
			// 始终阻止默认弹窗行为，由我们接管分发
			evt.preventDefault();
			if (evt.url.startsWith("http://") || evt.url.startsWith("https://")) {
				// 页面内 target="_blank" 或 window.open 链接在浏览器新 tab 中打开
				navigateTo(evt.url);
			} else {
				// 非 http 协议（mailto: 等）走系统默认浏览器
				void window.piDesktop.browser.openExternal(evt.url);
			}
		};

		wv.addEventListener("did-navigate", onDidNavigate);
		wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
		wv.addEventListener("did-start-loading", onDidStartLoading);
		wv.addEventListener("did-stop-loading", onDidStopLoading);
		wv.addEventListener("load-progress", onProgress);
		wv.addEventListener("page-title-updated", onPageTitleUpdated);
		wv.addEventListener("new-window", onNewWindow);

		return () => {
			wv.removeEventListener("dom-ready", onDomReady);
			wv.removeEventListener("did-navigate", onDidNavigate);
			wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
			wv.removeEventListener("did-start-loading", onDidStartLoading);
			wv.removeEventListener("did-stop-loading", onDidStopLoading);
			wv.removeEventListener("load-progress", onProgress);
			wv.removeEventListener("page-title-updated", onPageTitleUpdated);
			wv.removeEventListener("new-window", onNewWindow);
			webviewReadyRef.current = false;
		};
	}, [applyDeviceUserAgent, startErrorCapture, updateActiveTab, url]);

	// 不再在卸载时清空 moduleState：折叠抽屉、切换面板后重新打开仍保留之前的 tab 状态。
	// 关闭最后一个 tab 时 closeTab 已处理 moduleState 清理并调用 onClose。
	// 组件首次挂载时如果 tabs 为空，ensureInitialTab 会创建默认页面。

	const navigate = useCallback(
		(targetUrl?: string) => {
			let finalUrl = targetUrl ?? inputValue.trim();
			if (!finalUrl) return;
			if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
				finalUrl = `https://${finalUrl}`;
			}
			loadUrl(finalUrl);
		},
		[inputValue, loadUrl],
	);

	const switchTab = useCallback(
		(tabId: string) => {
			const tab = moduleState.tabs.find((item) => item.id === tabId);
			if (!tab) return;
			moduleState.activeTabId = tabId;
			setActiveTabId(tabId);
			loadUrl(tab.url);
		},
		[loadUrl],
	);

	const addTab = useCallback(() => {
		const id = genTabId();
		const newTab = { id, title: t("browser.newTab"), url: DEFAULT_HOME };
		persistTabs([...moduleState.tabs, newTab], id);
		loadUrl(DEFAULT_HOME);
	}, [loadUrl, persistTabs]);

	// webview 是否已触发 dom-ready，用于延迟外部导航直到 webview 就绪。
	const webviewReadyRef = useRef(false);

	// 轮询检测 navigateTo 设置的 pendingNavigateUrl（module 变量不触发 React 重渲染）
	useEffect(() => {
		const interval = window.setInterval(() => {
			if (!pendingNavigateUrl) return;
			const url = pendingNavigateUrl;
			moduleState.navigateKey = 0;
			const wv = webviewRef.current;
			if (!wv) return;
			// 如果 webview 正在加载中，跳过本次轮询保留 pendingNavigateUrl，
			// 下次轮询会重试，避免 URL 被静默丢弃
			if (wv.isLoading && wv.isLoading()) return;
			// 通过加载检查后才消费 URL，防止加载中时丢请求
			pendingNavigateUrl = null;
			const activeTab = moduleState.tabs.find((t) => t.id === moduleState.activeTabId);
			if (activeTab) {
				applyDeviceUserAgent(wv, moduleState.device);
				setTabs([...moduleState.tabs]);
				setActiveTabId(moduleState.activeTabId);
				wv.loadURL(url).catch(() => {});
			}
		}, 50);
		return () => window.clearInterval(interval);
	}, [applyDeviceUserAgent]);

	const closeTab = useCallback(
		(tabId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			const current = moduleState.tabs;
			if (current.length <= 1) {
				// 关闭最后一个 tab 时从 moduleState 移除，避免下次 navigateTo 时旧 tab 还在
				moduleState.tabs = [];
				moduleState.activeTabId = null;
				moduleState.navigateKey = 0;
				pendingNavigateUrl = null;
				onClose?.();
				return;
			}
			const index = current.findIndex((tab) => tab.id === tabId);
			const nextTabs = current.filter((tab) => tab.id !== tabId);
			let nextActiveId = moduleState.activeTabId;
			if (nextActiveId === tabId) {
				nextActiveId = nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null;
			}
			persistTabs(nextTabs, nextActiveId);
			const nextTab = nextTabs.find((tab) => tab.id === nextActiveId);
			if (nextTab) loadUrl(nextTab.url);
		},
		[loadUrl, onClose, persistTabs],
	);

	const selectDevice = useCallback(
		(nextDevice: DeviceType) => {
			moduleState.device = nextDevice;
			setDevice(nextDevice);
			setDeviceMenuOpen(false);
			// 仅改 UA 不会触发布局变化；同时切换 browser-panel 的 device class 限制 webview 视口宽度。
			loadUrl(url || DEFAULT_HOME, nextDevice);
		},
		[loadUrl, url],
	);

	useEffect(() => {
		if (!deviceMenuOpen) return;
		const handleMouseDown = (event: MouseEvent) => {
			if (!deviceMenuRef.current?.contains(event.target as Node)) {
				setDeviceMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [deviceMenuOpen]);

	const stopLightSelectPoll = useCallback(() => {
		if (lightSelectTimerRef.current) {
			clearTimeout(lightSelectTimerRef.current);
			lightSelectTimerRef.current = null;
		}
		setLightSelectActive(false);
	}, []);

	/** 清空 guest 页面已收集的错误（配合面板「清空」按钮） */
	const clearGuestErrors = useCallback(() => {
		const wv = webviewRef.current;
		if (!wv) return;
		wv.executeJavaScript("window.__pideckErrors = []; true").catch(() => {
			/* ignore */
		});
	}, []);


	/** 轮询读取 guest 页面的选中结果（console-message 在 contextIsolation 下不可靠，改用 executeJavaScript） */
	const pollLightSelect = useCallback(async () => {
		const wv = webviewRef.current;
		if (!wv) return;
		try {
			const res = await wv.executeJavaScript(
				`window.__lightSelectResult ? (() => { const r = window.__lightSelectResult; window.__lightSelectResult = null; return JSON.stringify(r); })() : null`,
			);
			if (res) {
				const info = JSON.parse(res);
				setLightSelectActive(false);
				// 独立窗口（floating 渲染进程）：经 IPC 转发主窗口填入聊天输入框；
				// 侧边栏（同渲染进程）：直接派发全局事件。
				const isFloatingWindow =
					new URLSearchParams(window.location.search).get("floating") === "browser";
				if (isFloatingWindow) {
					void window.piDesktop?.browser?.sendLightSelect?.(info);
				} else {
					window.dispatchEvent(new CustomEvent("pideck:light-select", { detail: info }));
				}
				return;
			}
		} catch {
			// 页面导航/执行异常时静默停止
			setLightSelectActive(false);
			return;
		}
		lightSelectTimerRef.current = setTimeout(() => {
			void pollLightSelect();
		}, 200);
	}, []);

	const handleLightSelect = useCallback(async () => {
		const wv = webviewRef.current;
		if (!wv) return;
		if (lightSelectActive) {
			// 已激活 → 取消选择模式
			try {
				await wv.executeJavaScript(
					"window.__lightSelectStop && window.__lightSelectStop(); window.__lightSelectResult = null; true",
				);
			} catch {
				/* ignore */
			}
			stopLightSelectPoll();
			return;
		}
		try {
			await wv.executeJavaScript(LIGHT_SELECT_SCRIPT);
			setLightSelectActive(true);
			void pollLightSelect();
		} catch {
			// webview 未就绪时静默失败
		}
	}, [lightSelectActive, pollLightSelect, stopLightSelectPoll]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			navigate();
		},
		[navigate],
	);

	// 获取 webview guest preload 路径（file:// URL）
	useEffect(() => {
		void window.piDesktop?.browser?.getGuestPreloadPath?.().then((p) => {
			if (p) setGuestPreload(p);
		});
	}, []);

	// 组件卸载时清理轮询定时器
	useEffect(() => {
		return () => {
			if (lightSelectTimerRef.current) {
				clearTimeout(lightSelectTimerRef.current);
			}
			if (errorPollTimerRef.current) {
				clearTimeout(errorPollTimerRef.current);
			}
		};
	}, []);


	const panelClass = `browser-panel${props.isFullscreen ? " is-fullscreen" : ""} device-${device}`;
	const activeDevicePreset = DEVICE_PRESETS.find((preset) => preset.id === device) ?? DEVICE_PRESETS[0];
	const deviceIcon = device === "mobile" ? <Smartphone size={13} /> : device === "tablet" ? <Tablet size={13} /> : null;

	return (
		<div className={panelClass} onClick={(event) => event.stopPropagation()}>
			<div className="browser-tabbar">
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`browser-tab${tab.id === activeTabId ? " active" : ""}`}
						onClick={() => switchTab(tab.id)}
					>
						<span className="browser-tab-title">{tab.title || tab.url}</span>
						<button className="browser-tab-close" onClick={(event) => closeTab(tab.id, event)} title={t("browser.closeTab")}>
							<X size={11} />
						</button>
					</div>
				))}
				<button className="browser-tab-add" onClick={addTab} title={t("browser.newTab")}>
					<Plus size={14} />
				</button>
				{!props.isFullscreen && (
					<div className="browser-tabbar-actions">
						<button className="browser-tabbar-btn" onClick={onToggleFullscreen} title={t("browser.fullscreen")}>
							<Maximize2 size={13} />
						</button>
						{/* 统一 drawer chrome 已提供关闭；此处仅在独立/旧布局时保留 */}
						{!props.hideChromeClose && (
							<button className="browser-tabbar-btn" onClick={onClose} title={t("common.close")}>
								<X size={14} />
							</button>
						)}
					</div>
				)}
			</div>

			<div className="browser-toolbar">
				<button className="browser-nav-btn" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} title={t("browser.back")}>
					<ArrowLeft size={15} />
				</button>
				<button className="browser-nav-btn" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} title={t("browser.forward")}>
					<ArrowRight size={15} />
				</button>
				<button className="browser-nav-btn" onClick={() => webviewRef.current?.reload()} title={t("browser.reload")}>
					<RefreshCw size={15} />
				</button>
				<button className="browser-nav-btn" onClick={() => loadUrl(DEFAULT_HOME)} title={t("browser.home")}>
					<Home size={15} />
				</button>
				<div className="browser-url-bar">
					<input
						type="text"
						className="browser-url-input"
						value={inputValue}
						onChange={(event) => setInputValue(event.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={(event) => event.target.select()}
						placeholder={t("browser.urlPlaceholder")}
					/>
				</div>
				<div className="browser-device-wrapper" ref={deviceMenuRef}>
					<button
						type="button"
						className={`browser-device-trigger${deviceMenuOpen ? " active" : ""}`}
						onClick={() => setDeviceMenuOpen((open) => !open)}
						title={t("browser.deviceLabel")}
					>
						{deviceIcon}
						<span>{t(activeDevicePreset.label as any)}</span>
					</button>
					{deviceMenuOpen && (
						<div className="browser-device-menu">
							{DEVICE_PRESETS.map((preset) => (
								<button
									key={preset.id}
									type="button"
									className={`browser-device-menu-item${preset.id === device ? " active" : ""}`}
									onClick={() => selectDevice(preset.id)}
								>
									{preset.id === "mobile" ? <Smartphone size={13} /> : preset.id === "tablet" ? <Tablet size={13} /> : <span className="browser-device-pc-dot" />}
									<span>{t(preset.label as any)}</span>
								</button>
							))}
						</div>
					)}
				</div>
				<button
					type="button"
					className="browser-nav-btn"
					onClick={() => {
						const target = url || inputValue || DEFAULT_HOME;
						// 弹出独立窗口后卸载侧边栏 webview，避免双份页面同时加载
						setSuspended(true);
						void window.piDesktop?.browser?.openWindow?.(target);
					}}
					title={t("browser.openWindow")}
				>
					<ExternalLink size={15} />
				</button>
				<button
					type="button"
					className={`browser-nav-btn${lightSelectActive ? " active" : ""}`}
					onClick={() => void handleLightSelect()}
					title={t("browser.lightSelect")}
				>
					<MousePointerClick size={15} />
				</button>
				<button
					type="button"
					className={`browser-console-trigger${consoleErrors.length > 0 ? " has-errors" : ""}${consolePanelOpen ? " active" : ""}`}
					onClick={() => setConsolePanelOpen((open) => !open)}
					title={t("browser.consoleErrors")}
				>
					<TriangleAlert size={14} />
					{consoleErrors.length > 0 && (
						<span className="browser-console-count">{consoleErrors.length > 99 ? "99+" : consoleErrors.length}</span>
					)}
				</button>
				{props.isFullscreen ? (
					<>
						<button className="browser-nav-btn" onClick={onMinimize} title={t("browser.minimize")}>
							<Minus size={15} />
						</button>
						<button className="browser-nav-btn" onClick={onClose} title={t("browser.close")}>
							<X size={15} />
						</button>
					</>
				) : null}
			</div>

			{isLoading && (
				<div className="browser-loading-bar">
					<div className="browser-loading-fill" style={{ width: `${Math.max(5, loadProgress * 100)}%` }} />
				</div>
			)}

			{consolePanelOpen && (
				<div className="browser-console-panel">
					<div className="browser-console-header">
						<span>
							{t("browser.consoleErrors")}（{consoleErrors.length}）
						</span>
						<div className="browser-console-actions">
							<button type="button" onClick={() => { setConsoleErrors([]); void clearGuestErrors(); }}>
								{t("browser.consoleClear")}
							</button>
							<button type="button" onClick={() => setConsolePanelOpen(false)}>
								{t("browser.consoleClose")}
							</button>
						</div>
					</div>
					<div className="browser-console-list">
						{consoleErrors.length === 0 ? (
							<div className="browser-console-empty">{t("browser.consoleEmpty")}</div>
						) : (
							consoleErrors.map((err) => (
								<div key={err.id} className={`browser-console-item level-${err.level}`}>
									<div className="browser-console-time">{err.time}</div>
									<div className="browser-console-msg">{err.message}</div>
									{err.sourceId && (
										<div className="browser-console-src">
											{err.sourceId}
											{err.line ? `:${err.line}` : ""}
										</div>
									)}
								</div>
							))
						)}
					</div>
				</div>
			)}

			<div className="browser-webview-stage">
				{suspended ? (
					<div className="browser-suspended-hint">{t("browser.suspendedHint")}</div>
				) : (
					<webview
						ref={(el) => {
							(webviewRef as React.MutableRefObject<any>).current = el;
							if (el) el.setAttribute("allowfileaccess", "true");
						}}
						className="browser-webview"
						preload={guestPreload || undefined}
						src={guestPreload ? initialTab.url : undefined}
						allowpopups={"true" as any}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * 独立浏览器窗口模式（主进程以 ?floating=browser 加载本入口）。
 * 只渲染全宽浏览器面板，不渲染 PiDeck 主 UI；窗口关闭 = 关闭面板。
 */
export function FloatingBrowserWindow() {
	const initialUrl = new URLSearchParams(window.location.search).get("url") ?? "";
	useEffect(() => {
		if (initialUrl && /^https?:\/\//i.test(initialUrl)) {
			navigateTo(initialUrl);
		}
	}, [initialUrl]);
	return (
		<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
			<BrowserPanel
				isFullscreen
				hideChromeClose
				onClose={() => window.close()}
				onMinimize={() => window.close()}
			/>
		</div>
	);
}
