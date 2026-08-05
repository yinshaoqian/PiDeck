/**
 * Viking 记忆系统 —— LLM 提取与去重
 *
 * 完整复刻 Breezell memoryGenerationService 的核心流程：
 *  1. 对话压缩：从最后一个 user 消息起，保留 user/assistant，工具调用只留摘要
 *  2. LLM 提取：OpenViking prompt → ===MEMORY=== / ===SKILL=== 块（L0/L1/L2/PRIORITY/TAGS/ANCHOR）
 *  3. 相似候选：用候选 L0+L1 检索现有记忆
 *  4. LLM 去重：SKIP / CREATE(+delete_ids 矛盾删除) / MERGE(target+合并内容)
 *  5. 合并保护：合并后 < 原内容 70% 拒绝合并回退 CREATE；保留 revisionHistory
 *
 * LLM 走 pi 全局配置（~/.pi/agent/models.json + auth.json + settings.json），
 * 复用 ConfigManager 的读取逻辑；支持 OpenAI Chat Completions / Anthropic Messages / Gemini。
 */
import { net } from "electron";
import { ConfigManager } from "../config/ConfigManager";
import type { MemoryExtractInput, MemoryExtractionEvent, MemoryNode, MemoryPriority } from "../../shared/types";
import { MemoryService } from "./memoryService";

const EXTRACTION_SYSTEM_PROMPT = `你是 OpenViking 上下文提取助手，负责从对话中提取记忆（MEMORY）与技能（SKILL）。

## MEMORY = 持久知识
只提取：
- 用户亲口说出的偏好（在 L2 中引用用户原话）
- 项目约定、架构决策、技术约束（稳定事实）
绝不推断用户意图。用户没说过的话就不是记忆——把 AI 的推断写成“用户要求”是对记忆的曲解。

## SKILL = 操作经验与教训（这是让 agent 越用越聪明的关键）
提取可复用的经验，按优先级：
- LESSON（#lesson）：花费了时间的失误/失败——根因 + 避免重犯的具体规则。必须回答为什么发生 + 下次怎么做。这是价值最高的记忆类型。
- CASE（#case）：一个被解决的具体问题——尝试了什么、什么失败了、最终有效的修复。标签 #case 加结果（#solved 或 #failed_avoid）。
- PATTERN（#pattern）：值得复用的规律/坑——本仓库的怪癖、可靠好用的工具用法、报错恢复步骤。
优先提取与真实结果绑定的经验，而不是泛泛建议。一次应该避免的失败尝试与一次成功同样有价值。

## CAUSAL = 已定位根因并验证的调试案例（价值最高的召回项，Breezell entanglement 风格）
仅在对话是“定位到根因并验证了修复”的调试/排查会话时提取。没确认根因的调试会话不是 CAUSAL——宁可不出也不出半个案例。
- 症状：哪里出问题了，一句话。这是召回触发点（未来的会话按症状命中它）。
- 根因：机制 + 具体位置（组件/函数/文件:行号）——不是症状本身。
- 尝试与失败：尝试过什么、为什么没成功（简短）。
- 修复：最终有效的改动。
- 验证证据：修复被验证的具体证据（测试通过/报错消失/指标变化）。
L2 中必须包含以下五个字段行（机器可解析）：
症状: ...
根因: ...
尝试与失败: ...
修复: ...
验证证据: ...
当会话产生了已验证的因果链时，优先输出 CAUSAL 块而不是普通的 SKILL #case——结构化因果链可复用性高得多。

输出格式（严格 — 可输出 1 个 MEMORY 块、1 个 SKILL 块、1 个 CAUSAL 块、任意组合，或 "NO_EXTRACTION"）：

===MEMORY===
L0: 一句话摘要，50 字以内
L1: 2-5 条要点概述（共 500 字以内）
L2: 带上下文的完整详细内容
PRIORITY: P1|P2
TAGS: #标签1 #标签2 #标签3
ANCHOR: 一句话描述何时该召回这条记忆（触发场景，不是内容）

===SKILL===
L0: 一句话摘要，50 字以内
L1: 2-5 条要点概述（共 500 字以内）
L2: 完整详细内容：什么有效、什么失败、修复方案
PRIORITY: P1|P2
TAGS: #标签1 #标签2 #标签3
ANCHOR: 一句话描述何时该召回这条技能

===CAUSAL===
L0: 症状一句话，50 字以内（召回触发点）
L1: 2-3 条要点：根因 + 位置 + 一行修复（共 500 字以内）
L2: 因果链，必须包含症状/根因/尝试与失败/修复/验证证据五个字段行
PRIORITY: P1|P2
TAGS: #causal-case #标签2 #标签3
ANCHOR: 一句话描述何时该召回这个因果案例（触发场景）

优先级说明：
- P1：值得长期保留的稳定事实（用户偏好、项目约定、架构、活跃工作流）。自动提取的默认值。
- P2：短期/会话特有上下文、一次性修复。
- 绝不输出 P0。P0（永久置顶）仅限用户手动设置——自动提取不得创建永久记忆。

规则：
1. 没有值得沉淀的内容就回复 "NO_EXTRACTION"
2. 区分「过程日志」与「可复用方法」：做了什么、改了哪些文件、会话状态流转、构建输出、一次性调试过程（不记）；但「下次怎么修/怎么打包/怎么发布/怎么配置」是可复用方法（要记）。比如「执行了 npm run dist:win -- portable 且遇到 winCodeSign 符号链接报错，开启开发者模式后成功」——打包命令 + 踩坑解法是可复用 SKILL，不是过程日志。
3. 绝不把 AI 的推断、总结、建议写成用户要求或偏好。用户偏好必须是用户原话。拿不准用户是否说过，就跳过。
4. 拿不准时优先 NO_EXTRACTION——一条错误的记忆注入未来会话，比没有记忆更糟（用户原则：宁可不记也不记垃圾）。
5. 跳过一次性任务、琐碎改动、问候、情绪表达、闲聊；但「用户/Agent 花了大量时间、多次尝试才成功的事」绝不跳过——那是最高价值的 LESSON（多轮尝试 + 最终有效的解法 = 必须提取）。
6. 用具体事实，不要空泛建议
7. 语言跟随对话内容
8. SKILL 记录工具用法、报错修复、打包/发布/部署流程、环境配置、工作流发现；LESSON（#lesson）价值最高；CAUSAL（已验证的根因链）最可复用
9. 每种类型最多一个块
10. 本应标 P0 的，用 P1 代替
11. 长会话你只会看到一部分（分段输入）：每段独立判断，不要因为「前面/后面还有内容」而不提取——你看到的就是该段全部。

示例：
===SKILL===
L0: 记忆自动提取禁止把 AI 推断写成用户要求
L1:
- 教训：LLM 分析对话时会把「推断的用户偏好」写成「用户要求」，曲解用户
- 为什么：推断 ≠ 原话，提取模型难以区分「AI 总结」与「用户明确表达」
- 下次：MEMORY 只记用户原话明确的偏好；AI 推断/建议一律不记
L2:
自动提取记忆时，模型容易把对话中 AI 的演绎（如“用户要求记忆库保持干净”）当成用户原话记录，导致记忆库出现用户从未说过的主张。教训：MEMORY 必须引用用户实际说过的原话；AI 的推断、建议、总结一律不视为用户偏好。拿不准就输出 NO_EXTRACTION。
PRIORITY: P1
TAGS: #lesson #memory #extraction
ANCHOR: 运行记忆自动提取或审查记忆库内容质量时

===CAUSAL===
L0: 窗口关闭后任务锚丢失
L1:
- 根因：taskAnchorStore 未持久化，进程退出即清空
- 修复：主进程硬保证，关闭前先写盘
- 验证：重启后任务锚恢复
L2:
症状: 窗口关闭后任务锚丢失
根因: taskAnchorStore 未在主进程生命周期内持久化，close 事件后内存 Map 清空
尝试与失败: 仅靠提示词要求 agent 保存，不生效
修复: 主进程硬保证：关闭时先写盘再销毁
验证证据: 重启后任务锚完整恢复，多次验证通过
PRIORITY: P1
TAGS: #causal-case #task_anchor #persistence
ANCHOR: 用户报告任务锚丢失、重启后消失，或讨论记忆持久化时

===MEMORY===
L0: 项目使用 pnpm 与 PowerShell
L1:
- 包管理器：pnpm（非 npm）
- Shell：PowerShell（不支持 && 连接命令）
- 构建：tsup 打包 React 组件
L2:
项目使用 pnpm workspaces。开发环境是 Windows + PowerShell，不支持 && 连接命令，请用 ; 代替。
PRIORITY: P1
TAGS: #project_setup #build #shell
ANCHOR: 安装依赖、运行构建命令、或在项目中连接 shell 命令时`;

