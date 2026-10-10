# GEO 寻宝鼠 · 前端样式与风格规范

> 本文档描述**当前实现**的前端设计系统与交互规范，是 `docs/style_prompt.md`（视觉重构任务指令）落地后的权威版本。
> 改 UI 前先读本文；改完对照第七节「工程硬约束」自查。所有改动走 `npx tsc --noEmit` + `npx vite build`，i18n 改动核对中英键数一致。

---

## 1. 设计定位

**「高校同门科研搭子」的温度 ×「探矿挖宝工坊」的趣味**——治愈系科研工作台，不是冷极简管理后台。

- **世界观词汇**：挖宝/下铲/矿脉/宝藏 = 检索；阿寻 = 桌宠助手；夜探矿洞 = 暗色主题。
- **质感关键词**：暖米白纸感（摊开藏宝图）、矿工绿（行动与状态）、琥珀金（亮点与彩蛋）、圆润卡片、轻投影。
- 后端 API 与数据流与视觉解耦，重构不动交互逻辑。

## 2. 设计令牌（Design Tokens）

唯一权威定义在 `src/styles.css` 的 `:root`（亮色）与 `.dark`（夜探矿洞）。**组件一律消费 Tailwind token utility**（`bg-card`、`text-muted-foreground`、`border-border`、`text-helix`…），已在 `@theme` 块映射 `--color-*`。

### 2.1 亮色 `:root`

| 令牌 | 值 | 用途 |
|---|---|---|
| `--background` | `#FAF8F5` | 暖米白主背景（藏宝图纸感） |
| `--foreground` | `#292524` | 温暖深炭黑正文（非死黑） |
| `--card` / `--popover` | `#FFFFFF` | 纯白主卡片/浮层 |
| `--secondary` / `--muted` | `#F6F3EE` | 便签与次级卡片底 |
| `--muted-foreground` | `#78716C` | 温暖次级灰（说明、placeholder） |
| `--accent` | `#F1EDE6` | hover 浅米 |
| `--border` / `--input` | `#E7E5E4` | 柔和边界线 |
| `--primary` / `--helix` | `#15803D` | 矿工绿：主行动按钮、状态、强调图标 |
| `--helix-soft` | `#DCFCE7` | 浅绿胶囊底 |
| `--strand` | `#B45309` | 探矿金深档（链接/RNA 辅助色） |
| `--panel` | `#F6F3EE` | 侧栏/头部暖米面板 |
| `--rail-icon` | `#57534E` | 窄边条图标专用（纯色，见 §7） |
| `--gold` / `--gold-hover` / `--gold-light` | `#D97706` / `#B45309` / `#FEF3C7` | 琥珀金三档（高亮词、hover 焦点、浅金便签） |
| `--pet-amber` / `--pet-amber-deep` / `--pet-gold-soft` | `#D97706` / `#B45309` / `#FEF3C7` | 寻宝琥珀金（桌宠/空态/宝箱彩蛋专用语义组） |
| `--destructive` | `#DC2626` | red-600 档错误/删除 |
| `--ring` | `#15803D59` | 焦点环（矿工绿 35%） |
| `--radius` | `0.75rem` | 统一圆角基准 |

字体三件套（`--font-sans` / `--font-mono` / `--font-display`）：Noto Sans SC Variable（正文）· JetBrains Mono（编号/统计）· Fraunces + Noto Serif SC（标题 `font-display`）。

### 2.2 暗色 `.dark`（夜探矿洞）

策略：**同名字令整体覆盖**，不新增暗色类名。暖深褐矿洞底（`--background: oklch(0.21 0.012 70)`），卡片亮一档（0.26），主色提亮为亮矿工绿（`oklch(0.72 0.16 150)`），琥珀金整体提亮发光。特例：`--pet-amber-deep` 在暗底反转为**亮金文字档**（`oklch(0.85 0.13 82)`）——"深琥珀"语义是"pet 周边文字"，暗底必须变亮。新增 token 时亮暗两份必须同时给。

## 3. 背景与纹理

- **纸感点阵** `.bg-grid`：`radial-gradient(rgb(120 113 108 / 0.045) 1px, transparent 1px)`，24px 网格。暗色用 `oklch(0.85 0.02 80 / 0.05)`。
  - **硬规则：要淡就直接把透明度画进纹理本身，禁止用整面 `::before` 蒙板调淡**（`inset:0` + 背景色 + 高 opacity 的蒙板会压住所有不建堆叠上下文的子内容，曾把侧栏/关于页洗成幽灵文字，见 AGENTS.md 踩坑记录）。
- **顶部暖光** `.ambient-glow`：矿灯金 + 矿工绿双径向渐变，仅主内容区顶部。
- **统一轻投影** `.shadow-soft` / `.shadow-soft-lg`（`.dark` 下有加重替换版）。组件统一用这两个 class，不自造 box-shadow。

