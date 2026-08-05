// 验证 stdout 背压假设：spawn pi 但延迟/不读 stdout，看 get_state 响应是否被卡住
// 用法: node scripts/bench-pi-backpressure.js [--drain-after N]
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const drainAfter = process.argv.includes("--drain-after")
  ? parseInt(process.argv[process.argv.indexOf("--drain-after") + 1], 10) : 0;

const t0 = Date.now();
const child = spawn("pi.cmd", ["--mode", "rpc", "--no-themes", "--offline"], {
  cwd: "C:\\kaifa\\PiDeck", stdio: ["pipe", "pipe", "pipe"], shell: true,
});

let received = false;
const log = (label) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${label}`);

// 默认完全不读 stdout（stdout 缓冲满后 pi 写 stdout 会阻塞）
if (drainAfter > 0) {
  setTimeout(() => {
    log(`开始排空 stdout（事件循环恢复读取）`);
    child.stdout.on("data", () => {});
  }, drainAfter);
}

child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  if (text.includes('"get_state"') && !received) {
    received = true;
    log(`get_state 响应到达（若此时 stdout 才被读，说明背压存在）`);
  }
});

child.stderr.on("data", (c) => { const t = c.toString(); if (t.trim() && !received) log(`stderr: ${t.slice(0,120)}`); });
child.on("error", (e) => { console.error("spawn error:", e.message); process.exit(1); });

// 立即发 get_state
child.stdin.write(JSON.stringify({ type: "get_state", id: randomUUID() }) + "\n");

setTimeout(() => {
  log(`结果: get_state ${received ? "已响应" : "未响应"}（stdout 未排空 ${drainAfter === 0 ? "(从未读取)" : `(${drainAfter}ms后读取)`}）`);
  child.kill();
  process.exit(0);
}, 45_000);
