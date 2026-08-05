// 捕获 pi 启动期 stderr 时间线（--verbose），定位启动阶段耗时
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const t0 = Date.now();
const child = spawn("pi.cmd", ["--mode", "rpc", "--no-themes", "--offline", "--verbose"], {
  cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], shell: true,
});

const log = (label) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${label}`);

child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8").trim();
  if (text) log(`stderr: ${text.slice(0, 300)}`);
});
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "event") log(`event: ${msg.event || msg.type}${msg.sessionId ? " sid=" + msg.sessionId : ""}`);
      else if (msg.type === "response") log(`response: ${msg.command} success=${msg.success}${msg.error ? " err=" + msg.error : ""}`);
    } catch {
      log(`stdout(raw): ${line.slice(0, 150)}`);
    }
  }
});

child.on("error", (e) => { console.error("spawn error:", e.message); process.exit(1); });
child.on("exit", (code) => { console.log(`[exit] code=${code}`); process.exit(0); });

// 立即发 get_state
child.stdin.write(JSON.stringify({ type: "get_state", id: randomUUID() }) + "\n");

setTimeout(() => { child.kill(); process.exit(0); }, 30_000);
