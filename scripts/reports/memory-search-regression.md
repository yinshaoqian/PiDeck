# 记忆检索改进 —— 历史 query 回归对比报告

> 量化分析 PiDeck 记忆检索三项改进（IDF 加权 + 停用词过滤 + 覆盖率归一化 / recordAccess 反馈回路 / 语义检索）相对旧版（纯关键词累加打分）的提升幅度。
> 基于真实运行数据（真实记忆库副本 + 历史会话提取的真实用户 query），非编造数字。
> 运行时间：2026-08-05（数据快照），仅只读调研，未改动 `src/` 下任何文件。

---

## 1. 方法

### 1.1 对照设计

| 维度 | 旧版（对照组） | 新版（待评估） |
|---|---|---|
| 打分 | 纯累加：anchor/metadata +3、tags +3、l0 +2、l1 +1 | `MemoryService.searchSemantic`（IDF 加权 `log((N+1)/(df+0.5))`、STOP_WORDS 停用词、覆盖率归一化 `score×matched/tokens.length`） |
| 优先级 | P0×1.5 / P1×1.2 | 同左 |
| 时间衰减 | `Math.max(accessFactor, effectiveFactor)`，60 天半衰、下限 0.5 | 同左 |
| 语义 | 无 | MiniLM-L6-v2（384 维，q8 量化，本地 resources/models），cos>0.35 加 bonus、cos>0.45 补召回 |
| 反馈回路 | 无 | recordAccess（命中 top-K 刷新 lastAccessedAt/accessCount） |

- **旧版实现**：按任务给定的旧打分规则在测试脚本内复刻为纯函数（不触碰数据库），分词器与新版完全一致（`tokenize` 复制自 `src/main/memory/memoryService.ts`）。
- **新版实现**：esbuild 打包 `memoryService.ts / embeddingService.ts / vikingDb.ts`（与 `package.json` 的 `test:memory` 相同方式）后直接调用真实编译产物。
- **公平性**：旧版基准 = 测试开始时的节点快照（纯函数）；新版按 query 顺序真实运行（含 recordAccess 副作用，反映真实部署行为）。真实库复制为 `.memtest-db/viking.db`（WAL 模式连 `-wal` 一起拷贝），全程不污染真实 `viking.db`。
- **Scope**：`workspace = c:/kaifa/pideck`（27 条记忆）——query 全部来自 PiDeck 项目会话，与真实注入链路的 workspace 隔离一致。

### 1.2 Query 集

- **来源**：`~/.pi/agent/sessions/--C--kaifa-PiDeck--/` 最近 12 个会话 JSONL（排除当前任务会话 `019fd0c1`），时间跨度 08-04 14:53 ~ 08-05 07:15。
- **提取**：`role=user` 消息 → 剥离 `[PIDECK_HOST_INSTRUCTION]` 包裹体 → 去图片占位 → 清洗空白 → 人工精选「有实质内容」的消息，保留用户原文。
- **规模**：30 条；cleanTokens 数 min=4 / median=16 / max=87。
- **主题覆盖**：记忆召回/注入机制（12 条）、pi 启动慢/性能/日志洪流（6 条）、task_anchor/hook 守卫（5 条）、Breezell 记忆系统（2 条）、会话时间线/扫描（3 条）、UI/面板（2 条）。
- 生成脚本：`scripts/build-regression-queries.cjs` → `scripts/.memtest/queries.json`。

### 1.3 语义模型

- 模型 `resources/models/Xenova/all-MiniLM-L6-v2` 加载成功（`isReady=true`），全库向量 49/50（preload 补足缺向量）。
- 每 query 经 `searchSemantic` 先算 query 向量再走 `search`，为真实语义增强路径。

---

## 2. 量化指标对比

### 2.1 新旧 top-3 命中重合度（30 query）

| 指标 | 值 |
|---|---|
| 平均重合 | **1.90 / 3（63.3%）** |
| 3/3 全重合 | 6 条（20%） |
| 2/3 | 16 条（53%） |
| 1/3 | 7 条（23%） |
| 0/3 完全不重合 | 1 条（3%） |

两版 top-3 大部分位置一致；约 1/3 的位置差异来自 IDF/停用词重排（见案例 A/C）。

### 2.2 语义补召回（source=embedding）

| 指标 | 值 |
|---|---|
| **top-3 内补召回条数** | **0 / 30（0 条）** |
| top-10 内补召回 | 11 个 query / 共 19 条 |
| 「cosine>0.45 且 BM25 零命中」的候选 | 46 个（应被补召回） |
| 30 query 对 pideck 记忆的 max cosine | min 0.354 / median **0.580** / max 0.832 |

