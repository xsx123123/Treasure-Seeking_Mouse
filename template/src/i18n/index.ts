// 轻量 i18n 内核：字典 + t() 取词/插值 + 工具名展示表。
// 不引第三方库；语言偏好写 localStorage（键前缀为项目 slug），React 侧由 provider.tsx 提供响应式 t()。
// zh 字典是键的权威来源：en 缺键静默回退中文（MessageKey 模板类型在编译期兜底键数一致）。
import { zh } from "./locales/zh";
import { en } from "./locales/en";

export type Lang = "zh" | "en";
export type MessageKey = keyof typeof zh;

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

const KEY_LANG = "{{PROJECT_SLUG}}-lang";

/** 默认语言（模板初始化值；浏览器语言不参与判断，界面切换与 ?lang= 可覆盖） */
const DEFAULT_LANG = "{{DEFAULT_LANG}}" as Lang;
function detectDefaultLang(): Lang {
  return DEFAULT_LANG;
}

/**
 * 当前语言（优先级与 index.html 引导脚本保持一致，避免首屏 title 与界面语言不一致）：
 *   1) ?lang=zh|en URL 参数强制覆盖（截图/取证通道，不落盘）
 *   2) localStorage 已存偏好（用户在界面上的切换）
 *   3) 默认语言（初始化值）
 */
export function readLang(): Lang {
  try {
    const forced = /[?&]lang=(zh|en)\b/.exec(window.location.search)?.[1];
    if (forced === "zh" || forced === "en") return forced;
  } catch {
    /* ignore */
  }
  try {
    const v = localStorage.getItem(KEY_LANG);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* ignore */
  }
  return detectDefaultLang();
}

export function writeLang(l: Lang): void {
  try {
    localStorage.setItem(KEY_LANG, l);
  } catch {
    /* ignore */
  }
}

/** 同步 <html lang> 与文档标题，便于无障碍与搜索引擎 */
export function applyLang(l: Lang): void {
  try {
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    document.title = "{{PROJECT_NAME}}";
  } catch {
    /* ignore */
  }
}

/**
 * 取词并插值：占位符写法 `{name}`。
 * 目标语言缺失该键时回退中文；中文也缺失则原样返回 key（便于发现遗漏）。
 */
export function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const raw = DICTS[lang][key] ?? zh[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name]),
  );
}

/** 便捷取词器：预先绑定语言 */
export function createT(lang: Lang) {
  return (key: MessageKey, params?: Record<string, string | number>): string => translate(lang, key, params);
}
export type TFunc = ReturnType<typeof createT>;

/* ---------- 工具名 → 展示标签（后端已下发中文 label，英文界面在此覆盖为英文） ---------- */

const TOOL_LABELS_ZH: Record<string, string> = {
  echo: "回显文本（示例）",
  demo_cards: "演示数据集（示例）",
  weather_current: "查询当前天气（示例模块）",
  weather_forecast: "查询天气预报（示例模块）",
};

const TOOL_LABELS_EN: Record<string, string> = {
  echo: "Echo text (sample)",
  demo_cards: "Demo dataset (sample)",
  weather_current: "Current weather (sample module)",
  weather_forecast: "Weather forecast (sample module)",
};

const TOOL_LABELS: Record<Lang, Record<string, string>> = { zh: TOOL_LABELS_ZH, en: TOOL_LABELS_EN };

/** 工具名 → 展示标签；服务端 label 作为未知工具的兜底 */
export function toolLabel(lang: Lang, name: string, fallback?: string): string {
  return TOOL_LABELS[lang][name] ?? fallback ?? name;
}