const DEDUP_SYSTEM_PROMPT = `You are a memory deduplication engine. Given a NEW candidate memory and a list of EXISTING similar memories, decide the best action.

## Decisions

- **SKIP**: The candidate is fully covered by an existing memory. No action needed.
- **CREATE**: The candidate covers a genuinely new topic not found in any existing memory. Create it as-is.
- **MERGE**: The candidate adds new information to an existing memory on the same topic. Merge them into one updated memory.

## Output format (STRICT JSON)

For SKIP:
{"decision":"skip","reason":"..."}

For CREATE (optionally delete existing memories the candidate makes WRONG/obsolete):
{"decision":"create","reason":"...","delete_ids":["<id of a now-contradicted existing memory>"]}
(delete_ids is OPTIONAL — include ONLY ids whose content the candidate factually supersedes/invalidates; omit it or use [] when nothing is contradicted. Do NOT delete merely-similar-but-still-true memories.)

For MERGE (you MUST include the merged content):
{"decision":"merge","target_id":"<id of existing memory to update>","reason":"...","merged":{"l0":"...","l1":"...","l2":"...","priority":"P1|P2","tags":["tag1","tag2"],"retrieval_anchor":"one sentence describing WHEN to recall this"}}

Rules:
1. MERGE l0/l1/l2 must combine ALL useful info from both old and new — do not drop old facts, EXCEPT facts the candidate supersedes (see rule 6).
2. Keep l0 under 50 chars, l1 under 500 chars.
3. Match the language of the existing memory.
4. When in doubt between CREATE and MERGE, prefer MERGE if topics overlap >50%.
5. Output ONLY valid JSON, no markdown fences, no extra text.
6. CONTRADICTION → resolve, don't accumulate. When the candidate conflicts with an existing memory (changed preference, reversed decision, corrected fact), pick the right tool:
   - The existing memory is now ENTIRELY wrong / obsolete → use CREATE and list its id in "delete_ids" so it is removed, then the corrected candidate is created fresh.
   - The existing memory is MOSTLY still true but has ONE contradicted detail → use MERGE and rewrite only that detail to the current truth.
   Never keep both contradictory claims as if both were valid.
7. Use MERGE for COMPATIBLE enrichment. Use delete_ids ONLY for outright contradiction.
8. NEVER promote to P0 in merged.priority — auto paths max out at P1.`;

const CONVERSATION_TOO_SHORT = "CONVERSATION_TOO_SHORT";
const NO_EXTRACTION = "NO_EXTRACTION";