**根因**：语义补召回分数公式 `(cos−0.45)×5` 上限仅 2.75，实际多为 0.1~1.9；而 BM25（IDF）分数普遍 3~50，**46 个补召回候选全部被 BM25 结果挤出 top-3**。语义增强在 top-3 排序层面实际不产生任何作用。

补充：verify 场景（web-tracing-docs，「页面加载很慢 等了很久 卡顿」）的 max cosine 为 0.520（>0.45 可触发），但命中的是「追踪链接页未消费渠道树」这类语义相关性存疑的记忆，说明 MiniLM-L6-v2 对中文的判别力有限。

### 2.3 分数集中度 / 长 query 分数爆炸（top-3 分数，90 条）

| 指标 | 旧版 | 新版 | 变化 |
|---|---|---|---|
| top-3 max 中位 | 16.62 | **10.47** | **−37%** |
| top-3 max 最大值 | 50.39 | 51.04 | ≈（尾部未消除） |
| top-3 mean 中位 | 12.40 | **7.32** | **−41%** |
| top-3 max/mean 中位 | 1.19 | 1.43 | 分化更明显 |
| top-3 max/mean 最大值 | 2.10 | 2.90 | 分化更明显 |
| >20 分的 top-3 条目数 | 15 | 11 | −27% |

**长 query（cleanTokens ≥ 25）逐条对比**：

| query 前缀 | tokens | 旧版 max | 新版 max |
|---|---|---|---|
| 不是 这个时间线的问题 在 pi 和 pideck 的源码修复… | 87 | 32.4 | **8.7** |
| 每条 error 主进程都 mkdir + readdir + appendFile… | 54 | 50.4 | 45.0 |
| pi的 能力这么差吗 还是我的用法不对 为什么到现任务… | 37 | 50.4 | 47.6 |
| 回顾一下这个 记忆注入: 8 现在喝个 可以展示… | 33 | 28.8 | **12.4** |
| search_sessions MCP·search 运行中… | 32 | 18.0 | **10.5** |
| 命中时在 UI 显示"已注入 N 条记忆"的提示… | 32 | 36.0 | **26.2** |
| 看下pideck 我现在 怎么解决的 聊天找回归档 记忆… | 26 | 15.5 | **8.0** |

分数爆炸**总体明显缓解（中位 −37%、mean −41%）**，但**尾部未根除**：技术词（df=1 罕见词）密集的长 query（Q9/Q29）仍有 45~48 分；Q23 因记忆 l1 恰好包含该 query 原话，9 个 df=1 的罕见 token 被 IDF 放大至 51.0 分（top-2/3 仅 1.0/0.9 分）。

---

## 3. 代表性案例

### 案例 A —— 新版明显更准（旧版被高频词噪声干扰）
> Q19「Breezell Entanglement 中讲了什么」（4 tokens）

| 排序 | 旧版 top-3 | 新版 top-3 |
|---|---|---|
| 1 | PiDeck DOM Agent Link 注入链路（3.6，**无关**） | **Breezell（viking）记忆系统分析已索引进知识库（2.4，正确）** |
| 2 | Breezell（viking）记忆系统分析（2.4） | （仅 1 条，其余节点 BM25 零命中且 cosine≤0.45） |
| 3 | 大型仓库用 rg 代替 grep（1.2，无关） | — |

新版把正确答案提到第 1、无关结果挤出；但**只返回 1 条**——补召回阈值/分数没救回其他潜在相关记忆。

### 案例 B —— 旧版漏掉正确答案 / 两版都找不到好答案
> Q30「不可能 这个是我刚才点击的 +创建的Agent对话 怎么可能少了五小时 开什么玩笑？」（16 tokens）

| 排序 | 旧版 top-3 | 新版 top-3 |
|---|---|---|
| 1 | 记忆架构决策（4.8） | 记忆架构决策（1.8） |
| 2 | npm 安装 Electron 二进制下载失败（3.6，**与「五小时」完全无关**） | pi 启动被拖慢至 40s，磁盘 IO 饱和（0.7） |
| 3 | PiDeck DOM Agent Link 注入（3.6，无关） | npm 安装 Electron 二进制下载失败（0.7） |

新版把无关的 Electron 记忆压到第 3 且分数大幅降低（3.6→0.7），但两版都未命中「会话时间线/时间戳」类记忆——**记忆库本身无此类覆盖，检索优化无法补救**（语义补召回本应能，但权重不足未生效）。

### 案例 C —— 新版极端高分（IDF 罕见词放大 + l1 含原话）
> Q23「当时说是召回结果呢 Agent根本不看那玩意 不考虑有这个东西」（12 tokens）

