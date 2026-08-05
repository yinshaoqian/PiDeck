# 任务锚守卫（Task Anchor Guard）重构方案 v4

> 状态：已实施（v4 扩展已写入并同步）　日期：2026-08-04
> 本方案按用户最终需求重写；此前 v1/v2/v3 方案已全部否决并删除。

---

## 一、用户需求（原话，最终版）

> 「当我提出一个问题，你在解决它之前，先把任务给我写好更新到锚点中；
> 当你完成这个任务之后，对这个任务进行更新，标记完成。
> 但是我使用弱提示（提示词），模型不遵守规矩，所以我不打算用提示，所以打算使用 Hook 工具。」

拆解：

| # | 需求 | 强制点 |
|---|---|---|
| 1 | 用户提出问题 → agent **解决之前**，先把任务写进锚点（task_anchor add，doing） | 会话开始（新任务意图出现） |
| 2 | 任务完成 → agent 更新该任务**标记完成**（task_anchor update，done） | 会话接收/结束前 |
| 3 | 提示词是弱约束（模型不遵守）→ **用 Hook 强制**，不用提示 | 扩展 hook + 主进程兜底 |

**否决项（历史教训）**：
- ❌ v1：每个工具调用前都检查 task_anchor（「不做就无法执行」）——强制点错误，强拦截过度
- ❌ v2：每轮 message_end 附加提醒——噪声
- ❌ message_end 未过滤 role 替换——渲染崩溃事故根因

---

## 二、v4 设计

### 2.1 开始侧（强制登记）

```
input（用户消息到达）
  ├─ detectTaskIntent(text) == true（含任务动词）
  └─ hasOngoingTasks() == false（任务锚无对应进行中登记）
        → pendingRegistration = true
tool_call（非 task_anchor）
  └─ pendingRegistration == true（且 blockCount < MAX_BLOCK=2）
        → block 工具，reason：「先 task_anchor add 登记该任务」
task_anchor（add/list/update 任一）
  → pendingRegistration = false（登记即解除，后续工具零拦截）
```

**关键边界**（区别于 v1）：
- 仅「本轮用户消息含**新**任务意图 且 任务锚无对应登记」才拦；
- 普通问答轮、已有进行中任务的轮次 → **绝不拦**；
- 最多 block 2 次（防死锁），之后降级放行，交给主进程兜底。

### 2.2 完成侧（强制标记完成）

```
message_end（严格 role === "assistant"，绝不碰 user/toolResult）
  └─ hasOngoingTasks(本会话) == true（本会话有 doing 任务）
     └─ anchorMaintained == false（agent 未调用过 task_anchor）
        └─ doneReminded == false（本会话未提醒过）
           → 附加提醒一次：「任务已解决请 update 标记 done」
```

- **每会话最多一次**（doneReminded 去重），不产生每轮噪声；
- agent 只要调用过 task_anchor（add/update），即视为会维护，不再提醒；
- agent 坚持不维护 → 主进程 agent_settled 兜底补登记（不做自动 review 推进，状态由 agent 显式维护）。

### 2.3 移除清单

- tool_result 替换（v1）
- message_end 未过滤 role 的替换（v1 崩溃根因）
- 每轮 message_end 附加（v2 噪声）
- before_provider_request context-mode 过滤（v3 误判方向）

### 2.4 保留组件

| 组件 | 位置 | 说明 |
|---|---|---|
| 主进程 `enforceTaskAnchor` | `src/main/memory/taskAnchorGuard.ts` | agent_settled 自动补登记 doing + toast（【2026-08 修复】不再自动推进 review：agent_settled ≠ 任务完成，后台异步任务运行时会被误标；状态流转由 agent 显式维护），机制性强校验，不产生对话流噪声 |
| `task_anchor` 工具本体 | `pi-deck-task-anchor.ts` | 任务锚读写入口 |
| 任务锚文件 | `userData/task-anchors.json` | 数据源 |

---

## 三、实施记录

- [x] 删除 v2/v3 扩展（用户目录 + resources 源，备份 `/tmp/pideck-hook-backup/`）
- [x] v4 扩展重写：`resources/extensions/pi-deck-task-guard.ts` + `~/.pi/agent/extensions/pi-deck-task-guard.ts`（已同步，语法通过）
- [ ] 重启 dev 生效（当前运行进程内存仍为旧版，需重启加载 v4）
- [ ] 验证：
  1. 新任务消息 → 工具先被 block（提示登记）→ add 后正常执行
  2. 完成任务后未 update done → assistant 消息尾部提醒一次（仅一次）
  3. 普通问答 → 全程零拦截零提醒
  4. 已有进行中任务时发普通问答 → 零拦截零提醒
