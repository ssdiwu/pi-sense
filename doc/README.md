# pi-dvision 文档入口

## 当前范围

`pi-dvision` 只解决一个问题：

- 当 active model（当前模型）不支持图片输入时，自动用一个用户指定的 vision model（视觉模型）描述图片，把文字描述喂给纯文本模型。

## 当前设计

- 注入管线：`tool_result`（主）+ `context`（兜底），两段。
- vision 调用：每张图片独立 1 次 `completeSimple()` 调用，并行执行。
- 缓存：按 image hash 缓存描述，同一张图不重复描述。
- 配置：`~/.pi/agent/pi-dvision.json`（平铺，与 pi-autoname / pi-tinyfish 一致）。

## 为什么不做（grill 对齐结果）

- 不做 TUI 交互选择器：vision model 低频且基本固定，命令行 `/dvision model` 即可。
- 不做 prewarm 粘贴预热：opt-in 默认关的优化，砍了不影响核心功能。
- 不做 usage/energy 记录：只写不读，零消费方。
- 不做 error-log 文件日志：`ctx.ui.notify` 报错足够。
- 不做 DataLoader 批量合并：实际场景 N ≤ 3，每图独立调用更简单更健壮。
- 不做 `before_agent_start` 预热段：`tool_result` + `context` 两段已覆盖主路径和兜底。
