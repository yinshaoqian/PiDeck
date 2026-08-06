/**
 * PiDeck Image Read Extension（图片读取工具）
 *
 * 给 pi agent 暴露 img_read 工具：把一张图片交给 opencodego/mimo-v2.5 视觉模型理解，
 * 返回文本描述。用于「主模型不支持图片输入，但需要理解图片内容」的场景——
 * agent 拿到图片路径/base64 后调用本工具，由 mimo-v2.5 读取并返回描述文本。
 *
 * 关键背景（实测结论，2026-08-05）：
 * - opencode.ai/zen/go/v1 上 mimo-v2.5-pro 不支持图片输入（404: No endpoints found
 *   that support image input）；mimo-v2.5（无 pro）支持，且正确识别图片内容。
 * - API 为 OpenAI 兼容格式，需带浏览器 User-Agent，否则 Cloudflare 403(1010)。
 * - apiKey/baseUrl 优先从 ~/.pi/agent/models.json 的 opencodego provider 读取
 *   （与 PiDeck 模型配置同源），避免在扩展里硬编码密钥；找不到时回退
 *   OPENCODE_API_KEY 环境变量与默认 baseUrl。
 *
 * 用法（agent 侧）：
 *   img_read(path="C:/tmp/screenshot.png")
 *   img_read(data="<base64>", mimeType="image/png")
 *   img_read(path="...", question="这张图里有哪些 UI 元素？")
 *
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Type } from "typebox";

/** 默认视觉模型：mimo-v2.5（pro 端点实测不支持图片输入） */
const DEFAULT_MODEL = "mimo-v2.5";
/** 默认 API 端点（opencodego provider 的 baseUrl，OpenAI 兼容） */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
/** 图片最大字节数（10MB），超限直接报错避免超大请求体 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 视觉推理可能较慢，给足超时 */
const FETCH_TIMEOUT_MS = 120_000;
/** 浏览器 UA，绕开 Cloudflare 1010 拦截 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 从 ~/.pi/agent/models.json 读取 opencodego provider 的 apiKey/baseUrl */
function resolveOpencodeGoConfig(): { apiKey: string; baseUrl: string } {
	const envKey = process.env.OPENCODE_API_KEY;
	// 从 models.json 读 opencodego（PiDeck 模型配置里已配置的 provider）
	try {
		const modelsPath = join(homedir(), ".pi", "agent", "models.json");
		const raw = readFileSync(modelsPath, "utf8");
		const parsed = JSON.parse(raw) as {
			providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
		};
		const opencodeGo = parsed?.providers?.opencodego;
		if (opencodeGo?.apiKey) {
			return {
				apiKey: opencodeGo.apiKey,
				baseUrl: opencodeGo.baseUrl ?? DEFAULT_BASE_URL,
			};
		}
	} catch {
		// models.json 不可读时走环境变量/默认
	}
	if (envKey) {
		return { apiKey: envKey, baseUrl: DEFAULT_BASE_URL };
	}
	return { apiKey: "", baseUrl: DEFAULT_BASE_URL };
}

