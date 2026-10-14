# node-basic

最小可运行示例：本地 Ollama + 一个宿主注入的 `list_dir` 工具，跑通「工具调用 → 结果回传 → 总结」两步循环。

```bash
# 前置：安装并启动 Ollama，拉一个工具能力可靠的模型
ollama pull qwen2.5

# 运行（无需 npm install —— 核心零依赖）
node examples/node-basic/index.js "看看 /tmp 里有什么"
```

环境变量：`OLLAMA_HOST`（默认 `http://localhost:11434`）、`OLLAMA_MODEL`（默认 `qwen2.5`）。

要点：`execute()` 是**宿主自己的代码**，库不碰文件系统；审批钩子在这里自动放行，真实宿主会弹窗。
