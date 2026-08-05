/**
 * 记忆检索集成测试：MemoryService + EmbeddingService（语义增强）
 * 跑真实 viking.db 副本，验证：预热、query 缓存、语义补召回、降级路径
 */
const { MemoryService } = require("./.memtest/memoryService.js");
const { EmbeddingService } = require("./.memtest/embeddingService.js");
const { copyFileSync, existsSync } = require("node:fs");

// 从真实运行库复制测试副本（WAL 模式必须连 -wal 一起拷，否则丢数据）
const SRC_DB = "C:/Users/123/AppData/Roaming/pi-desktop-dev/viking.db";
const DB = "C:/kaifa/PiDeck/.memtest-db/viking.db";
const { mkdirSync } = require("node:fs");
mkdirSync("C:/kaifa/PiDeck/.memtest-db", { recursive: true });
if (existsSync(SRC_DB)) {
  copyFileSync(SRC_DB, DB);
  try {
    copyFileSync(SRC_DB + "-wal", DB + "-wal");
  } catch {}
  try {
    copyFileSync(SRC_DB + "-shm", DB + "-shm");
  } catch {}
}
const MODEL_DIR = "C:/kaifa/PiDeck/resources/models";
const WS = "C:\\kaifa\\web-tracing-docs";

async function main() {
  const svc = new MemoryService(DB);
  const sem = new EmbeddingService(svc.db, MODEL_DIR);
  svc.semantic = sem;

  console.log("=== 1. 预热（模型加载 + 全库补向量） ===");
  const nodes = svc.list("all", null);
  const t0 = Date.now();
  await sem.preload(nodes.map((n) => ({ id: n.id, text: `${n.l0}\n${n.l1}` })));
  console.log(`  preload 完成: ${Date.now() - t0}ms, isReady=${sem.isReady}, 向量 ${sem.getAllVectors().size}/${nodes.length}`);

  console.log("\n=== 2. 注入链路 searchSemantic（同义表达补召回） ===");
  const t1 = Date.now();
  const r1 = await svc.searchSemantic("页面加载很慢 等了很久 卡顿", { scope: "workspace", workspaceId: WS, topK: 5 });
  console.log(`  首轮耗时 ${Date.now() - t1}ms（含模型加载）`);
  for (const r of r1) {
    console.log("   ", r.score.toFixed(2).padStart(6), (r.node.l0 || "").slice(0, 46), r.source === "embedding" ? "[语义补召回]" : `[命中: ${(r.hitTerms || []).join(",")}]`);
  }
  const t2 = Date.now();
  const r2 = await svc.searchSemantic("页面加载很慢 等了很久 卡顿", { scope: "workspace", workspaceId: WS, topK: 5 });
  console.log(`  次轮耗时 ${Date.now() - t2}ms（缓存命中）`);

  console.log("\n=== 3. 不同同义 query 验证 ===");
  const r3 = await svc.searchSemantic("仪表盘打开白屏很久 加载不出来", { scope: "workspace", workspaceId: WS, topK: 5 });
  console.log("  query=「仪表盘打开白屏很久 加载不出来」");
  for (const r of r3) {
    console.log("   ", r.score.toFixed(2).padStart(6), (r.node.l0 || "").slice(0, 46), r.source === "embedding" ? "[语义补召回]" : `[命中: ${(r.hitTerms || []).join(",")}]`);
  }

  console.log("\n=== 4. 精确关键词仍由 BM25 主导 ===");
  const r4 = await svc.searchSemantic("vite 重启 deps 冷打包 panels 卡顿", { scope: "workspace", workspaceId: WS, topK: 3 });
  for (const r of r4) console.log("   ", r.score.toFixed(2).padStart(6), (r.node.l0 || "").slice(0, 46));

  console.log("\n=== 5. 语义噪声控制：无关 query 不应补召回 ===");
  const r5 = await svc.searchSemantic("飞书机器人发送消息接口", { scope: "workspace", workspaceId: WS, topK: 5 });
  for (const r of r5) {
    console.log("   ", r.score.toFixed(2).padStart(6), (r.node.l0 || "").slice(0, 46), r.source === "embedding" ? "[语义补召回]" : `[命中: ${(r.hitTerms || []).join(",")}]`);
  }

  console.log("\n=== 6. recordAccess 反馈回路（命中后 access_count 变化） ===");
  const before = svc.list("all", null).reduce((m, n) => (m[n.id] = n.accessCount, m), {});
  await svc.searchSemantic("vite 重启 deps 冷打包 panels 卡顿", { scope: "workspace", workspaceId: WS, topK: 3 });
  const after = svc.list("all", null);
  for (const n of after.filter((n) => n.accessCount > (before[n.id] ?? 0))) {
    console.log(`   ${(n.l0 || "").slice(0, 40)}: ${before[n.id] ?? 0} → ${n.accessCount}`);
  }

  console.log("\n=== 7. 降级路径：无模型目录 ===");
  const sem2 = new EmbeddingService(svc.db, "C:/kaifa/PiDeck/models-nonexist");
  svc.semantic = sem2;
  const r7 = await svc.searchSemantic("页面加载很慢", { scope: "workspace", workspaceId: WS, topK: 3 });
  console.log(`  isReady=${sem2.isReady}，仍返回 ${r7.length} 条（纯 BM25）`);
  for (const r of r7) console.log("   ", r.score.toFixed(2).padStart(6), (r.node.l0 || "").slice(0, 46));
}

main().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
