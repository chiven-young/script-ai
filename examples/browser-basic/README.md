# browser-basic

同一份核心，直接在浏览器/WebView 里运行——**零依赖、零构建**：任何静态服务器即可。

```bash
npx serve .        # 或 python3 -m http.server
# 打开 /examples/browser-basic/
```

填入任意 CORS 开放的 OpenAI 兼容端点。本地 Ollama 需 `OLLAMA_ORIGINS=* ollama serve`。

浏览器宿主注入**空工具面**（纯对话）——这正是「核心不变、宿主决定工具面」的体现。
