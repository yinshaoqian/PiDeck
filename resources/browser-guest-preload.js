/**
 * webview guest preload —— 在页面任何脚本执行之前运行（最早阶段）。
 *
 * 用途：错误捕获。优先经 webFrame.executeJavaScript 注入 main world 的拦截脚本
 * （覆盖 window.onerror / unhandledrejection / console.error / console.warn），
 * 这样页面最早的运行时错误（甚至文档解析阶段）也能被记录到 window.__pideckErrors，
 * 由宿主（BrowserPanel）轮询读取展示在 ⚠ 面板。
 *
 * webFrame 不可用（sandbox 限制）时退化为 isolated world 的 DOM 事件拦截，
 * onerror / unhandledrejection 仍有效（DOM 事件跨 world 共享），console 拦截由
 * 宿主的 dom-ready 注入（main world）兜底，且 __pideckErrorHookInstalled 保证不重复。
 */

let webFrame = null;
try {
	webFrame = require("electron").webFrame;
} catch {
	webFrame = null;
}

// 与 BrowserPanel.ERROR_CAPTURE_SCRIPT 保持同一逻辑（main world 执行，幂等防重）
const INTERCEPT = `
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
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false })
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
    cap(3, r instanceof Error ? (r.stack || r.message) : String(r), "", 0);
  }, true);
  const origError = console.error;
  const origWarn = console.warn;
  console.error = function (...args) { cap(3, args.map(String).join(" "), "", 0); return origError.apply(console, args); };
  console.warn = function (...args) { cap(2, args.map(String).join(" "), "", 0); return origWarn.apply(console, args); };
})();
`;

function interceptIsolatedWorld() {
	try {
		eval(INTERCEPT); // eslint-disable-line no-eval
	} catch {
		/* 忽略 */
	}
}

try {
	if (webFrame && typeof webFrame.executeJavaScript === "function") {
		webFrame.executeJavaScript(INTERCEPT, true);
	} else {
		interceptIsolatedWorld();
	}
} catch {
	interceptIsolatedWorld();
}
