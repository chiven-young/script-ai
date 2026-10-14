# host-injection

**最重要示例**：一个真实宿主的完整形态——注入工具面、实现审批对话框、渲染事件流、断点恢复。

用脚本化 mock provider 模拟模型行为（step 1 调 `list_dir` → step 2 尝试 `bash` 被策略拒绝 → step 3 总结），**无需 Ollama**：

```bash
node examples/host-injection/index.js
```

覆盖的宿主契约：
- `permission` 三态：`allow`（只读自动放行）/ `deny`（根本不下发给模型）/ `ask`（必过对话框）
- `onBeforeToolCall` 审批钩子 + 「记住选择」缓存（Gemini CLI / OpenCode 同款做法）
- 工具失败/被拒 → 错误作为 `role:"tool"` 结果回传 → 模型自我纠正，循环不炸
- `snapshot()` → JSON 持久化 → 新实例 `restore()` 后原样继续（移动端杀后台场景）
- 结构化事件流（`text` / `reasoning` / `toolCall` / `toolDecision` / `toolResult` / `run:end`）取代 v1 的私有标记语言

把 `scriptedProvider` 换成 `createProvider.ollama({ … })` 即可接入真实模型。