const DISTILL_SYSTEM_PROMPT = `You are an agent-experience distillation engine. You receive an EXECUTION TRAJECTORY (the tool-call trace of one completed coding-agent task) and a list of EXISTING experiences. Decide whether the trajectory yields a REUSABLE operation rule ("experience") worth keeping.

An experience must be:
(a) reusable beyond this one task,
(b) grounded in what actually happened — especially failures and the fix that finally worked,
(c) actionable the next time a similar situation appears.

## Decisions
- SKIP: routine execution with no surprises, or the lesson is fully covered by an existing experience.
- CREATE: a genuinely new reusable rule emerged from this trajectory.
- MERGE: the trajectory refines or extends an existing experience on the same topic.

## Output format (STRICT JSON, no markdown fences)
{"decision":"skip","reason":"..."}
{"decision":"create","reason":"...","experience":{"l0":"one sentence under 50 chars","l1":"2-5 bullets under 500 chars","l2":"full rule: context, what failed, what worked, the exact recipe","priority":"P1|P2","tags":["tag1","tag2"],"retrieval_anchor":"one sentence: WHEN should this be recalled"}}
{"decision":"merge","target_id":"<id of existing experience>","reason":"...","experience":{...same shape as create...}}

Rules:
1. MOST trajectories should be SKIP — experiences are rare and high-value. A plain successful run with no failed attempts and no non-obvious insight is SKIP.
2. A failure followed by a working fix is the strongest CREATE signal.
3. When merging, l2 must keep ALL still-true facts from the existing experience and add the new insight.
4. Match the language of the trajectory content.
5. If the trajectory OUTCOME is "failed" (the task did NOT end in a working state), never distill a "recipe that works" from it. Only a warning-style lesson is allowed, and only when the root cause is unambiguous from the trace; when in doubt, SKIP — a wrong rule injected into future sessions is worse than no rule.
6. Output ONLY the JSON object.`;
const MAX_CONV_LEN = 8000;
const MAX_SINGLE_MSG = 600;
const MAX_DEDUP_SIMILAR = 5;
const MERGE_MIN_RATIO = 0.7; // 合并后内容不得 < 原内容 70%
const REVISION_KEEP = 3;

type ExtractedBlock = {
  l0: string;
  l1: string;
  l2: string;
  priority: "P1" | "P2";
  tags: string[];
  category: "memory" | "skill";
  retrievalAnchor?: string;
  /** 结构化因果链（causal-case）：调试会话定位根因并验证后，提取机需保留机器可读字段 */
  causal?: {
    symptom?: string;
    rootCause?: string;
    triedAndFailed?: string;
    fix?: string;
    verification?: string;
  };
};

type DedupDecision =
  | { decision: "skip"; reason?: string }
  | { decision: "create"; reason?: string; deleteIds?: string[] }
  | {
      decision: "merge";
      targetId: string;
      reason?: string;
      merged: {
        l0: string;
        l1: string;
        l2: string;
        priority: "P1" | "P2";
        tags: string[];
        retrievalAnchor?: string;
      };
    };

export class MemoryExtraction {
  constructor(
    private readonly config: ConfigManager,
    private readonly service: MemoryService,
    /** 结构化状态事件：start/progress/done/error，UI 据此区分进行中、完成与失败 */
    private readonly onEvent?: (ev: MemoryExtractionEvent) => void,
  ) {}

  /** 推送进度阶段文本（progress 事件） */
  private emitProgress(stage: string) {
    this.onEvent?.({ type: "progress", stage });
  }

  // ── 对话压缩（O/P 语义） ───────────────────────────────

  /**
   * 对话分段压缩：把长会话切成多个窗口（每窗口 ≤ MAX_CONV_LEN），覆盖全程而非仅尾部。
   * 根因（8/4 便携版打包记忆丢失）：旧实现只从最后一个 user 消息截取 tail——278 条消息的
   * 会话只有最后一段进提取器，中段的踩坑（打包 winCodeSign/NSIS）从未被 LLM 看到。
   * 现在按消息数均分窗口（≤3 段），每段独立压缩，提取器能看到 开头踩坑 → 中段失败 → 尾部结论。
   */
  private compressConversation(input: MemoryExtractInput): string[] {
    const msgs = input.messages;
    if (msgs.length === 0) return [];
    // 按字符预算切连续窗口（保持话题连续性）——均匀切会拆散连续踩坑过程。
    // 根因（8/4 打包知识丢失）：旧实现只保留会话最后一段，中段踩坑整体丢失。
    const MAX_WINDOWS = 8; // 每会话最多 8 个窗口（= 8 次 LLM 提取调用，低频轮询可接受）
    const totalLen = msgs.reduce((s, m) => s + String(m.displayContent ?? m.content ?? "").length, 0);
    // 预算：正常 7000；若按 7000 会超过 8 窗口，则放大预算让窗口数 ≤ 8（长窗口输入 LLM 仍可接受）
    const budget = Math.max(MAX_CONV_LEN - 1000, Math.ceil(totalLen / MAX_WINDOWS));
    const windows: string[] = [];
    let current: MemoryExtractInput["messages"] = [];
    let currentLen = 0;
    for (const m of msgs) {
      const len = String(m.displayContent ?? m.content ?? "").length;
      if (current.length > 0 && currentLen + len > budget) {
        const text = this.compressSegment(current, budget);
        if (text.length >= 30) windows.push(text);
        current = [];
        currentLen = 0;
      }
      current.push(m);
      currentLen += len;
    }
    if (current.length > 0) {
      const text = this.compressSegment(current, budget);
      if (text.length >= 30) windows.push(text);
    }
    return windows;
  }