/** 把输入解析为 data URL：path（本地文件）或 data（base64 或 data URL） */
function resolveImageDataUrl(
	path?: string,
	data?: string,
	mimeType?: string,
): { dataUrl: string; bytes: number } | { error: string } {
	if (path) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(path);
		} catch (error) {
			return { error: `无法读取图片文件 ${path}: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (bytes.length === 0) return { error: `图片文件为空：${path}` };
		if (bytes.length > MAX_IMAGE_BYTES) {
			return { error: `图片过大（${(bytes.length / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB` };
		}
		const mime = mimeType || sniffMime(path);
		return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length };
	}
	if (data) {
		const trimmed = data.trim();
		if (trimmed.startsWith("data:")) {
			return { dataUrl: trimmed, bytes: Math.ceil((trimmed.length * 3) / 4) };
		}
		const mime = mimeType || "image/png";
		return { dataUrl: `data:${mime};base64,${trimmed}`, bytes: Math.ceil((trimmed.length * 3) / 4) };
	}
	return { error: "缺少图片输入：请传 path（本地图片路径）或 data（base64 图片数据）。" };
}

/** 按扩展名推断 mimeType */
function sniffMime(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".bmp")) return "image/bmp";
	return "image/png";
}

/** 用 node:http(s) 实现的简易 POST JSON 请求（Node 18 以下无全局 fetch 时回退） */
function httpJsonPost(
	url: string,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const isHttps = u.protocol === "https:";
		const doRequest = isHttps ? httpsRequest : httpRequest;
		const req = doRequest(
			{
				hostname: u.hostname,
				port: u.port || (isHttps ? 443 : 80),
				path: `${u.pathname}${u.search}`,
				method: "POST",
				headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
				);
				res.on("error", reject);
			},
		);
		req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

/** 调用 opencodego chat/completions，返回模型文本 */
async function callVisionModel(
	apiKey: string,
	baseUrl: string,
	model: string,
	dataUrl: string,
	question: string,
): Promise<{ text: string } | { error: string }> {
	if (!apiKey) {
		return { error: "缺少 API Key：models.json 的 opencodego provider 未配置 apiKey，且环境变量 OPENCODE_API_KEY 未设置。" };
	}
	const payload = {
		model,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: dataUrl } },
					{ type: "text", text: question },
				],
			},
		],
		max_tokens: 1024,
	};
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": UA,
	};
	try {
		// 优先全局 fetch（Node 22+）；老 Node 用 node:http(s) 回退，两者结果一致
		if (typeof globalThis.fetch === "function") {
			const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) {
				const bodyText = await res.text().catch(() => "");
				// 截断错误响应，避免把超长 upstream 报错灌回对话
				return { error: `视觉模型请求失败 HTTP ${res.status}: ${bodyText.slice(0, 400)}` };
			}
			const result = (await res.json()) as {
				choices?: Array<{ message?: { content?: unknown; reasoning?: string } }>;
			};
			return { text: parseCompletionText(result) };
		}
		const response = await httpJsonPost(
			`${baseUrl.replace(/\/+$/, "")}/chat/completions`,
			headers,
			JSON.stringify(payload),
			FETCH_TIMEOUT_MS,
		);
		if (response.status >= 400) {
			return { error: `视觉模型请求失败 HTTP ${response.status}: ${response.body.slice(0, 400)}` };
		}
		const result = JSON.parse(response.body) as {
			choices?: Array<{ message?: { content?: unknown; reasoning?: string } }>;
		};
		return { text: parseCompletionText(result) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof Error && error.name === "TimeoutError") {
			return { error: `视觉模型请求超时（${FETCH_TIMEOUT_MS / 1000}s）` };
		}
		return { error: `视觉模型请求失败: ${message}` };
	}
}

/** 从 chat/completions 响应中提取正文文本 */
function parseCompletionText(result: {
	choices?: Array<{ message?: { content?: unknown; reasoning?: string } }>;
}): string {
	const message = result.choices?.[0]?.message;
	const content = message?.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.map((item) =>
				typeof item === "object" && item !== null
					? String((item as Record<string, unknown>).text ?? "")
					: "",
			)
			.join("");
	}
	// 部分模型把正文放在 reasoning（思考块），content 为空时回退取 reasoning
	if (!text.trim()) {
		text = String(message?.reasoning ?? "");
	}
	return text.trim();
}

export default function (pi: { registerTool: (def: unknown) => void }) {
	pi.registerTool({
		name: "img_read",
		label: "PiDeck: 图片读取（opencodego/mimo-v2.5 视觉理解）",
		description:
			"把一张图片交给 opencodego/mimo-v2.5 视觉模型理解，返回文本描述。适用于主模型不支持图片输入、" +
			"但需要理解图片内容的场景（截图、UI 稿、报错图、文档图等）。" +
			"输入二选一：path（本地图片文件路径）或 data（base64 图片数据，也可直接传 data URL）；" +
			"question 可选，不传则默认详细描述图片内容（含文字、界面元素、颜色、布局）。" +
			"【注意】opencodego 上 mimo-v2.5-pro 不支持图片输入，本工具固定使用 mimo-v2.5（视觉能力已实测验证）。",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "本地图片文件路径，如 C:/tmp/screenshot.png" })),
			data: Type.Optional(Type.String({ description: "base64 图片数据或 data URL（与 path 二选一）" })),
			mimeType: Type.Optional(Type.String({ description: "图片 MIME 类型（data 输入无 data URL 前缀时使用），默认 image/png" })),
			question: Type.Optional(Type.String({ description: "询问图片的具体问题；缺省时要求详细描述图片内容" })),
		}),
		async execute(
			_toolCallId: string,
			params: { path?: string; data?: string; mimeType?: string; question?: string },
		) {
			const args = params ?? {};
			const question = (args.question ?? "").trim() || "请简明扼要地描述这张图片：先一句话概括，再分要点列出可见文字、主要元素、颜色与布局，控制在 150 字以内（不要逐字拆解字形/笔画）。";

			const imageResult = resolveImageDataUrl(args.path, args.data, args.mimeType);
			if ("error" in imageResult) {
				return {
					content: [{ type: "text", text: imageResult.error }],
					details: { ok: false, reason: "invalid_input" },
				};
			}

			const { apiKey, baseUrl } = resolveOpencodeGoConfig();
			const result = await callVisionModel(apiKey, baseUrl, DEFAULT_MODEL, imageResult.dataUrl, question);
			if ("error" in result) {
				return {
					content: [{ type: "text", text: result.error }],
					details: { ok: false, reason: "vision_failed" },
				};
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					ok: true,
					model: DEFAULT_MODEL,
					question,
					imageBytes: imageResult.bytes,
				},
			};
		},
	});
}