- 新版 top-1：「记忆架构决策：不靠 Agent 主动召回，创建 Agent 时主动注入记忆」**51.0 分**；top-2/3 仅 1.0 / 0.9 分。
- 原因：该记忆的 **l1 恰好包含此 query 的用户原话**（自动提取时写入），query 的 9 个 df=1 罕见 token（「当时说是召回结果呢」「agent根本不看那玩意」等中英混排长 token）全部命中 l1 且被 IDF 放大至 ×3.5，覆盖率为 1.0 → 分数畸高。
- 旧版同条记忆 16.6 分（同权重累加，无放大）。IDF 使「原话捷径」效应成倍放大。

### 反面案例 —— 两版都失败且新版区分度下降
> Q8「看下 pi 为什么 加载还是这么慢 这次加载40秒以上」（10 tokens）

- 旧版 top-3 全不相关（DOM Agent Link / 查功能实现 / 扩展），相关记忆「pi 启动被拖慢至 40s」被时间衰减压出 top-3。
- 新版 top-3 也不相关（任务锚相关记忆），且 **top-10 出现 10 条同分并列（0.72）**——IDF+归一化后弱命中 query 的分数被压缩到 1 分以内，失去区分度。

---

## 4. 结论

### 4.1 改进是否有效

| 改进项 | 有效性 | 证据 |
|---|---|---|
| IDF + 停用词 + 覆盖率归一化 | **有效（总体）** | top-3 max 中位 −37%、mean −41%；7 条长 query 分数全部下降；>20 分条目 15→11；案例 A 变准、案例 B 噪声被压低 |
| recordAccess 反馈回路 | **生效（真实改变排序）** | 运行中已命中记忆的时间衰减因子随 lastAccessedAt 刷新而变化，后续 query 排序随之分化（Q8 在干净库与污染库上 top-5 分数分布不同） |
| 语义检索 | **无效（top-3 层面 0 贡献）** | 30 query 语义补召回 0 条；46 个候选全部被 BM25 挤出；cos>0.35 bonus 最大 ~1.3，相对 BM25 3~50 分可忽略 |

### 4.2 残余问题

1. **语义增强权重设计失效**：补召回 `(cos−0.45)×5` 与 BM25 分数量级不匹配，即使 cosine 中位 0.58（46 个候选存在）也全部被挤出 top-3。语义检索三项投入实际对排序无贡献。
2. **IDF 罕见词放大尾部未根除**：技术词密集长 query 仍可达 45~48 分（Q9/Q29）；记忆 l1 含用户原话时可达 51 分（Q23）。tokenize 对「中英混排」会产生整段长 token（df=1 → idf=3.5），是放大主因。
3. **弱命中 query 区分度不足**：IDF+归一化把弱命中分数压到 1 分以内，出现大范围同分并列（Q8 top-10 全 0.72），无法排序。
4. **记忆库覆盖不足**：部分 query（如「五小时/时间戳」）两版均无相关命中——检索改进不能替代记忆写入覆盖。

### 4.3 建议（供后续决策）

- 语义补召回提高增益（如 `(cos−0.30)×6~8`）或降低阈值至 ~0.30，否则语义增强形同虚设；同时评估中文 embedding 模型（MiniLM 对中文同类/不相关主题判别力有限）。
- tokenize 的 words 分支对「CJK 与 ASCII 混排」先切分再分别 segment，避免整段长 token 被 IDF 放大。
- 记忆写入侧避免把用户原话原样落入 l1（或检索侧对 df=1 长 token 设 idf 上限），防「原话捷径」。
- 语义排序单独通道（不混入 BM25 分数，改两路融合/重排），避免量级不匹配。

---

## 5. 复现

```bash
# 1) 提取 query 集（依赖 ~/.pi/agent/sessions/--C--kaifa-PiDeck--/ 历史会话）
node scripts/extract-regression-queries.cjs   # 通用提取（30 条人工精选版见 build-regression-queries.cjs）
node scripts/build-regression-queries.cjs     # 精选 query 集 → scripts/.memtest/queries.json

# 2) 打包真实检索产物（与 npm run test:memory 相同方式）
npx esbuild src/main/memory/embeddingService.ts src/main/memory/memoryService.ts src/main/memory/vikingDb.ts \
  --bundle --platform=node --format=cjs --external:@huggingface/transformers --outdir=scripts/.memtest

# 3) 跑回归对比（自动复制真实库到 .memtest-db，不污染真实库）
node scripts/run-memory-regression.cjs        # → scripts/.memtest/regression-results.json + 控制台摘要
```

依赖：`node_modules/@huggingface/transformers`、`resources/models/Xenova/all-MiniLM-L6-v2`、真实记忆库 `C:/Users/123/AppData/Roaming/pi-desktop-dev/viking.db`。
