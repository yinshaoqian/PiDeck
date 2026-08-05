/**
 * 记忆检索改进回归对比（历史 query 量化分析）
 *
 * 对照两组检索：
 *  - 旧版（对照组，纯关键词累加）：无 IDF、无停用词、无覆盖率归一化、无语义
 *    —— 逐 token 累加命中分（anchor/metadata +3 / tags +3 / l0 +2 / l1 +1），
 *       P0×1.5 / P1×1.2，时间衰减 Math.max(accessFactor, effectiveFactor)
 *       （60 天半衰、下限 0.5），纯函数实现，不触碰库。
 *  - 新版（待评估）：直接调用 esbuild 打包的 MemoryService.searchSemantic
 *       （IDF 加权 + 停用词过滤 + 覆盖率归一化 + 语义补召回 cosine>0.45 +
 *         recordAccess 反馈回路）。
 *
 * 公平性设计：
 *  - 旧版基准基于「测试开始时」的节点快照（纯函数，不受新版副作用影响）。
 *  - 新版顺序跑所有 query（反映真实部署中的反馈回路行为），库为独立副本
 *    （.memtest-db），不会污染真实 viking.db。
 *
 * 输出：scripts/.memtest/regression-results.json + 控制台摘要
 */
const { MemoryService } = require("./.memtest/memoryService.js");
const { EmbeddingService } = require("./.memtest/embeddingService.js");
const fs = require("node:fs");
const path = require("node:path");
const { copyFileSync, existsSync, mkdirSync } = require("node:fs");

// ── 常量 ───────────────────────────────────────────────
const SRC_DB = "C:/Users/123/AppData/Roaming/pi-desktop-dev/viking.db";
const DB = path.join(__dirname, "..", ".memtest-db", "viking.db");
const MODEL_DIR = "C:/kaifa/PiDeck/resources/models";
const WS = "c:/kaifa/pideck"; // query 全部来自 PiDeck 项目会话 → workspace 隔离检索（真实注入链路）
const TOP_K = 3;
const QUERIES = JSON.parse(fs.readFileSync(path.join(__dirname, ".memtest", "queries.json"), "utf8"));

// ── 复刻旧版需要的最小工具函数（与 src/main/memory/memoryService.ts 保持一致） ──

/** 简单分词：英文按空白切分，中日韩文按 Intl.Segmenter 切词（2-gram 兜底） */
function tokenize(text) {
  const s = text.toLowerCase();
  const words = s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const cjk = s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  const segs = [];
  for (const chunk of cjk) {
    try {
      const seg = new Intl.Segmenter("zh", { granularity: "word" });
      for (const part of seg.segment(chunk)) {
        if (part.isWordLike && part.segment.length > 1) segs.push(part.segment);
      }
    } catch {
      /* 回退 2-gram */
    }
  }
  return [...words, ...segs];
}

function effectiveAtOf(node) {
  const m = node.metadata;
  return typeof m?.updatedAt === "number" && m.updatedAt > 0 ? m.updatedAt : node.createdAt;
}

/**
 * 旧版打分（对照组）：纯累加，无 IDF/停用词/归一化/语义。
 * 命中规则与旧版一致：anchor/metadata +3、tags +3、l0 +2、l1 +1；P0×1.5/P1×1.2；
 * 时间衰减 Math.max(accessFactor, effectiveFactor)（60 天半衰、下限 0.5）。
 */
function legacyScore(node, tokens) {
  const l0 = node.l0.toLowerCase();
  const l1 = node.l1.toLowerCase();
  const tags = node.tags.map((t) => t.toLowerCase());
  const anchor = (node.metadata?.retrievalAnchor ?? "").toLowerCase();
  const metaText = node.metadata ? JSON.stringify(node.metadata).toLowerCase() : "";
  let score = 0;
  for (const tok of tokens) {
    let hit = 0;
    if (anchor.includes(tok)) hit = 3;
    else if (metaText.includes(tok)) hit = 3;
    if (hit === 0 && tags.some((t) => t.includes(tok))) hit = 3;
    if (hit === 0 && l0.includes(tok)) hit = 2;
    else if (hit === 0 && l1.includes(tok)) hit = 1;
    score += hit;
  }
  if (score === 0) return 0;
  if (node.priority === "P0") score *= 1.5;
  else if (node.priority === "P1") score *= 1.2;
  const daysSinceAccess = (Date.now() - node.lastAccessedAt) / (24 * 60 * 60 * 1000);
  const accessFactor = Math.max(0.5, 1 - daysSinceAccess / 60);
  const daysSinceEffective = (Date.now() - effectiveAtOf(node)) / (24 * 60 * 60 * 1000);
  const effectiveFactor = Math.max(0.5, 1 - daysSinceEffective / 60);
  score *= Math.max(accessFactor, effectiveFactor);
  return score;
}