## 4. 页面区块规范

### 4.1 新会话欢迎区（`EmptyState.tsx`）

- 内容宽度最多 820px，采用无外框的纵向布局。品牌行使用 56px 本地阿寻头像、品牌名和研究问题标题，下面只有一句副标题。
- 新会话的输入框紧接副标题，四项任务入口位于输入框下方；进入对话后，同一个 `Composer` 回到底部。草稿由页面状态持有，布局切换时保留输入。
- 头像保留 1.5s 内连点 3 次打开彩蛋弹窗的交互。空态隐藏右下角重复的桌宠形象；顶栏设置里的「找回阿寻」可重新显示。

### 4.2 四项能力入口

- 数据发现、编号溯源、数据集解读、文献探索组成桌面 2×2、移动单列的网格。每项使用主名称、辅助探险名称、一句说明和小图标；默认卡片高度一致。
- 点击卡片展开两条示例，`aria-expanded` 表示状态。点击示例只填入输入框并聚焦，用户确认后才发送。卡片的 hover/focus 使用现有主题令牌，保持轻量。
- 网格后保留低强调度的数据库来源与证据说明；不展示尚未完成的核验结果。

### 4.3 对话区

- 用户气泡右对齐矿工绿实底白字；助手消息白卡片 + `shadow-soft`。
- 工具调用走「实时追踪条」：running/done/error 三态 + 耗时；卡片经 `{"event":"cards"}` 独立通道渲染不瘦身。
- 正文 Markdown（`md-body`）：GSE/GSM/GO/PMID 编号自动变可点链接（IdLink hover 浮层预取论文元数据）；代码块 rehype-highlight，暗色有专属 hljs 调色板（`oklch`，见 styles.css §暗色覆盖）。

### 4.4 输入区（Command Station）

- Placeholder 引导语：`描述你的研究问题，或粘贴 GSE / GSM / SRR 编号……`。欢迎页位于任务卡之前，对话页位于消息流底部。
- 发送按钮 = 矿工绿「⛏️ 下铲挖宝」实底（hover `--miner-green-hover`）；停止态切换为中断样式。
- **输入联动**：输入框有字符时经 `petBus.emitPetTyping(true)` 通知桌宠挂「竖起耳朵」跃动 class（`pet-ears-perk`），清空即恢复。
- 底部免责小字在移动端同样可见，随模型选择自然换行。

### 4.5 侧栏与顶栏

- 侧栏 270px 面板（`bg-panel`）：品牌头 → 新对话 CTA → 标题搜索 → 今天/昨天/过去 7 天/更早的历史分组 → 登录或账号行。历史按更新时间倒序，标题单行截断并以 `title` 展示全文。
- 未登录底部：主按钮「登录 / 注册 · 保存聊天记录」+ 副链「不登录，先试试 →」（收起侧栏）；游客存储策略说明小字殿后。**禁止**「以游客身份继续」这类与点击结果不符的文案。
- 顶栏按钮组：排行榜 🏆 / 统计 📊 / 关于 ⓘ / 🐾 阿寻设置 / 语言 / 主题，是全局设置的唯一入口；统一 `text-muted-foreground` + hover 点亮（各自语义色）。
- PC 默认收起为 48px 窄边条（`--rail-icon` 纯色图标，**不用** `text-foreground/x%` 透明度修饰符，见 §7）。

## 5. 桌宠「阿寻」（TreasureMouse）

### 5.1 状态机 ⇆ 造型映射

| 状态 | 触发 | 造型（`src/assets/pet/` webp，文件名即行为） |
|---|---|---|
| idle | 默认 | `mouse-base` |
| digging / walk | 工具开挖 / 散步 | `mouse-shovel`（暗色主题自动换 `mouse-night` 提灯形象） |
| reveal / stow | 出土卡片 | `mouse-chest-open` |
| miss / error | 空矿/报错 | `mouse-sad` |
| poke | 点击戳一戳 | `mouse-wink` |
| spin | 连戳 3 次彩蛋 | `mouse-spin` |
| celebrate | 成就里程碑 | `mouse-crown` |
| look | 闲置张望 | `mouse-sniff` |
| peek | 闲置小剧场 | `mouse-peek` |
| sleep | 45s 无互动 | `mouse-sleep`（冒 Zzz…，互动即醒） |

暗色跟随用 MutationObserver 盯 `<html>.dark`，不写死主题判断。原图 2048² PNG 为归档母版，打包只用 512px webp。

### 5.2 气泡与台词

- 气泡 = 可换行的绝对定位圆角卡 + 朝下尖角（`.pet-bubble`），可点击换下一句或用关闭按钮隐藏；顶栏设置的「找回阿寻」可重新显示气泡。剧情台词（挖宝/提示/睡醒）优先接管。
- 气泡、尘土、土堆、星尘、光环等周边全部为 CSS keyframes，暗色均有 `.dark` 覆盖段。

