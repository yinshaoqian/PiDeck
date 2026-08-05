/**
 * 语义检索服务 —— 基于 transformers.js 本地 embedding（all-MiniLM-L6-v2，384 维）
 *
 * 设计要点：
 *  - 纯本地推理（onnxruntime-node），模型文件放在模型目录（打包后随 extraResources 分发），
 *    不依赖任何远程 API——注入是每轮消息前的高频调用，远程 embedding 的延迟/成本不可接受。
 *  - 全链路降级：模型缺失/加载失败/推理异常都返回 null，调用方回退纯关键词检索，注入不受影响。
 *  - 预热模型：preload() fire-and-forget 加载模型并给库中无向量的节点批量补向量；
 *    query 向量按文本缓存，search 同步读缓存——首次查询纯 BM25，下一轮起语义生效。
 *  - 向量存储复用 viking_embeddings 表（JSON 文本列，node_id 主键）。
 */
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { VikingDb } from "./vikingDb";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

/** query 文本 → 向量 的内存缓存（search 同步读，避免每轮异步等待推理） */
const QUERY_CACHE = new Map<string, number[]>();
const QUERY_CACHE_MAX = 64;

/** 可选日志回调：主进程注入 AppLogger（console 不会进 app-*.log 文件，用户看不到） */
export type EmbeddingLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export class EmbeddingService {
  private pipe: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<FeatureExtractionPipeline | null> | null = null;
  private db: VikingDb;
  private modelDir: string;
  private logger: EmbeddingLogger | null;
  /** 语义就绪标志：模型加载成功且至少跑过一次推理 */
  private ready = false;

  constructor(db: VikingDb, modelDir: string, logger?: EmbeddingLogger) {
    this.db = db;
    this.modelDir = modelDir;
    this.logger = logger ?? null;
  }

  get isReady(): boolean {
    return this.ready && this.pipe !== null;
  }

  /** 余弦相似度（两向量已归一化时等价于点积） */
  static cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /** 懒加载模型：失败返回 null（降级），不抛出。initPromise 保证只初始化一次 */
  private async ensurePipe(): Promise<FeatureExtractionPipeline | null> {
    if (this.pipe) return this.pipe;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        // 动态导入：transformers.js 是 ESM，主进程（CJS 编译产物）需运行时动态加载。
        // 注意：env 必须取自同一个 mod 实例——require(ESM) 与 import() 会得到不同的模块实例，
        // 若用顶部静态 import 的 env 配置、用 mod.pipeline 推理，配置不会生效（实测模型路径回退默认）。
        const mod = await import("@huggingface/transformers");
        mod.env.allowRemoteModels = false; // 只用本地模型，杜绝运行时联网下载
        mod.env.allowLocalModels = true;
        mod.env.localModelPath = `${this.modelDir.replace(/[\\/]+$/, "")}/`;
        mod.env.cacheDir = null; // 不写模型缓存，模型目录就是唯一来源
        mod.env.useFSCache = false;
        this.pipe = await mod.pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
        // 管道就绪即视为可用（模型文件齐备）；embed 失败是单条文本的异常，不算未就绪
        this.ready = true;
        // 修复 C：语义就绪要可见（此前静默，15:42 会话无注入因模型未就绪且无任何提示）
        const okMsg = `[embedding] 语义模型加载成功: ${MODEL_ID} (${this.modelDir})`;
        this.logger?.info(okMsg);
        console.log(okMsg);
        return this.pipe;
      } catch (err) {
        // 模型文件缺失/onnx 加载失败：静默降级，不打断注入链路
        // 修复 C：降级记 warn，排查时不再靠猜
        const warnMsg = `[embedding] 语义模型加载失败，降级纯关键词检索: ${err instanceof Error ? err.message : String(err)}（模型目录: ${this.modelDir}）`;
        this.logger?.warn(warnMsg);
        console.warn(warnMsg);
        this.initPromise = null; // 允许下次重试（模型可能被补上）
        return null;
      }
    })();
    return this.initPromise;
  }

  /** 计算单条文本的归一化向量；失败返回 null */
  async embed(text: string): Promise<number[] | null> {
    const pipe = await this.ensurePipe();
    if (!pipe || !text.trim()) return null;
    try {
      const out = await pipe(text.slice(0, 512), { pooling: "mean", normalize: true });
      const data = Array.from(out.data as Float32Array);
      if (data.length !== EMBEDDING_DIM) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** 预热：加载模型 + 给库中无向量的节点补向量（幂等）。fire-and-forget 调用 */
  async preload(nodes: Array<{ id: string; text: string }>): Promise<void> {
    const pipe = await this.ensurePipe();
    if (!pipe) return;
    const existing = this.db.getAllEmbeddings();
    const missing = nodes.filter((n) => !existing.has(n.id));
    for (const node of missing) {
      const vec = await this.embed(node.text);
      if (vec) this.db.setEmbedding(node.id, vec);
    }
    const doneMsg = `[embedding] 预热完成: ${nodes.length - missing.length}/${nodes.length} 向量已就绪`;
    this.logger?.info(doneMsg);
    console.log(doneMsg);
  }

  /** 查询向量是否已有缓存（同步路径判断是否需要异步补算） */
  isQueryCached(text: string): boolean {
    return QUERY_CACHE.has(text);
  }

  /** 写入 query 向量缓存（async 检索路径用） */
  cacheQueryVector(text: string, vec: number[]): void {
    if (QUERY_CACHE.size >= QUERY_CACHE_MAX) QUERY_CACHE.delete(QUERY_CACHE.keys().next().value!);
    QUERY_CACHE.set(text, vec);
  }

  /**
   * 同步取 query 向量：命中缓存直接返回；未命中返回 null 并异步触发计算（下一轮生效）。
   * 保持 search 同步签名——注入是同步链路，语义检索不能阻塞它。
   */
  getQueryVectorSync(text: string): number[] | null {
    const hit = QUERY_CACHE.get(text);
    if (hit) return hit;
    // 异步补算并写缓存（不等待）
    void this.embed(text).then((vec) => {
      if (!vec) return;
      this.cacheQueryVector(text, vec);
    });
    return null;
  }

  /** 同步取节点向量（从库读） */
  getNodeVector(nodeId: string): number[] | null {
    return this.db.getEmbedding(nodeId);
  }

  /** 全库向量（预热/诊断用） */
  getAllVectors(): Map<string, number[]> {
    return this.db.getAllEmbeddings();
  }
}
