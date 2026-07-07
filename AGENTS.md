# pi-dvision — Agent 规范

## 项目一句话定位

Pi 扩展：当 active model（当前模型）不支持图片时，用一个用户指定的 vision model（视觉模型）描述图片，把文字描述喂给纯文本模型。

## 先读文档顺序
1. 本文件
2. `README.md`
3. `doc/README.md`

## 技术栈
- TypeScript Pi extension
- 无运行时依赖（peerDependency: @earendil-works/pi-coding-agent）

## 验证方式
- `/dvision model minimax-cn/MiniMax-M3` 配置 vision model
- 在不支持图片的 active model 下，让 agent `read` 一张图片
- 检查 agent 收到的是文字描述而非 image block

## 文档沉淀出口
- `README.md`：用户安装、配置、验证
- `doc/README.md`：设计边界、已知限制、为什么不做某些功能

## 工程纪律
- 保持最小实现，不为跨 provider 兼容提前做复杂抽象
- 改行为时先验证 vision 调用链路（`completeSimple` → 描述 → 注入），再改扩展代码
- 配置走平铺 `~/.pi/agent/pi-dvision.json`，不进 `~/.pi/agent/extensions/`（那是扩展代码自动发现目录）
- 不做批量合并：每图独立调用，简单缓存，除非有证据证明 N > 3 是常见场景
