// intent-vocab.ts：意图 IR 的槽位 schema 与归一化词表——单点定义。
//
// 「框架与数据分离」：intent.ts 的校验/判别联合/归一化/回灌逻辑不依赖任何具体领域，
// 全部消费本文件的定义。**换领域只改这一个文件**（targets 枚举、filters 槽位、needs 标志），
// 框架零改动。
//
// 模板内置的中性示例是一套「目录检索」词表：targets 为 catalog/detail/reference，
// filters 提供分类（category，枚举词表）、地区（region，枚举词表）、关键词（keyword，自由文本）、
// 仅看已核验条目（verified_only，布尔）。使用者按自身领域替换即可。

/** 意图目标：catalog=目录/条目检索，detail=条目详情，reference=参考资料 */
export const INTENT_TARGETS = ['catalog', 'detail', 'reference'] as const;
export type IntentTarget = (typeof INTENT_TARGETS)[number];

/** filters 槽位类型：enum=词表归一化（未知值拒绝），freetext=截断透传，boolean=仅真布尔 */
export type IntentSlotKind = 'enum' | 'freetext' | 'boolean';

export interface IntentFilterSlot {
  /** filters 对象里的字段名 */
  key: string;
  kind: IntentSlotKind;
  /** kind=enum 时的归一化词表：key 为小写化别名（含中文），value 为规范值。未知值一律 ok:false 不猜 */
  aliases?: Record<string, string>;
  /** 槽位语义描述（用于 intent_plan 工具 schema 与错误提示） */
  description: string;
}

/** filters 槽位定义（顺序即 schema 中的呈现顺序） */
export const INTENT_FILTER_SLOTS: IntentFilterSlot[] = [
  {
    key: 'category',
    kind: 'enum',
    description: '分类，中英文别名均可，平台归一化为规范分类值',
    aliases: {
      '电子': 'electronics', '电子产品': 'electronics', '数码': 'electronics', 'electronics': 'electronics', 'digital': 'electronics',
      '图书': 'books', '书籍': 'books', 'book': 'books', 'books': 'books',
      '服饰': 'clothing', '服装': 'clothing', '衣服': 'clothing', 'clothing': 'clothing', 'apparel': 'clothing',
      '食品': 'food', '美食': 'food', 'food': 'food', 'grocery': 'food',
      '玩具': 'toys', 'toys': 'toys', 'toy': 'toys',
    },
  },
  {
    key: 'region',
    kind: 'enum',
    description: '地区，中英文缩写均可，平台归一化为规范地区码',
    aliases: {
      '中国': 'cn', '中国大陆': 'cn', 'cn': 'cn', 'china': 'cn',
      '美国': 'us', 'us': 'us', 'usa': 'us', 'united states': 'us',
      '欧洲': 'eu', 'eu': 'eu', 'europe': 'eu',
      '日本': 'jp', 'jp': 'jp', 'japan': 'jp',
      '全球': 'global', '国际': 'global', 'global': 'global', 'worldwide': 'global',
    },
  },
  {
    key: 'keyword',
    kind: 'freetext',
    description: '附加关键词（自由文本，原样保留）',
  },
  {
    key: 'verified_only',
    kind: 'boolean',
    description: '是否只要已核验条目',
  },
];

/** needs 标志字段名（IR 顶层布尔字段） */
export const INTENT_NEEDS_FLAG = 'needs_reference';

/** needs 标志的语义描述（intent_plan 工具 schema 用） */
export const INTENT_NEEDS_DESCRIPTION = '是否需要同时检索参考资料';

/**
 * 一致性修正规则：targets 含该目标时强制 needs 标志为 true
 * （如目标就是查参考资料，却标不需要参考资料，以前者为准——记 note 不判负）。
 * 设为 null 可关闭该修正。
 */
export const INTENT_NEEDS_IMPLYING_TARGET: IntentTarget | null = 'reference';