/** 旧版 top-K（分数降序，同分按 id 稳定） */
function legacyTop(nodes, tokens, k) {
  const scored = nodes
    .map((n) => ({ n, s: legacyScore(n, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.n.id < b.n.id ? -1 : 1));
  return scored.slice(0, k).map((x) => ({ id: x.n.id, l0: x.n.l0, score: x.s, source: "local" }));
}

// ── 数据库副本（WAL 必须连 -wal 一起拷） ────────────────
mkdirSync(path.dirname(DB), { recursive: true });
if (existsSync(SRC_DB)) {
  copyFileSync(SRC_DB, DB);
  try { copyFileSync(SRC_DB + "-wal", DB + "-wal"); } catch {}
  try { copyFileSync(SRC_DB + "-shm", DB + "-shm"); } catch {}
} else {
  console.error("真实记忆库不存在: " + SRC_DB);
  process.exit(1);
}

async function main() {
  const svc = new MemoryService(DB);
  const sem = new EmbeddingService(svc.db, MODEL_DIR);
  svc.semantic = sem;

  // 稳定候选集：先跑生命周期（清过期 + 去重），再取快照
  const lc = await svc.runLifecycle();
  console.log(`lifecycle: purged=${lc.purged} dupRemoved=${lc.duplicatesRemoved}`);
  const wsNodes = svc.list("workspace", WS);
  console.log(`workspace(${WS}) 节点数: ${wsNodes.length} / 全库 ${svc.list("all", null).length}`);

  // ── 语义预热（模型加载 + 补向量） ──
  const t0 = Date.now();
  await sem.preload(wsNodes.map((n) => ({ id: n.id, text: `${n.l0}\n${n.l1}` })));
  console.log(`preload: ${Date.now() - t0}ms, isReady=${sem.isReady}, 向量 ${sem.getAllVectors().size}/${wsNodes.length}`);
  if (!sem.isReady) {
    console.log("⚠️ 语义模型不可用 —— 降级：新版仅报告纯 BM25(IDF) 路径");
  }

  // ── 对每个 query 跑新旧对比 ──
  const results = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const tokens = tokenize(q.query);

    // 旧版：快照纯函数
    const oldTop = legacyTop(wsNodes, tokens, TOP_K);

    // 新版：真实 searchSemantic（含反馈回路副作用，跑在副本库上）
    const newTop = await svc.searchSemantic(q.query, { scope: "workspace", workspaceId: WS, topK: TOP_K });

    const oldIds = new Set(oldTop.map((r) => r.id));
    const overlap = newTop.filter((r) => oldIds.has(r.node.id)).length;
    const semanticHits = newTop.filter((r) => r.source === "embedding").length;

    results.push({
      query: q.query,
      source: q.source,
      tokens: tokens.length,
      oldTop: oldTop.map((r) => ({ id: r.id, l0: r.l0.slice(0, 60), score: +r.score.toFixed(3) })),
      newTop: newTop.map((r) => ({ id: r.node.id, l0: r.node.l0.slice(0, 60), score: +r.score.toFixed(3), source: r.source, hitTerms: (r.hitTerms || []).slice(0, 6) })),
      overlap,
      semanticHits,
    });
    const o = results[i];
    console.log(
      `\nQ${String(i + 1).padStart(2)} 重合${o.overlap}/${TOP_K} 语义${o.semanticHits} tok=${o.tokens}\n` +
      `  old: ${o.oldTop.map((r) => `${r.score.toFixed(1)}:${r.l0.slice(0, 24)}`).join(" | ") || "(空)"}\n` +
      `  new: ${o.newTop.map((r) => `${r.score.toFixed(1)}${r.source === "embedding" ? "·sem" : ""}:${r.l0.slice(0, 24)}`).join(" | ") || "(空)"}`
    );
  }

  // ── 聚合指标 ──
  const n = results.length;
  const overlapTotal = results.reduce((a, r) => a + r.overlap, 0);
  const semanticQueries = results.filter((r) => r.semanticHits > 0).length;
  const semanticTotal = results.reduce((a, r) => a + r.semanticHits, 0);
  const noneOverlap = results.filter((r) => r.overlap === 0).length;

  // 分数集中度：每 query top-3 的 max 与 mean
  const oldMaxes = [], newMaxes = [], oldMeans = [], newMeans = [], oldMaxMeanRatio = [], newMaxMeanRatio = [];
  for (const r of results) {
    const om = r.oldTop.map((x) => x.score);
    const nm = r.newTop.map((x) => x.score);
    const max = (a) => (a.length ? Math.max(...a) : 0);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    oldMaxes.push(max(om)); newMaxes.push(max(nm));
    oldMeans.push(mean(om)); newMeans.push(mean(nm));
    if (mean(om) > 0) oldMaxMeanRatio.push(max(om) / mean(om));
    if (mean(nm) > 0) newMaxMeanRatio.push(max(nm) / mean(nm));
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const maxOf = (a) => Math.max(...a);

  const agg = {
    queries: n,
    avgOverlap: overlapTotal / n,
    overlapDistribution: { "3/3": results.filter((r) => r.overlap === 3).length, "2/3": results.filter((r) => r.overlap === 2).length, "1/3": results.filter((r) => r.overlap === 1).length, "0/3": noneOverlap },
    semanticQueries,
    semanticTotal,
    scoreConcentration: {
      old: { maxTop3Median: +median(oldMaxes.map((x) => Math.max(x, 1e-9))).toFixed(3), maxTop3Max: +maxOf(oldMaxes).toFixed(3), meanMedian: +median(oldMeans).toFixed(3), maxMeanRatioMedian: +median(oldMaxMeanRatio).toFixed(3), maxMeanRatioMax: +maxOf(oldMaxMeanRatio).toFixed(3) },
      new: { maxTop3Median: +median(newMaxes.map((x) => Math.max(x, 1e-9))).toFixed(3), maxTop3Max: +maxOf(newMaxes).toFixed(3), meanMedian: +median(newMeans).toFixed(3), maxMeanRatioMedian: +median(newMaxMeanRatio).toFixed(3), maxMeanRatioMax: +maxOf(newMaxMeanRatio).toFixed(3) },
    },
  };
  console.log("\n════════ 聚合指标 ════════");
  console.log(`query 数: ${n}，top-3 平均重合率: ${(agg.avgOverlap / 3 * 100).toFixed(1)}%`);
  console.log(`重合分布: 3/3=${agg.overlapDistribution["3/3"]} 2/3=${agg.overlapDistribution["2/3"]} 1/3=${agg.overlapDistribution["1/3"]} 0/3=${agg.overlapDistribution["0/3"]}`);
  console.log(`语义补召回: ${semanticQueries}/${n} 个 query 的 top-3 含 embedding 结果，共 ${semanticTotal} 条`);
  console.log(`分数集中度(old): top3 max 中位=${agg.scoreConcentration.old.maxTop3Median} 最大=${agg.scoreConcentration.old.maxTop3Max}  mean中位=${agg.scoreConcentration.old.meanMedian}  max/mean中位=${agg.scoreConcentration.old.maxMeanRatioMedian} 最大=${agg.scoreConcentration.old.maxMeanRatioMax}`);
  console.log(`分数集中度(new): top3 max 中位=${agg.scoreConcentration.new.maxTop3Median} 最大=${agg.scoreConcentration.new.maxTop3Max}  mean中位=${agg.scoreConcentration.new.meanMedian}  max/mean中位=${agg.scoreConcentration.new.maxMeanRatioMedian} 最大=${agg.scoreConcentration.new.maxMeanRatioMax}`);

  fs.writeFileSync(path.join(__dirname, ".memtest", "regression-results.json"), JSON.stringify({ agg, results }, null, 2), "utf8");
  console.log("\n-> scripts/.memtest/regression-results.json");
}

main().catch((e) => {
  console.error("回归测试失败:", e);
  process.exit(1);
});
