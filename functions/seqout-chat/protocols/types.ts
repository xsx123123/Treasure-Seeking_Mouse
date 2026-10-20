// types.ts：protocols.io 领域对象类型定义（全具名 interface，禁止 any）。
// 五条类型级红线（spec §6.2~§6.4 数据约束的类型级落地，design §2.3.1）：
// 1. peer_reviewed 为 boolean | null 三态（true/false/null=未知），结构上不可退化为非空布尔——
//    上游响应条目无逐条评审字段（匿名实测确认），未筛选时如实为 null，禁止把未知标为已评审；
// 2. published_at / version_published_at / retrieved_at 三独立字段（时间三分，spec 6.3.6），
//    发布时间 / 版本时间 / 本次获取时间禁止互相冒充；
// 3. materials / steps 为保真收窄结构：字段全可空、无 AI 补全位，缺失 undefined 不虚构（spec 6.3.4）；
// 4. doi 为 string | null（剥 "dx.doi.org/" 前缀后的规范形；is_doi_reserved 且空 → null，未发布 DOI 不虚构）；
// 5. 信封条目数组固定命名 results（对齐 biomed/types.ts 约定，trimForLLM 的 data.results 瘦身分支零改动复用）。

export type ProtocolSource = 'protocols.io';

export interface ProtocolAuthor {
  /** 必有；上游 authors[]/creator 的 name */
  name: string;
  /** 上游可为 null，缺失置 undefined */
  affiliation?: string;
  username?: string;
  link?: string;
}

/** v3 搜索 items 条目 → 收窄 DTO（字段映射见 design §2.3.2 v3 表） */
export interface ProtocolSearchResult {
  /** 固定来源标识（spec 6.2.1） */
  source: ProtocolSource;
  /** String(id)——数字 ID 字符串化（spec 6.2.2 寻址锚点，卡片 accession 与去重键） */
  source_id: string;
  /** 稳定文本标识（存在才保留） */
  uri?: string;
  /** 原始语言标题，不翻译存储（spec 6.2.3） */
  title: string;
  /** 缺失为 []，不虚构（spec 6.2.4） */
  authors: ProtocolAuthor[];
  /** 创建者（与作者分立，上游独立字段） */
  creator?: ProtocolAuthor;
  /** 搜索条目无此字段时留 undefined */
  description?: string;
  /** 剥前缀后的规范 DOI；上游 null/空串 → null（spec 6.2.6 三态） */
  doi: string | null;
  /** https://www.protocols.io/view/<uri>（必填可回查，spec 6.2.7；uri 缺失走检索页兜底并标记） */
  source_url: string;
  /** 三态：peer_reviewed=1 筛选→true；=0 筛选→false；未筛选→null（上游无逐条字段，匿名实测） */
  peer_reviewed: boolean | null;
  /** 上游 number_of_steps（存在才保留） */
  steps_count?: number;
  /** 版本标识 */
  version_id?: number;
  /** published_on Unix 秒 → ISO 8601；0 或缺失 → undefined（published_on=0=未发布，不虚构） */
  published_at?: string;
  /** created_on Unix 秒 → ISO 8601 */
  created_at?: string;
  /** 本次真实获取时刻 ISO（缓存命中沿用原值，spec 6.2.11） */
  retrieved_at: string;
}

/** v4 详情 payload → 收窄 DTO（时间三分为类型级独立字段，design §2.3.2） */
export interface ProtocolDetail {
  source: ProtocolSource;
  /** String(payload.id) */
  source_id: string;
  guid?: string;
  uri?: string;
  title: string;
  /** payload.url（实测存在）；缺失回退 view/<uri> 构造 */
  url?: string;
  /** 剥前缀；is_doi_reserved===true 且 doi 空 → null（未发布 DOI 不虚构） */
  doi: string | null;
  authors: ProtocolAuthor[];
  creator?: ProtocolAuthor;
  /** markdown，≤2000 字符截断标记 */
  description?: string;
  /** markdown，≤1000 */
  before_start?: string;
  /** markdown，≤1000 */
  guidelines?: string;
  /** markdown，≤1000；非空时信封置 has_warning */
  warning?: string;
  /** 原始记录材料清单（可 []，保真收窄无补全） */
  materials: ProtocolMaterial[];
  /** 原文材料文本（交叉参照），≤800 */
  materials_text?: string;
  /** 概要层（design §2.1.3F）：序号+首行 ≤120 字，≤20 步 */
  steps_summary: ProtocolStepSummary[];
  /** stats.number_of_steps 权威值优先 */
  steps_count?: number;
  /** 版本概要 */
  versions?: ProtocolVersionSummary[];
  version_id?: number;
  /** —— 时间三分（spec 6.3.6）：发布 / 版本 / 获取三个独立字段 */
  published_at?: string;
  version_published_at?: string;
  retrieved_at: string;
  /** number_of_views/runs/votes/reagents/equipments 等，仅展示不推导（spec 6.3.7） */
  stats?: ProtocolStats;
}

export interface ProtocolVersionSummary {
  version_id: number;
  uri?: string;
  published_on?: string;
}

export interface ProtocolStepSummary {
  position: number;
  /** 首行文本 ≤120 字 */
  text: string;
}

