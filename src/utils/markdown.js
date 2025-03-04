import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';  // 导入 Highlight.js 核心模块

let renderer = null;

if (!renderer) {
  renderer = new marked.Renderer();
}

renderer.code = (code, language) => {
  const validLang = !!(language && hljs.getLanguage(language))
  if (validLang) {
    const lang = language ?? ''
    const highlightedCode = hljs.highlight(lang, code, true).value;
    return highlightBlock(highlightedCode, lang);
  }
  return highlightBlock(hljs.highlightAuto(code).value, '');
};

function highlightBlock(str, lang) {
  return `<pre class="code-block-wrapper"><div class="code-block-header"><span class="code-block-header__lang">${lang}</span><span class="code-block-header__copy">Copy Code</span></div><code class="hljs code-block-body ${lang}">${str}</code></pre>`;
}

// 配置 marked 使用自定义的渲染器
marked.setOptions({
  renderer: renderer,
  // 其他 marked 配置项...
});
export default marked;
