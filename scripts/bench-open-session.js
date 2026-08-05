// 实测「打开历史会话」完整流程：get_state + get_messages + get_entries 计时
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const session = process.argv[2];
const t0 = Date.now();
const child = spawn("pi.cmd", ["--mode", "rpc", "--no-themes", "--offline", "--session", session], {
  cwd: "C:\\kaifa\\PiDeck", stdio: ["pipe", "pipe", "pipe"], shell: true,
});

const state = { spawn: null, stateMs: null, messagesMs: null, entriesMs: null };
const pending = new Map();
let buf = "";

function send(payload) {
  const id = randomUUID();
  pending.set(id, Date.now());
  child.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "response" && pending.has(msg.id)) {
        const sent = pending.get(msg.id);
        pending.delete(msg.id);
        const elapsed = Date.now() - sent;
        if (msg.command === "get_state") { state.stateMs = elapsed; console.log(`[get_state] ${elapsed}ms success=${msg.success}`); }
        if (msg.command === "get_messages") {
          state.messagesMs = elapsed;
          const count = msg.data?.messages?.length ?? 0;
          console.log(`[get_messages] ${elapsed}ms messages=${count}`);
        }
        if (msg.command === "get_entries") {
          state.entriesMs = elapsed;
          console.log(`[get_entries] ${elapsed}ms entries=${msg.data?.entries?.length ?? 0}`);
        }
        if (state.stateMs && state.messagesMs && state.entriesMs) {
          console.log(`\n[SUMMARY] 打开历史会话总耗时(从spawn起): ${Date.now() - t0}ms`);
          child.kill();
          process.exit(0);
        }
      }
    } catch {}
  }
});
child.stderr.on("data", (c) => { const t = c.toString(); if (t.trim()) console.log("[stderr]", t.slice(0, 200)); });
child.on("spawn", () => { state.spawn = Date.now() - t0; });
child.on("error", (e) => { console.error("spawn error:", e.message); process.exit(1); });
child.on("exit", (code) => { console.log(`[exit] ${code}`); process.exit(0); });

// 与 AgentManager.loadMessages 相同：get_state 就绪后并行 get_messages + get_entries
send({ type: "get_state" });

// get_state 完成后发后续请求
const watcher = setInterval(() => {
  if (state.stateMs && !state.messagesMs) send({ type: "get_messages" });
  if (state.stateMs && !state.entriesMs) send({ type: "get_entries" });
  if (state.stateMs && state.messagesMs && state.entriesMs) clearInterval(watcher);
}, 200);

setTimeout(() => { console.error("[TIMEOUT] 90s"); child.kill(); process.exit(1); }, 90_000);
