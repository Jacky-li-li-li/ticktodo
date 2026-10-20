# 工具图标素材来源

这些是**官方 mark 的位图版本**（官方只提供 App 图标 / 位图 favicon，没有可内联的 SVG）。
统一处理成 **96×96、内容撑满画布**（显示 14px，@3x 屏够用）：
- 去掉 App 图标自带的外圈透明留白（macOS 的 `.icns` 四周常留 ~23% 空白，不裁会让 14px 下偏小一半）；
- 按「内容 bbox 的最长边 = 96」等比缩放后居中；
- 未改形状与配色。

**观感并不完全一致（如实说明）**：内联 SVG（pi / WorkBuddy / Claude）是透明底的矢量 mark；
下面 9 张位图里只有 `cline` / `qoder` / `codex` 是透明底图形，`kimi` / `zcode` / `opencode` 保留了
App 图标自带的**不透明深色圆角方底**、`grok` 是深色方底 favicon、`dsh` 是**白色**圆角方底；
`omp` 是从官方 hero 图里紧裁的 π 字形（内容贴边、边缘略有原图重影）。
这些都是官方原始素材，按「不自行重绘」约定保留；14px 下方底 mark 会比透明 mark 更「实」，
属已知差异，不是渲染错误。

| 文件 | 工具 | 来源（2026-10-20 获取） |
| --- | --- | --- |
| `kimi.png` | Kimi Code | `/Applications/Kimi.app/Contents/Resources/icon.icns` → sips 转 PNG（官方桌面应用图标） |
| `zcode.png` | ZCode | `/Applications/ZCode.app/Contents/Resources/icon.icns`（官方桌面应用图标） |
| `dsh.png` | DeepSeek Harness | `/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns`（官方桌面应用图标） |
| `qoder.png` | Qoder / Qoder CN | 官方站点 `qoder.com` / `qoder.cn` 声明的 412×412 图标（`img.alicdn.com/...-tps-412-412.png`） |
| `cline.png` | Cline | 官方站点 `cline.bot/assets/branding/favicons/favicon-256x256.png` |
| `grok.png` | Grok | 官方站点 `grok.com/images/favicon.svg`（用 rsvg-convert 栅格化到 256 后缩放） |
| `opencode.png` | OpenCode | 官方站点 `opencode.ai/favicon.svg`（同上） |
| `omp.png` | omp | 官方仓库 `can1357/oh-my-pi` 的 `assets/hero.png` 里的 π 字形区域；裁切后按亮度去背景（保留官方渐变） |
| `codex.png` | Codex | **厂商 mark**：`developers.openai.com/favicon.svg`（OpenAI 官方 blossom）；去掉蓝色底圆、按官方单色用法转黑。Codex 没有公开的独立 mark（CLI 只发布 `codex-cli-splash.png` 终端截图，openai.com / developers.openai.com 的页面与资源请求 403），因此用厂商 mark 标识，不自行重绘 |

约定：

1. **不要自行重绘或「风格化」**官方 mark；只用官方提供的图形，缩放即可。
2. 新增工具若要登记图标：优先内联官方 SVG（放同目录的 `XxxIcon.tsx`）；只有位图时才放这里，
   并在上表登记来源与获取日期。
3. `codex` 用的是**厂商 mark**（OpenAI blossom）而不是独立图形：上面表里写明了来源与理由。
   如果将来 OpenAI 发布 Codex 独立 mark，换成它并删除本条说明。
4. 方底 mark 属已知观感差异（见上文）；若将来拿到官方透明底矢量 mark，优先换成内联 SVG。