### 5.3 设置面板（行式规范，参考 docs/2026-10-06_14.04.23.png）

`PetSettingsPanel.tsx`，双入口共用（hover 宠物浮现的齿轮 + 顶栏 🐾）：

1. 标题栏：🐾 阿寻设置 + 右侧「关闭」；
2. **体型大小**：步进按钮 ±12px，读数显示相对 144 的百分比（72–240 连续值，`seqout-pet-size`）；
3. **从桌面收起**：switch（= quiet，右下角留召回小入口）；
4. **闲置时自己活动**：switch（关闭 = 闲置剧场整体停演，不冒泡/溜达/入睡，`seqout-pet-idle-alive`）；
5. **一直存在**：switch（关闭 = 闲置 15s 自动藏起来，`seqout-pet-always`）；
6. **位置复位**：描边按钮，经 `petBus.resetPos` 回右下角默认位；
7. 底部：找回阿寻通栏按钮 + 宝藏计数 + 「这些偏好只保存在本机浏览器，随时可在设置里改回。」

开关为自绘 iOS 风 switch（token 色，开 = `bg-helix`）。面板 ⇆ 桌宠**双向同步**走 `src/lib/petBus.ts`（`settingsChanged` / `recall` / `quiet` / `resetPos` / `typing` 迷你 pub-sub），禁止跨层传 props。

## 6. 动效规范

- **只用 CSS keyframes，禁止 framer-motion**。桌宠动画族：pet-bob / wiggle / dig / hop / sag / spin / waddle / peek / breathe + 周边（dust-puff / gem-rise / heart-float / bubble-in / mound-open / gem-stow / think-dot）。
- **入场揭示**走 `src/lib/reveal-engine.ts`：`.reveal*` 类 + IntersectionObserver，translate + 淡入，支持 `data-reveal-delay` 交错；`prefers-reduced-motion` 下全部停用。
- 所有动效类（含 pet 全族与 reveal）必须收录进 styles.css 的 reduced-motion 清零清单。
- 交互微动效约定：hover 上浮 ≤2px + 色/影过渡 150-200ms；按钮按压 `active:scale-[0.98]`；移动端 `touch-clean` 去点击高亮。

## 7. 工程硬约束（自查清单）

1. **禁止硬编码颜色**：不写 hex、不写 Tailwind 内置色板（`bg-white`、`text-stone-600` 等一律禁止）；新色先进 `:root`/`.dark` token，再经 `@theme` 映射消费。
2. **图标描边禁用透明度修饰符**：`text-foreground/75` 这类 alpha 修饰符在 Tailwind v4 走 `color-mix(oklab,…)`，Chromium 对带 alpha 的 oklab SVG 描边有渲染 bug（笔画隐形）。要浅就用纯色 token（如 `--rail-icon`）。
3. **非整刻度尺寸用任意值语法**：`h-[18px]`（Tailwind v4 动态刻度坑）。
4. **i18n**：界面文案一律 `t("key")`；service 层用 `translate(readLang(), "key")`；新增键中英字典同步加（zh 为权威），跑 `tsc` 校验 + 核对键数。
5. **z-index 分层**：桌宠 z-30 < H5 侧栏抽屉 z-40 < 抽屉/弹窗遮罩 z-50 < **阿寻设置面板 z-[60]（最上层）**。顶栏入口的设置面板必须 `createPortal` 挂到 `document.body` 并按触发按钮 `getBoundingClientRect()` 计算 fixed 坐标——header 的 `backdrop-blur` 构成 z-auto 层叠上下文，面板留在 header 内部时会被任何后绘制的主内容/抽屉盖住（2026-10-06 踩坑：空态 Hero 卡压设置面板）。桌宠齿轮入口的面板在桌宠自身 z-30 上下文内即可（抽屉/弹窗打开时桌宠本就被遮罩盖住，不可达）。
6. **头像/装饰图用本地资产**（Vite 打包），废弃带鉴权参数的 CDN 图床。
7. 改主题只动 `styles.css` token + 点名覆盖段；发现组件里出现具体色值即回改。

## 8. 参考索引

| 文件 | 内容 |
|---|---|
| `src/styles.css` | 全部 token、keyframes、暗色覆盖的权威实现 |
| `docs/style_prompt.md` | 视觉重构任务指令（本规范的源头） |
| `src/components/chat/EmptyState.tsx` / `Composer.tsx` / `SessionSidebar.tsx` | 冷启动空态 / 输入区 / 侧栏的落地参考 |
| `src/components/pet/TreasureMouse.tsx` / `PetSettingsPanel.tsx` | 桌宠状态机与设置面板参考 |
| `src/lib/reveal-engine.ts` / `petBus.ts` / `hintBus.ts` | 动效门控与跨层通信契约 |
| `src/i18n/locales/{zh,en}.ts` | 全部界面文案（术语口径以此为准） |