  /**
   * 对一段消息执行压缩：整段消息生成 parts（不再从最后一个 user 截取——那是旧版「只要最近结论」
   * 的设计，多窗口分段后会导致每窗口只保留尾部几条，中部踩坑全丢）。
   * 预算填充：① 尾部结论优先 ② 剩余预算从头连续补充，保证前/中/后都有内容。
   */
  private compressSegment(msgs: MemoryExtractInput["messages"], budget = MAX_CONV_LEN): string {
    const parts: Array<{ text: string; priority: number }> = [];

    for (const m of msgs) {
      if (m.role === "user") {
        if (m.isHidden) continue;
        const text = this.clean(String(m.displayContent ?? m.content ?? ""));
        if (text) parts.push({ text: `USER: ${text}`, priority: 3 });
      } else if (m.role === "assistant") {
        const text = this.clean(String(m.displayContent ?? ""));
        if (text) parts.push({ text: `ASSISTANT: ${text}`, priority: 2 });
      } else if (m.role === "tool" || m.role === "toolResult") {
        const brief = this.toolBrief(m);
        if (brief) parts.push({ text: brief, priority: 1 });
      }
    }
    if (parts.length === 0) return "";

    // 预算填充：① 尾部结论优先 ② 剩余预算从头连续填充（步长 1）——
    // 步长 >1 会跳过部分内容（如打包 portable 消息恰在奇数位被漏掉）
    const high = parts.filter((p) => p.priority >= 2);
    const kept = new Set<{ text: string; priority: number }>();
    let used = 0;
    for (let i = high.length - 1; i >= 0 && used < budget; i--) {
      const p = high[i];
      if (used + p.text.length < budget) {
        kept.add(p);
        used += p.text.length + 2;
      }
    }
    for (let i = 0; i < high.length && used < budget; i++) {
      const p = high[i];
      if (!kept.has(p) && used + p.text.length < budget) {
        kept.add(p);
        used += p.text.length + 2;
      }
    }
    const low = parts.filter((p) => p.priority < 2);
    const lowCountByTool = new Map<string, number>();
    for (const p of low) {
      const name = p.text.match(/^TOOL:\s*(\S+)/)?.[1] ?? "";
      lowCountByTool.set(name, (lowCountByTool.get(name) ?? 0) + 1);
    }
    const omitted = low.filter((p) => !kept.has(p)).length;
    const summary =
      omitted > 0
        ? `[${omitted} tool calls omitted: ${[...lowCountByTool.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}]`
        : "";
    const ordered: string[] = [];
    for (const p of parts) {
      if (kept.has(p)) ordered.push(p.text);
    }
    if (summary && !ordered.includes(summary)) ordered.push(summary);
    return ordered.join("\n\n");
  }

