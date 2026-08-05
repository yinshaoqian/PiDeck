/**
 * DOM Agent Link 注入器
 *
 * 背景：Electron 不执行扩展声明在 manifest 里的 content_scripts（实测 webview 与普通
 * 窗口均不注入），因此内置浏览器要复用 DOM Agent Link 的选择/快照/撤销能力，只能由
 * 主进程在 webview 页面加载完成后，把扩展目录下的 content 脚本直接执行注入。
 *
 * 注入顺序有讲究：
 *   1. electron-shim.js 必须最先 —— 它负责 mock chrome.runtime / chrome.storage，
 *      后续 selector/executor 原生代码依赖这些 API 才能直接运行；
 *   2. selector.js / note-popover.js / executor.js —— DOM Agent Link 本体；
 *   3. style.css —— 选择层/批注浮层的样式。
 *
 * 防重注入：页面内设置 window.__DOMLINK_INJECTED__ 标记，跨文档导航（did-navigate /
 * did-finish-load）只注入一次；SPA 内部路由不销毁页面，无需重注入。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";

/** 开发期排查日志：追加写入项目根目录，dev 模式下 console 也会转发到终端 */
function dbg(msg: string, detail?: unknown) {
  const line = `[dom-agent-inject] ${new Date().toISOString()} ${msg}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`;
  console.log(line);
  void import("node:fs/promises").then(({ appendFile }) =>
    appendFile(path.join(process.cwd(), "dom-agent-inject.log"), line + "\n", "utf8").catch(() => {})
  );
}

/** 扩展目录下需要注入的文件，按执行顺序排列（shim 必须在最前） */
const INJECT_FILES = [
  "content/electron-shim.js",
  "content/selector.js",
  "content/note-popover.js",
  "content/executor.js",
  "content/style.css",
];

/** 文件内容缓存：注入可能频繁（多 tab / 多页面），避免每次读盘 */
const contentCache = new Map<string, Promise<string>>();

async function loadFile(extensionPath: string, rel: string): Promise<string> {
  const abs = path.join(extensionPath, rel);
  let p = contentCache.get(abs);
  if (!p) {
    p = readFile(abs, "utf8");
    contentCache.set(abs, p);
  }
  return p;
}

/**
 * 把 DOM Agent Link content 脚本注入到目标 WebContents（webview 的 guest）。
 * 目录为空/文件缺失/注入失败都静默跳过，不影响浏览器正常使用。
 * projectPath：随选区上报的项目根目录（/dom-selections 落码时使用）；
 * 主窗口注入 PiDeck 自身源码目录，webview 注入当前活跃项目。
 */
export async function injectDomAgent(
  webContents: WebContents,
  extensionPath: string,
  projectPath = "",
  suppressOverlay = false,
  suppressBar = false,
): Promise<void> {
  if (!extensionPath) {
    dbg("skip: extensionPath is empty");
    return;
  }
  try {
    // 页面标记守卫：同一文档只注入一次（SPA 内导航不销毁页面，标记仍存在）
    const injected = await webContents.executeJavaScript(
      "Boolean(window.__DOMLINK_INJECTED__)",
      true
    );
    if (injected) {
      dbg("skip: already injected", webContents.getURL());
      return;
    }

    // 先注入项目路径（electron-shim 上报选区时携带，供 /dom-selections 直接使用）
    if (projectPath) {
      await webContents.executeJavaScript(
        `window.__DOMLINK_PROJECT_PATH__ = ${JSON.stringify(projectPath)}; true`,
        true
      );
    }

    // 设置「显示 DOM Agent 控制条」关闭时：通知 shim 不构建浮动条/唤起胶囊，
    // 选择/上报能力不受影响（Alt+Shift+D 仍可触发选择）
    if (suppressBar) {
      await webContents.executeJavaScript(
        "window.__DOMLINK_SUPPRESS_BAR__ = true; true",
        true
      );
    }

    for (const rel of INJECT_FILES) {
      try {
        const content = await loadFile(extensionPath, rel);
        if (rel.endsWith(".css")) {
          // CSS 走 <style> 注入，避免 executeJavaScript 处理长字符串的转义问题
          await webContents.executeJavaScript(
            `(() => { const s = document.createElement("style"); s.id = "domlink-injected-css"; s.textContent = ${JSON.stringify(content)}; (document.head || document.documentElement).appendChild(s); })()`,
            true
          );
        } else {
          // 脚本直接以 IIFE 源码执行（扩展 content 脚本均为自执行闭包）
          await webContents.executeJavaScript(content, true);
        }
      } catch (err) {
        dbg(`file ${rel} inject failed: ${String((err as Error)?.message ?? err)}`, webContents.getURL());
        return;
      }
    }
    // 主窗口场景（suppressOverlay）：默认隐藏 DOM Agent 浮层（批注气泡/徽章/高亮框
    // 用 z-index 2147483647 !important 会遮挡 PiDeck 按钮），但保留可切换控制器：
    //   window.__domlinkToggleOverlay() —— 快捷键切换浮层可见性
    //   window.__domlinkSetOverlay(true/false) —— 显式设置
    // 隐藏用内联 style（非 !important），便于动态切换；MutationObserver 保证
    // 浮层元素被动态创建后仍应用当前可见状态。
    if (suppressOverlay) {
      const controller = `(() => {
        const SEL = "#domlink-note-popover-host, #domlink-badges, #domlink-hover-overlay";
        const apply = (visible) => {
          document.querySelectorAll(SEL).forEach((el) => { el.style.display = visible ? "" : "none"; });
        };
        window.__domlinkOverlayVisible = false;
        window.__domlinkSetOverlay = (v) => { window.__domlinkOverlayVisible = !!v; apply(window.__domlinkOverlayVisible); };
        window.__domlinkToggleOverlay = () => window.__domlinkSetOverlay(!window.__domlinkOverlayVisible);
        apply(false);
        new MutationObserver(() => apply(window.__domlinkOverlayVisible))
          .observe(document.documentElement, { childList: true, subtree: true });
      })()`;
      await webContents.executeJavaScript(controller, true);
    }
    await webContents.executeJavaScript("window.__DOMLINK_INJECTED__ = true", true);
    dbg("injected OK", webContents.getURL());
  } catch (err) {
    dbg("inject failed: " + String((err as Error)?.message ?? err), webContents.getURL());
  }
}
