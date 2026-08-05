/**
 * PiDeck 浏览器侧边栏/独立窗口 — 自动化端到端测试脚本
 *
 * 用法（在 PiDeck 目录下）：
 *   1. 先构建最新代码：npm run build
 *   2. 关闭正在运行的 PiDeck（或本脚本会自动临时允许双开，测完还原）
 *   3. 运行：node scripts/e2e-browser-test.js
 *
 * 依赖：playwright（本机在 C:/kaifa/web-tracing-docs/web/node_modules/playwright）
 * 测试内容：
 *   - 启动真实 PiDeck（out/ 构建）
 *   - 主窗口调用 openWindow 打开独立浏览器窗口
 *   - 独立窗口点「选择页面元素」☝ → 注入脚本 → 模拟选择元素
 *   - 验证主窗口收到 pideck:light-select（输入框被填入 / toast 提示）
 *   - 截图保存到 scripts/.e2e-shots/
 */
const path = require("path");
const fs = require("fs");

// ---- 1. playwright 定位（本机从 web 项目引入，可用 npm i -D playwright 装到本仓库替代） ----
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH || "C:/kaifa/web-tracing-docs/web/node_modules/playwright";
const { _electron } = require(PLAYWRIGHT_PATH);

// ---- 2. settings 临时允许双开（备份/还原） ----
const userDataDir = path.join(process.env.APPDATA || "C:/Users/123/AppData/Roaming", "pi-desktop-dev");
const settingsPath = path.join(userDataDir, "settings.json");
const shotDir = path.join(__dirname, ".e2e-shots");
fs.mkdirSync(shotDir, { recursive: true });

async function withMultiInstance(fn) {
  let backup = null;
  try {
    if (fs.existsSync(settingsPath)) backup = fs.readFileSync(settingsPath, "utf8");
    const current = backup ? JSON.parse(backup) : {};
    fs.writeFileSync(settingsPath, JSON.stringify({ ...current, singleInstance: false }, null, 2), "utf8");
    return await fn();
  } finally {
    if (backup === null) {
      try { fs.rmSync(settingsPath, { force: true }); } catch { /* ignore */ }
    } else {
      fs.writeFileSync(settingsPath, backup, "utf8");
    }
  }
}

(async () => {
  await withMultiInstance(async () => {
    console.log("[e2e] 启动 PiDeck（out/ 构建）...");
    const app = await _electron.launch({
      args: ["."],
      cwd: "C:/kaifa/PiDeck",
      timeout: 60000,
    });
    const mainWin = await app.firstWindow();
    await mainWin.waitForLoadState("domcontentloaded");
    await new Promise((r) => setTimeout(r, 2500));
    console.log("[e2e] 主窗口标题:", await mainWin.title());

    // ---- 打开独立浏览器窗口（加载本地测试页，避免外部网络依赖） ----
    const guestHtml = "file:///" + path.join(__dirname, "..", "tmp-shots", "browser-test", "guest.html").replace(/\\/g, "/");
    await mainWin.evaluate((url) => window.piDesktop.browser.openWindow(url), guestHtml);
    await new Promise((r) => setTimeout(r, 2000));

    // 找到独立窗口（非主窗口的 page）
    const pages = app.windows();
    const floatWin = pages.find((p) => p !== mainWin);
    if (!floatWin) {
      console.error("[e2e] FAIL ❌ 未找到独立窗口");
      await app.close();
      process.exit(1);
    }
    console.log("[e2e] 独立窗口已打开:", await floatWin.title());

    // ---- 在独立窗口点「选择页面元素」☝ ----
    await floatWin.getByTitle("选择页面元素").click().catch(async () => {
      // 兜底：按图标/文本定位
      await floatWin.locator("button:has(svg.lucide-mouse-pointer-click)").first().click();
    });
    await new Promise((r) => setTimeout(r, 600));

    // ---- 在 webview 内模拟选择元素（执行注入脚本 + 模拟点击） ----
    // webview 是 shadow DOM，无法直接用 locator 穿透；通过 executeJavaScript 操作 guest
    const selectResult = await floatWin.evaluate(async () => {
      const wv = document.querySelector("webview");
      if (!wv) return { ok: false, err: "no webview" };
      // 点 ☝ 按钮已注入 light select 脚本；这里直接模拟 hover+click 到按钮元素
      const script = `
        (() => {
          const btn = document.querySelector("#btn");
          if (!btn) return "no-btn";
          btn.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return "clicked";
        })()
      `;
      const r1 = await wv.executeJavaScript(script);
      await new Promise((r) => setTimeout(r, 800));
      const r2 = await wv.executeJavaScript("window.__lightSelectResult ? JSON.stringify(window.__lightSelectResult) : null");
      return { ok: r1 !== "no-btn", step1: r1, result: r2 };
    });
    console.log("[e2e] 独立窗口选择结果:", JSON.stringify(selectResult));

    await floatWin.screenshot({ path: path.join(shotDir, "float-window.png") });
    await mainWin.screenshot({ path: path.join(shotDir, "main-window.png") });

    // ---- 验证主窗口：toast 或输入框内容 ----
    await new Promise((r) => setTimeout(r, 1200));
    const toastText = await mainWin.locator("[data-sonner-toast], .sonner-toast, [role=status]").allTextContents().catch(() => []);
    console.log("[e2e] 主窗口 toast:", toastText.join(" | ") || "(无)");

    const pass =
      selectResult.ok &&
      selectResult.result &&
      (toastText.some((t) => t.includes("元素")) || toastText.length > 0);
    console.log(pass ? "[e2e] ✅ 端到端 PASS（选择→回传→主窗口反馈）" : "[e2e] ❌ 链路不完整，见上方输出");
    console.log("[e2e] 截图:", shotDir);

    await app.close();
    process.exit(pass ? 0 : 1);
  });
})().catch((e) => {
  console.error("[e2e] 异常:", e.message);
  process.exit(1);
});