  private clean(text: string): string {
    return text.replace(/\[\[TAG:[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_SINGLE_MSG);
  }

  private toolBrief(m: MemoryExtractInput["messages"][number]): string {
    const params = (m.params ?? m.rawParams ?? {}) as Record<string, unknown>;
    // 优先提取有语义价值的参数（命令/路径/查询等），与 Breezell 的字段白名单一致
    const pathVal = params.path ?? params.file_path ?? params.file ?? params.uri ?? params.oldUri ?? params.newUri ?? params.command ?? params.pattern ?? params.query ?? params.terminalId ?? params.url ?? params.name;
    let p = "";
    if (typeof pathVal === "string") p = pathVal;
    else if (pathVal && typeof pathVal === "object") {
      const o = pathVal as { fsPath?: string; path?: string; oldUri?: { fsPath?: string }; newUri?: { fsPath?: string } };
      p = o.fsPath ?? o.path ?? o.oldUri?.fsPath ?? o.newUri?.fsPath ?? "";
    }
    const contentLen = typeof m.content === "string" ? m.content.length : 0;
    const bits: string[] = [];
    if (p) bits.push(`path=${p}`);
    if (contentLen > 0) bits.push(`output=${contentLen} chars`);
    return `TOOL: ${m.name ?? "tool"}${bits.length > 0 ? ` | ${bits.join(" | ")}` : ""}`;
  }

  // ── LLM 调用 ──────────────────────────────────────────

  /** 解析 pi 配置，构造可用的模型端点；返回 null 表示未配置 */
  private async resolveModel(): Promise<{ provider: string; model: string; baseUrl: string; apiKey: string; api: string } | null> {
    const [models, auth, settings] = await Promise.all([
      this.config.getModelsConfig(),
      this.config.getAuthConfig(),
      this.config.getSettingsConfig(),
    ]);
    const providers = models.parsed.providers ?? {};
    const names = Object.keys(providers);
    if (names.length === 0) return null;

    // 优先 settings.json 的默认选择
    const s = settings.parsed as { defaultProvider?: string; defaultModel?: string; providerDefaultModel?: Record<string, string> };
    let providerName = s.defaultProvider && providers[s.defaultProvider] ? s.defaultProvider : names[0];
    const provider = providers[providerName];
    let modelId = s.providerDefaultModel?.[providerName] ?? s.defaultModel;
    if (!modelId || !provider.models.some((m) => m.id === modelId)) {
      modelId = provider.models[0]?.id;
    }
    if (!modelId) return null;

    const authKey = auth.parsed[providerName]?.key ?? provider.apiKey ?? "";
    const baseUrl = provider.baseUrl ?? (provider.api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
    const api = this.normalizeApi(provider.api);
    if (!baseUrl || !authKey) return null;
    return { provider: providerName, model: modelId, baseUrl, apiKey: authKey, api };
  }

  private normalizeApi(api?: string): string {
    switch (api) {
      case "anthropic":
      case "anthropic-messages":
        return "anthropic-messages";
      case "openai-responses":
      case "openai-codex-responses":
        return "openai-responses";
      case "google-generative-ai":
        return "google-generative-ai";
      default:
        return "openai-completions";
    }
  }

  /** 调 LLM 聊天补全（兼容三种 API），返回完整文本；content 为空时加大 max_tokens 重试一次 */
  private async chat(
    model: { baseUrl: string; apiKey: string; api: string; model: string },
    system: string,
    user: string,
  ): Promise<string> {
    for (const attempt of [1, 2]) {
      const maxTokens = attempt === 1 ? 4096 : 8192;
      const text = await this.chatOnce(model, system, user, maxTokens);
      if (text && text.trim()) return text;
      // reasoning 模型（如 deepseek-v4-flash）token 不足时 content 可能为空，重试加大预算
      if (attempt === 1) {
        this.emitProgress("LLM 返回为空，加大 token 预算重试…");
      }
    }
    return "";
  }

  private async chatOnce(
    model: { baseUrl: string; apiKey: string; api: string; model: string },
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<string> {
    const base = model.baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      if (model.api === "anthropic-messages") {
        const res = await net.fetch(`${base.replace(/\/v1$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": model.apiKey,
            "anthropic-version": "2023-06-01",
            "User-Agent": "anthropic-sdk-typescript/0.27.3",
          },
          body: JSON.stringify({
            model: model.model,
            system,
            messages: [{ role: "user", content: user }],
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        return (data.content ?? []).map((c) => c.text ?? "").join("");
      }

      if (model.api === "google-generative-ai") {
        const res = await net.fetch(
          `${base}/v1beta/models/${model.model}:generateContent?key=${encodeURIComponent(model.apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
              generationConfig: { maxOutputTokens: maxTokens },
            }),
            signal: controller.signal,
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      }

      // openai-completions 默认
      const res = await net.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${model.apiKey}`,
          "User-Agent": "OpenAI/JS 6.26.0",
        },
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── 提取 ──────────────────────────────────────────────

  /** 主入口：分析会话 → 提取 → 去重 → 落库；返回本次新增/合并结果 */
  async analyzeAndSave(input: MemoryExtractInput): Promise<{
    status: "saved" | "no_extraction" | "too_short" | "no_model" | "error";
    created?: number;
    merged?: number;
    skipped?: number;
    message?: string;
  }> {
    this.onEvent?.({ type: "start", stage: "准备分析会话…" });
    const model = await this.resolveModel();
    if (!model) {
      this.onEvent?.({ type: "error", message: "未检测到可用的 LLM 配置（~/.pi/agent/models.json + auth.json）" });
      return { status: "no_model", message: "未检测到可用的 LLM 配置（~/.pi/agent/models.json + auth.json）" };
    }

    const convs = this.compressConversation(input);
    if (convs.length === 0 || convs.every((c) => c.length < 30)) {
      this.onEvent?.({ type: "done", created: 0, merged: 0, skipped: 0, message: "对话太短，无可提取内容" });
      return { status: "too_short", message: "对话太短，无可提取内容" };
    }

    this.emitProgress("调用 LLM 提取记忆…");
    // 多窗口提取：长会话分段（≤3 窗口）分别提取，合并所有块后统一去重保存。
    // 旧实现只提取尾部一段——中段的踩坑/失败过程（如打包 winCodeSign）被整体丢弃。
    const allBlocks: ExtractedBlock[] = [];
    for (let wi = 0; wi < convs.length; wi++) {
      const conv = convs[wi];
      let raw: string;
      try {
        raw = (await this.chat(model, EXTRACTION_SYSTEM_PROMPT, conv)).trim();
      } catch (e) {
        const msg = `LLM 调用失败（窗口 ${wi + 1}/${convs.length}）：${e instanceof Error ? e.message : String(e)}`;
        this.onEvent?.({ type: "error", message: msg });
        return { status: "error", message: msg };
      }

      const normalized = raw.toUpperCase();
      if (normalized.includes("NO_EXTRACTION") || raw === "") {
        continue; // 该窗口无值得沉淀的内容，继续下一窗口
      }
      if (normalized.includes("CONVERSATION_TOO_SHORT")) {
        continue;
      }

      const blocks = this.parseExtraction(raw);
      if (blocks.length === 0) {
        const msg = "LLM 返回格式无法解析，请重试";
        this.onEvent?.({ type: "error", message: msg });
        return { status: "error", message: msg };
      }
      allBlocks.push(...blocks);
    }
    if (allBlocks.length === 0) {
      this.onEvent?.({ type: "done", created: 0, merged: 0, skipped: 0, message: "本次会话没有值得沉淀的内容" });
      return { status: "no_extraction", message: "本次会话没有值得沉淀的内容" };
    }

    let created = 0;
    let merged = 0;
    let skipped = 0;
    for (const block of allBlocks) {
      this.emitProgress(`去重中：${block.l0.slice(0, 40)}…`);
      const result = await this.dedupAndSave(block, input);
      if (result === "created") created++;
      else if (result === "merged") merged++;
      else if (result === "skipped") skipped++;
    }
    const message = `新增 ${created} 条、合并 ${merged} 条、跳过 ${skipped} 条`;
    this.onEvent?.({ type: "done", created, merged, skipped, message });
    return {
      status: "saved",
      created,
      merged,
      skipped,
      message,
    };
  }

  // ── 轨迹捕获 + 经验蒸馏（完整版，复刻 Breezell captureTrajectoryAndDistill） ──

  /**
   * 从会话消息提取工具调用轨迹（仅内存），再用 LLM 蒸馏可复用的 experience（操作经验）。
   * 返回 { trajectoryId, experienceId }，其中 trajectoryId 恒为 null。
   *
   * 【重要：轨迹节点不再落库】轨迹本质是会话过程记录（用户原话 + 工具序列），
   * 对后续会话没有复用价值——此前每次会话结束都自动存一条轨迹节点（P2，上限 20 条），
   * L0 直接取用户最后一条消息原文（如「崩了！！！」），把记忆库灌成原文堆。
   * 用户明确要求「没有用的话宁愿不记，也不能瞎往里放」，因此只保留蒸馏出的
   * experience（有复用价值的操作经验），轨迹本身不再写入 viking_nodes。
   * 存量轨迹仍展示在「轨迹」tab（由用户手动清理），新会话不再新增。
   */
  async captureTrajectoryAndDistill(input: MemoryExtractInput): Promise<{ trajectoryId: string | null; experienceId: string | null }> {
    const result = { trajectoryId: null as string | null, experienceId: null as string | null };
    const traj = this.extractTrajectory(input.messages ?? []);
    if (!traj) return result;

    // LLM 蒸馏经验（失败静默，不影响主流程；错误已由 chat 重试机制兜底）
    try {
      result.experienceId = await this.distillExperience(traj, input);
    } catch {
      /* 蒸馏失败不影响 */
    }
    return result;
  }

  /** 从消息提取结构化轨迹；工具调用 < 2 次返回 null */
  private extractTrajectory(msgs: MemoryExtractInput["messages"]): {
    goal: string;
    outcome: "success" | "recovered" | "failed";
    l1: string;
    l2: string;
    toolNames: string[];
    errorSnippets: string[];
  } | null {
    // 最后 user 消息 → GOAL
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user" && !msgs[i].isHidden) {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return null;
    const goal = this.clean(String(msgs[lastUserIdx].displayContent ?? msgs[lastUserIdx].content ?? "")).slice(0, 240);
    if (!goal) return null;

    const steps: string[] = [];
    const toolNames: string[] = [];
    const errorSnippets: string[] = [];
    let errors = 0;
    let okState = true;

    for (const m of msgs.slice(lastUserIdx)) {
      if (m.role !== "tool" || m.type === "tool_request" || m.type === "running_now") continue;
      const name = String(m.name ?? "tool");
      const brief = this.toolBrief(m);
      toolNames.push(name);
      let status: string;
      if (m.type === "success") {
        status = "ok";
        okState = true;
      } else if (m.type === "rejected") {
        status = "rejected by user";
        okState = false;
      } else {
        status = "ERROR";
        errors++;
        okState = false;
        const snippet = this.clean(String(m.result ?? m.content ?? "")).slice(0, 200);
        if (snippet && errorSnippets.length < 3) errorSnippets.push(`${name}: ${snippet}`);
      }
      steps.push(`${steps.length + 1}. ${name}${brief ? `(${brief.replace(/^TOOL: \S+ \| /, "")})` : ""} → ${status}`);
    }
    if (steps.length < 2) return null;

    const outcome: "success" | "recovered" | "failed" = errors === 0 ? "success" : okState ? "recovered" : "failed";

    // 最后 assistant 文本 → FINAL
    let final = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        final = this.clean(String(msgs[i].displayContent ?? "")).slice(0, 300);
        if (final) break;
      }
    }

    // 25 步截断：前 15 + 省略 + 后 10
    let stepText: string;
    if (steps.length > 25) {
      stepText = [...steps.slice(0, 15), `... (${steps.length - 25} steps elided) ...`, ...steps.slice(-10)].join("\n");
    } else {
      stepText = steps.join("\n");
    }

    const uniqueTools = [...new Set(toolNames)].slice(0, 8).join(", ");
    const l1 = `${outcome}; ${steps.length} tool calls (${errors} errors); tools: ${uniqueTools}`.slice(0, 480);
    let l2 = [
      `GOAL: ${goal}`,
      `OUTCOME: ${outcome} (${steps.length} tool calls, ${errors} errors)`,
      "STEPS:",
      stepText,
      ...(errorSnippets.length > 0 ? ["ERRORS:", ...errorSnippets.map((s) => `- ${s}`)] : []),
      ...(final ? [`FINAL: ${final}`] : []),
    ].join("\n");
    if (l2.length > 3500) l2 = l2.slice(0, 3500) + "\n... (truncated)";

    return { goal, outcome, l1, l2, toolNames, errorSnippets };
  }

  /** 轨迹上限：每个 workspace 只保留最近 20 条 trajectory */
  /** LLM 蒸馏：轨迹 → 可复用经验（SKIP / CREATE / MERGE） */
  private async distillExperience(
    traj: { goal: string; outcome: string; l1: string; l2: string; toolNames: string[]; errorSnippets: string[] },
    input: MemoryExtractInput,
  ): Promise<string | null> {
    const model = await this.resolveModel();
    if (!model) return null;

    // 相似经验候选：goal + tools + errors 检索 skill 类，排除 trajectory
    const queryText = `${traj.goal} ${[...new Set(traj.toolNames)].join(" ")} ${traj.errorSnippets.join(" ")}`.slice(0, 240);
    const similar = this.service
      .search(queryText, { scope: "workspace", workspaceId: input.workspaceId ?? null, category: "skill", topK: 5, level: "l2" })
      .filter((r) => r.score > 0 && r.node.metadata?.kind !== "trajectory")
      .map((r) => r.node);

    const existingText =
      similar.length > 0
        ? similar.map((n, i) => `[${i + 1}] id=${n.id}\n  L0: ${n.l0}\n  L1: ${n.l1}\n  L2: ${n.l2.slice(0, 800)}`).join("\n\n")
        : "(none)";
    const user = `## TRAJECTORY\n${traj.l2}\n\n## EXISTING EXPERIENCES\n${existingText}\n\nDecide:`;

    let raw: string;
    try {
      raw = await this.chat(model, DISTILL_SYSTEM_PROMPT, user);
    } catch {
      return null;
    }

    const exp = this.parseDistill(raw, similar);
    if (!exp) return null;
    if (exp.decision === "skip") return null;

    // 归一化经验字段
    const g = {
      l0: this.clean(exp.experience.l0).slice(0, 80) || traj.goal.slice(0, 60),
      l1: this.clean(exp.experience.l1).slice(0, 500) || traj.l1,
      l2: this.clean(exp.experience.l2) || traj.l2,
      // 失败的轨迹只能产出警示型经验（P2）；成功经验可 P1
      priority: traj.outcome === "failed" ? ("P2" as const) : (exp.experience.priority === "P2" ? ("P2" as const) : ("P1" as const)),
      tags: Array.isArray(exp.experience.tags) ? exp.experience.tags.filter((t: unknown) => typeof t === "string").slice(0, 10) : [],
      retrievalAnchor: typeof exp.experience.retrievalAnchor === "string" ? exp.experience.retrievalAnchor : undefined,
    };

    if (exp.decision === "merge") {
      const target = similar.find((n) => n.id === exp.targetId);
      if (target) {
        const ok = await this.mergeInto(
          target,
          {
            l0: g.l0,
            l1: g.l1,
            l2: g.l2,
            priority: g.priority,
            tags: g.tags,
            retrievalAnchor: g.retrievalAnchor,
          },
          { ...g, category: "skill", source: "auto", threadId: input.threadId, workspaceId: input.workspaceId ?? null },
        );
        if (ok) return target.id;
      }
    }

    const node = await this.service.addNode({
      ...g,
      category: "skill",
      source: "auto",
      threadId: input.threadId,
      workspaceId: input.workspaceId ?? null,
      metadata: { kind: "experience", retrievalAnchor: g.retrievalAnchor },
    });
    return node.id;
  }

  /** 解析蒸馏决策 JSON：{decision: skip|create|merge, reason, experience:{l0,l1,l2,priority,tags,retrieval_anchor}, target_id} */
  private parseDistill(raw: string, similar: Array<{ id: string }>): {
    decision: "skip" | "create" | "merge";
    targetId?: string;
    experience: { l0: string; l1: string; l2: string; priority: string; tags: string[]; retrievalAnchor?: string };
  } | null {
    try {
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      const decision = String(obj.decision ?? "skip").toLowerCase();
      if (decision !== "skip" && decision !== "create" && decision !== "merge") return null;
      const exp = obj.experience as Record<string, unknown> | undefined;
      if (!exp || typeof exp.l0 !== "string") return null;
      if (decision === "merge") {
        const targetId = String(obj.target_id ?? "");
        if (!targetId || !similar.some((n) => n.id === targetId)) return null;
        return {
          decision: "merge",
          targetId,
          experience: {
            l0: String(exp.l0),
            l1: String(exp.l1 ?? exp.l0),
            l2: String(exp.l2 ?? exp.l1 ?? exp.l0),
            priority: exp.priority === "P2" ? "P2" : "P1",
            tags: Array.isArray(exp.tags) ? exp.tags.filter((t): t is string => typeof t === "string") : [],
            retrievalAnchor: typeof exp.retrieval_anchor === "string" ? exp.retrieval_anchor : undefined,
          },
        };
      }
      return {
        decision: decision as "skip" | "create",
        experience: {
          l0: String(exp.l0),
          l1: String(exp.l1 ?? exp.l0),
          l2: String(exp.l2 ?? exp.l1 ?? exp.l0),
          priority: exp.priority === "P2" ? "P2" : "P1",
          tags: Array.isArray(exp.tags) ? exp.tags.filter((t): t is string => typeof t === "string") : [],
          retrievalAnchor: typeof exp.retrieval_anchor === "string" ? exp.retrieval_anchor : undefined,
        },
      };
    } catch {
      return null;
    }
  }

  // ── 去重与落库 ────────────────────────────────────────

  private async dedupAndSave(
    block: ExtractedBlock,
    input: MemoryExtractInput,
  ): Promise<"created" | "merged" | "skipped"> {
    const candidate = {
      l0: block.l0,
      l1: block.l1,
      l2: block.l2,
      priority: block.priority === "P2" ? ("P2" as const) : ("P1" as const),
      tags: block.tags,
      category: block.category,
      source: "conversation" as const,
      threadId: input.threadId,
      workspaceId: input.workspaceId ?? null,
      // causal-case：结构化因果链随 metadata 落库，触发式注入/索引可直接读取；
      // 普通块保留 retrievalAnchor 即可。
      metadata: block.causal
        ? { kind: "causal-case" as const, causal: block.causal, ...(block.retrievalAnchor ? { retrievalAnchor: block.retrievalAnchor } : {}) }
        : block.retrievalAnchor ? { retrievalAnchor: block.retrievalAnchor } : undefined,
    };

    // 相似候选：L0+L1 检索
    const similar = this.service
      .search(`${block.l0} ${block.l1}`, {
        scope: "workspace",
        workspaceId: candidate.workspaceId,
        category: block.category,
        topK: MAX_DEDUP_SIMILAR,
        level: "l2",
      })
      .filter((r) => r.score > 0)
      .map((r) => r.node);

    if (similar.length === 0) {
      await this.service.addNode(candidate);
      return "created";
    }

    // LLM 去重决策
    const model = await this.resolveModel();
    let decision: DedupDecision;
    if (!model) {
      decision = { decision: "create", reason: "no model for dedup" };
    } else {
      const existingText = similar
        .map((n, i) => `[${i + 1}] id=${n.id} category=${n.category}\n  L0: ${n.l0}\n  L1: ${n.l1}\n  L2: ${n.l2.slice(0, 800)}`)
        .join("\n\n");
      const user = `## NEW CANDIDATE (${candidate.category})\nL0: ${candidate.l0}\nL1: ${candidate.l1}\nL2: ${candidate.l2}\nPRIORITY: ${candidate.priority}\nTAGS: ${candidate.tags.map((t) => `#${t}`).join(" ")}\n\n## EXISTING MEMORIES\n${existingText}\n\nDecide:`;
      try {
        const raw = await this.chat(model, DEDUP_SYSTEM_PROMPT, user);
        decision = this.parseDedup(raw, similar);
      } catch {
        decision = { decision: "create", reason: "dedup call failed" };
      }
    }

    switch (decision.decision) {
      case "skip":
        return "skipped";
      case "merge": {
        const target = similar.find((n) => n.id === decision.targetId);
        if (target && decision.merged?.l0) {
          const mergedOk = await this.mergeInto(target, decision.merged, candidate);
          return mergedOk ? "merged" : "created";
        }
        await this.service.addNode(candidate);
        return "created";
      }
      case "create":
      default: {
        if (decision.deleteIds?.length) {
          await this.service.removeNode(decision.deleteIds[0]);
        }
        await this.service.addNode(candidate);
        return "created";
      }
    }
  }

  /** 合并保护：合并后 < 原 70% 拒绝并回退 create；保留 revisionHistory */
  private async mergeInto(
    target: MemoryNode,
    merged: { l0: string; l1: string; l2: string; priority: "P1" | "P2"; tags: string[]; retrievalAnchor?: string },
    candidate: Parameters<MemoryService["addNode"]>[0],
  ): Promise<boolean> {
    const oldLen = (target.l2 ?? "").length;
    const newLen = (merged.l2 ?? "").length;
    if (oldLen > 0 && newLen < oldLen * MERGE_MIN_RATIO) {
      // 合并会丢信息 → 拒绝，保留旧记忆，另建新记忆
      await this.service.addNode(candidate);
      return false;
    }
    const meta = (target.metadata ?? {}) as Record<string, unknown>;
    const history = Array.isArray(meta.revisionHistory) ? meta.revisionHistory : [];
    const now = Date.now();
    const nextHistory = [
      ...history.slice(-(REVISION_KEEP - 1)),
      {
        l0: target.l0,
        l1: target.l1,
        l2: target.l2,
        priority: target.priority,
        tags: target.tags,
        supersededAt: now,
        sourceL2: candidate.l2,
        sourceThreadId: candidate.threadId,
      },
    ];
    const priority: MemoryPriority = target.priority === "P0" ? "P0" : merged.priority;
    await this.service.updateNode(target.id, {
      l0: merged.l0,
      l1: merged.l1,
      l2: merged.l2,
      priority,
      tags: merged.tags,
      metadata: {
        ...meta,
        retrievalAnchor: merged.retrievalAnchor ?? (typeof meta.retrievalAnchor === "string" ? meta.retrievalAnchor : undefined),
        revisionHistory: nextHistory,
        updatedAt: now,
      },
    });
    return true;
  }

  // ── 解析 ──────────────────────────────────────────────

  /** 解析 ===MEMORY=== / ===SKILL=== / ===CAUSAL=== 块 */
  private parseExtraction(raw: string): ExtractedBlock[] {
    const blocks: ExtractedBlock[] = [];
    const re = /===\s*(\w+)\s*===([\s\S]*?)(?====\s*\w+\s*===|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const kind = m[1].toUpperCase();
      if (kind !== "MEMORY" && kind !== "SKILL" && kind !== "CAUSAL") continue;
      const body = m[2].trim();
      const l0m = body.match(/^L0:\s*(.+)$/m);
      if (!l0m) continue;
      const l1m = body.match(/^L1:\s*\n?([\s\S]*?)(?=^L2:|^PRIO(?:RITY|TIRY|RTIY):|^TAGS:|^ANCHOR:)/m);
      const l2m = body.match(/^L2:\s*\n?([\s\S]*?)(?=^PRIO(?:RITY|TIRY|RTIY):|^TAGS:|^ANCHOR:)/m);
      const pm = body.match(/^PRIO(?:RITY|TIRY|RTIY):\s*(P[012])/m);
      const tm = body.match(/^TAGS:\s*(.+)$/m);
      const am = body.match(/^ANCHOR:\s*(.+)$/m);
      const l0 = l0m[1].trim();
      const l1 = (l1m?.[1] ?? "").trim() || l0;
      const l2 = (l2m?.[1] ?? "").trim() || l1;
      const priority = pm?.[1] === "P2" ? "P2" : pm?.[1] === "P0" ? "P1" : "P1"; // P0 降级 P1
      const tags = (tm?.[1]?.match(/#(\w+)/g) ?? []).map((t) => t.slice(1));
      // CAUSAL 块：从 L2 提取结构化因果字段（SYMPTOM/ROOT_CAUSE/TRIED_AND_FAILED/FIX/VERIFIED_BY），
      // 存入 metadata.causal 供触发式注入格式化、L0 索引、召回展示直接使用。
      const isCausal = kind === "CAUSAL";
      const causal = isCausal ? this.parseCausalFields(l2) : undefined;
      blocks.push({
        l0,
        l1,
        l2,
        priority,
        tags: isCausal && !tags.includes("causal-case") ? ["causal-case", ...tags] : tags,
        category: "skill",
        retrievalAnchor: am?.[1]?.trim() || undefined,
        ...(causal ? { causal } : {}),
      });
    }
    return blocks;
  }

  /** 从 L2 文本提取结构化因果字段（Breezell entanglement 的 causal 链机器可读化）
   *  支持中英文标签（prompt 要求中文：症状/根因/尝试与失败/修复/验证证据；兼容英文兜底） */
  private parseCausalFields(l2: string): ExtractedBlock["causal"] {
    const labels: Array<[key: keyof NonNullable<ExtractedBlock["causal"]>, zh: string, en: string]> = [
      ["symptom", "症状", "SYMPTOM"],
      ["rootCause", "根因", "ROOT_CAUSE"],
      ["triedAndFailed", "尝试与失败", "TRIED_AND_FAILED"],
      ["fix", "修复", "FIX"],
      ["verification", "验证证据", "VERIFIED_BY"],
    ];
    const out: NonNullable<ExtractedBlock["causal"]> = {};
    for (const [key, zh, en] of labels) {
      const m = l2.match(new RegExp(`^(${zh}|${en}):\\s*(.+)$`, "m"));
      if (m?.[2]?.trim()) out[key] = m[2].trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** 解析去重 JSON 决策（容错：去掉 markdown 代码围栏） */
  private parseDedup(raw: string, similar: MemoryNode[]): DedupDecision {
    try {
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      const decision = String(obj.decision ?? "create").toLowerCase();
      if (decision === "skip") return { decision: "skip", reason: String(obj.reason ?? "") };
      if (decision === "merge") {
        const targetId = String(obj.target_id ?? "");
        const merged = obj.merged as Record<string, unknown> | undefined;
        if (targetId && similar.some((n) => n.id === targetId) && merged && typeof merged.l0 === "string") {
          const prio = merged.priority === "P2" ? "P2" : "P1";
          return {
            decision: "merge",
            targetId,
            reason: String(obj.reason ?? ""),
            merged: {
              l0: String(merged.l0),
              l1: String(merged.l1 ?? merged.l0),
              l2: String(merged.l2 ?? merged.l1 ?? merged.l0),
              priority: prio,
              tags: Array.isArray(merged.tags) ? merged.tags.filter((t) => typeof t === "string") : [],
              retrievalAnchor: typeof merged.retrieval_anchor === "string" ? merged.retrieval_anchor : undefined,
            },
          };
        }
      }
      // create
      const deleteIds = Array.isArray(obj.delete_ids)
        ? obj.delete_ids.filter((id): id is string => typeof id === "string" && similar.some((n) => n.id === id))
        : undefined;
      return { decision: "create", reason: String(obj.reason ?? ""), deleteIds: deleteIds && deleteIds.length > 0 ? deleteIds : undefined };
    } catch {
      return { decision: "create", reason: "failed to parse dedup response" };
    }
  }
}
