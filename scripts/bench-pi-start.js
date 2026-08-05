// 实测 pi RPC 启动耗时：get_state 响应时间 = pi 内部初始化时间
// 用法: node scripts/bench-pi-start.js [--no-extensions] [--no-skills] [--cwd path]
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const args = process.argv.slice(2);
const cwd = args.includes("--cwd") ? args[args.indexOf("--cwd") + 1] : process.cwd();
const sessionPath = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
const piArgs = ["--mode", "rpc", "--no-themes", "--offline"];
if (sessionPath) piArgs.push("--session", sessionPath);
if (args.includes("--no-extensions")) piArgs.push("--no-extensions");
if (args.includes("--no-skills")) piArgs.push("--no-skills");

const t0 = Date.now();
const piCmd = process.platform === "win32" ? "pi.cmd" : "pi";
const child = spawn(piCmd, piArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
let stdoutBuf = "";
let spawnMs = 0;
let firstEventMs = null;
let stateMs = null;

child.stdout.on("data", (chunk) => {
  const now = Date.now();
  if (firstEventMs === null) firstEventMs = now - t0;
  stdoutBuf += chunk.toString("utf8");
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "response" && msg.command === "get_state") {
        stateMs = now - t0;
        console.log(`\n[RESULT] get_state 响应耗时: ${stateMs}ms (spawn ${spawnMs}ms, 首个stdout事件 ${firstEventMs}ms)`);
        if (msg.success) {
          const d = msg.data || {};
          console.log(`[RESULT] session: ${d.sessionId || "新建"} / ${d.sessionName || ""}`);
        } else {
          console.log(`[RESULT] get_state failed: ${msg.error}`);
        }
        child.kill();
        process.exit(0);
      }
    } catch {}
  }
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  console.log("[stderr]", text.slice(0, 500));
});

child.on("spawn", () => { spawnMs = Date.now() - t0; });
child.on("error", (err) => { console.error("spawn error:", err.message); process.exit(1); });

const timer = setTimeout(() => {
  console.error(`[TIMEOUT] 90s 未收到 get_state 响应`);
  child.kill();
  process.exit(1);
}, 90_000);

// 立即发 get_state（与 AgentManager 相同）
child.stdin.write(JSON.stringify({ type: "get_state", id: randomUUID() }) + "\n");
