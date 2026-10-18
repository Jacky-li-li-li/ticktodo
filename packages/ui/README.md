# `@tick/ui`

拟态玻璃（glassmorphism）视觉基建：令牌 + 材质 class + 薄 React 封装。

## 为何有这个包

视觉迭代只改本包，避免在 `apps/desktop` feature 里再散落一套玻璃底。布局与业务 class 仍可留在 desktop；**材质以本包为准**。

## 消费方式

```ts
// 在业务 styles 之前引入
import '@tick/ui/styles.css'

// 可选：React 薄封装
import { GlassPanel, GlassRow, GlassPill, glassTokens } from '@tick/ui'
```

也可只引令牌：`import '@tick/ui/tokens.css'`。

## Token 一览

| Token | 用途 | 默认 |
| --- | --- | --- |
| `--glass-bg` / `--glass-bg-light` | 浅色毛玻璃底板 | `rgba(255,255,255,0.42)` |
| `--glass-blur` | backdrop blur | `40px` |
| `--glass-saturate` | 饱和度 | `1.4` |
| `--glass-border` | 细亮边 | `rgba(255,255,255,0.22)` |
| `--glass-highlight` | 顶缘内高光 | `inset 0 1px 2px …` |
| `--glass-shadow` | 大软阴影 | `0 30px 80px …` |
| `--glass-overlay` | 选中/悬停叠层 | `rgba(0,0,0,0.06)` |
| `--glass-pill-bg` | 胶囊按钮底 | 略不透明于底板 |
| `--panel-base` | 兼容旧暗透面板 | `rgba(18,20,31,0.2)` |
| `--t-*` | 文字层级 | 与 desktop 一致 |
| `--r-*` / `--pad-panel` / `--gap-std` | 圆角、间距 | 兼容映射 |
| `--accent` / `--accent-text` | 强调色（**统一 UI 后为墨黑，不再用蓝色**） | `#2a2d33` / `#0b1a2a` |
| `--metal-hi` / `--metal-mid` / `--metal-lo` | 金属黑按钮渐变三段 | `#3f434c` → `#1c1f25` → `#0a0b0e` |
| `--metal-line` / `--metal-text` / `--metal-text-dim` | 金属按钮描边与文字 | 白 22% / `#f3f5f9` / 白 60% |
| `--metal-sheen` / `--metal-shadow` | 顶部高光 / 底部投影 | 白 36% / 黑 34% |

TS 镜像见 `src/tokens/tokens.ts`（`glassTokens`）。

## 按钮规范（2026-10-18 定）

- **主按钮**：抛光金属黑（`--metal-*` 三段渐变 + 顶部高光 + 底部投影），白字；
- **次按钮 / 小按钮 / 分段选中 / chip 选中 / 列表选中行**：哑光石墨（同色系低一档），白字；
- **文本按钮 / 链接 / 状态标记**：墨黑（`--accent-text`），不用蓝色；
- **键盘焦点环**：墨色 `2px`，不再用蓝色；
- **语义色**：只保留绿（成功/完成）与红（危险/失效）。
- 具体落地见 `apps/desktop/src/renderer/styles.css` 末尾「UI 规范统一」两段。

## 材质 class

| Class | 说明 |
| --- | --- |
| `.tick-glass-panel` | 主面板玻璃 |
| `.tick-glass-surface` | 次级表面 |
| `.tick-glass-row` / `.tick-glass-row-active` | 行悬停/选中叠层 |
| `.tick-glass-pill` | 半透明胶囊按钮 |
| `.tick-glass-hairline` | 细亮分割线 |

只做材质与交互态，**不做业务布局**。

## 禁止

- 不要在 feature 里再写一套玻璃底（`backdrop-filter` + 半透明白叠层等）
- 新 UI 用 `.tick-glass-*` 或 `GlassPanel` / `GlassRow` / `GlassPill`

## 与 `apps/desktop/.../styles.css` 的关系

- 令牌与玻璃材质来自本包
- desktop `styles.css` 保留布局 / 业务 class（`.topbar`、列表、Chat 等）
- 现有 `.panel` 已改为组合 `--glass-*`，避免两套材质分叉；后续可逐步把业务块换成 `.tick-glass-*`