/** 完整层（get_steps 信封，design §2.1.3F） */
export interface ProtocolStep {
  /** previous_id 链重建的序号（保序，spec 5.5.1 规则 2；孤儿步骤尾部如实保留） */
  position: number;
  /** markdown 步骤文本，单步 ≤600 截断标记 */
  text: string;
  /** 步骤内 reagent/equipment 实体名称列表（概要，不解析 Draft 细节） */
  components_summary?: string[];
  modified_on?: string;
}

/** 保真收窄（spec 5.5.1 规则 3）：只收窄不补全，存在才保留 */
export interface ProtocolMaterial {
  /** 上游形态判别：有 brand/specifications → equipment；其余 reagent；无法判别 → other */
  kind: 'reagent' | 'equipment' | 'other';
  name?: string;
  /** 货号 */
  sku?: string;
  vendor_name?: string;
  vendor_url?: string;
  /** 分子量（reagent） */
  mol_weight?: number;
  /** 材料外链 */
  url?: string;
  /** 规格（equipment） */
  specifications?: string;
}

export interface ProtocolStats {
  number_of_views?: number;
  number_of_steps?: number;
  number_of_votes?: number;
  number_of_runs?: number;
  number_of_reagents?: number;
  number_of_equipments?: number;
}

/** 搜索信封（零命中空矿：empty===true 由 isBusinessEmpty 计 empties 不计 errors） */
export interface ProtocolSearchEnvelope {
  results: ProtocolSearchResult[];
  /** pagination.total_results（上游提供时） */
  total: number;
  total_pages?: number;
  current_page?: number;
  page_size?: number;
  source: ProtocolSource;
  /** 零命中空矿标记 */
  empty?: boolean;
  /** 空矿/截断说明（含改写建议） */
  note?: string;
}

/** 详情信封（单元素数组——对齐 trimForLLM data.results 分支；404 走 not_found 不设 empty） */
export interface ProtocolDetailEnvelope {
  results: ProtocolDetail[];
  source: ProtocolSource;
  /** 详情 404 语义（design §2.1.3D：不计 errors 也不计 empties） */
  not_found?: boolean;
  note?: string;
}

/** 步骤信封（get_steps 完整层） */
export interface ProtocolStepsEnvelope {
  results: ProtocolStep[];
  materials: ProtocolMaterial[];
  materials_text?: string;
  before_start?: string;
  guidelines?: string;
  warning?: string;
  /** 警示存在性标记（截断不丢，spec 6.3.2） */
  has_warning?: boolean;
  /** 超 60 步截断标记 */
  steps_truncated?: boolean;
  /** 材料端点失败降级说明（spec 5.5.2 场景 2） */
  materials_note?: string;
  source: ProtocolSource;
  /** 步骤空（提纲型协议） */
  empty?: boolean;
  note?: string;
  /** 协议级上下文（卡片投影与回查锚点；信封字段只增不改）：get_steps 未携带完整详情时的最小标识集 */
  protocol?: ProtocolContext;
}

/** 协议最小上下文：get_steps 信封与卡片投影的回查锚点（source_id 必有，其余存在才保留） */
export interface ProtocolContext {
  id: string;
  title?: string;
  url?: string;
  doi?: string | null;
  version_id?: number;
  published_at?: string;
  retrieved_at: string;
}

// --- 常量（design §2.1.2 / §2.4 / §2.6） ---

/** 卡片 meta.source 与信封 source 的来源标识（卡片枚举值用 'protocol'，见 index.ts 投影） */
export const PROTOCOLS_SOURCE: ProtocolSource = 'protocols.io';

/** ASCII UA（踩坑记录：中文 UA 曾致 undici 抛 TypeError；复用 biomed/gene.ts 同款字符串） */
export const PROTOCOLS_UA = 'ResearchTreasureMouse/1.0';

/** 原文页面基址：https://www.protocols.io/view/<uri> */
export const PROTOCOLS_VIEW_BASE = 'https://www.protocols.io/view/';
/** 站点根（uri 缺失时的检索页兜底） */
export const PROTOCOLS_SITE_URL = 'https://www.protocols.io/';

/** 文本预算默认值（design §2.1.3F / §2.6，全部可被截断标记如实呈现） */
export const PROTOCOLS_TEXT_BUDGET = {
  /** 详情 description 截断上限 */
  description: 2000,
  /** before_start / guidelines / warning 各自截断上限 */
  beforeStart: 1000,
  guidelines: 1000,
  warning: 1000,
  /** materials_text 截断上限 */
  materialsText: 800,
  /** 单步 markdown 截断上限（完整层） */
  step: 600,
  /** 概要层单步首行截断上限 */
  stepSummary: 120,
  /** 概要层最多步数（超出标记 steps_truncated） */
  stepsSummaryMax: 20,
  /** 完整层最多步数（超出标记 steps_truncated） */
  stepsFullMax: 60,
  /** 详情缓存复合载体字节上限（超限协议降级只缓存概要，get_steps 重新请求如实组装） */
  detailCacheBytes: 32 * 1024,
  /** 缓存内单条材料文本上限 */
  materialItem: 200,
} as const;

/** 缓存 TTL 默认值（分钟级短时缓存，PROTOCOLS_CACHE_TTL_SEC 可整体覆盖搜索 TTL） */
export const PROTOCOLS_SEARCH_TTL_SEC = 300;
export const PROTOCOLS_DETAIL_TTL_SEC = 600;