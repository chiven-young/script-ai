import { marked } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import html from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import php from 'highlight.js/lib/languages/php';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import c from 'highlight.js/lib/languages/c';
import csharp from 'highlight.js/lib/languages/csharp';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import rust from 'highlight.js/lib/languages/rust';
import fortran from 'highlight.js/lib/languages/fortran';
import matlab from 'highlight.js/lib/languages/matlab';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import shell from 'highlight.js/lib/languages/shell';
import plaintext from 'highlight.js/lib/languages/plaintext';

// 注册语言模块
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('html', html);
hljs.registerLanguage('css', css);
hljs.registerLanguage('php', php);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('go', go);
hljs.registerLanguage('c', c);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('fortran', fortran);
hljs.registerLanguage('matlab', matlab);
hljs.registerLanguage('r', r);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('plaintext', plaintext);

let renderer = null;

if (!renderer) {
  renderer = new marked.Renderer();
}

renderer.code = function (code, language) {
  try {
    const lang = language || code?.lang || 'shell';
    if (lang && hljs.getLanguage(lang)) {
      const highlighted = hljs.highlight(code?.text, { language: lang });
      return highlightBlock(highlighted.value, lang);
    }
    return highlightBlock(code?.text, 'shell');
  } catch (error) {
    console.error('代码高亮出错:', error);
    return highlightBlock(code?.text || code, 'plaintext');
  }
};

function highlightBlock(str, lang) {
  // 生成一个唯一的codeId
  const codeId = `code-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  return `<div class="code-wrapper ${currentTheme}" id="${codeId}"><div class="code-header"><span class="code-header__lang">${lang}</span><div class="code-header__btns"><span class="code-btn code-header__theme" onclick="toggleAllCodeThemes()">${currentTheme === 'dark' ? 'light' : 'dark'}</span><span class="code-btn code-header__copy" data-code-id="${codeId}" onclick="copyCode('${codeId}')">copy</span></div></div><div class="code-content"><pre><code class="hljs code-block-body ${lang}">${str}</code></pre></div></div>`;
}

// 替换行内和块级公式
function renderMath(text) {
  // 处理 $$...$$（块级公式）
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    try {
      return `<div class="math-block">${katex.renderToString(expr, { displayMode: true })}</div>`;
    } catch (err) {
      console.error('KaTeX 块级渲染失败:', err);
      return `<pre class="math-error">$$${expr}$$</pre>`;
    }
  });

  // 处理 $...$（行内公式）
  text = text.replace(/(?<!\$)\$([^\$]+?)\$(?!\$)/g, (_, expr) => {
    try {
      return katex.renderToString(expr, { displayMode: false });
    } catch (err) {
      console.error('KaTeX 行内渲染失败:', err);
      return `<span class="math-error">$${expr}$</span>`;
    }
  });

  return text;
}

// 配置 marked 使用自定义的渲染器
marked.setOptions({
  renderer: renderer,
  gfm: true,
  breaks: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (__) { }
    }
    return code;
  }
});

window.copyCode = function copyCode(codeId) {
  const codeContainer = document.getElementById(codeId);
  const codeElement = codeContainer?.querySelector('.code-block-body');
  if (codeElement) {
    const codeText = codeElement.textContent;
    navigator.clipboard.writeText(codeText)
      .then(() => {
        console.log('代码复制成功');
        const button = codeContainer?.querySelector('.code-header__copy');
        if (button) {
          button.textContent = 'copied';
          setTimeout(() => {
            button.textContent = 'copy';
          }, 1000);
        }
      })
      .catch(err => {
        console.error('代码复制失败:', err);
      });
  }
}

window.toggleCodeTheme = function toggleCodeTheme(codeId) {
  const codeContainer = document.getElementById(codeId);
  if (codeContainer) {
    codeContainer.classList.toggle('dark');
    codeContainer.classList.toggle('light');
    const button = codeContainer.querySelector('.code-header__theme');
    if (button) {
      button.textContent = button.textContent === 'Dark' ? 'Light' : 'Dark';
    }
  }
}

const getCodeTheme = () => {
  return localStorage.getItem('code-theme') || 'dark';
}
let currentTheme = getCodeTheme();
const toggleCodeThemeCache = () => {
  const currentTheme = getCodeTheme();
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('code-theme', newTheme);
}

window.toggleAllCodeThemes = function toggleAllCodeThemes() {
  // 获取所有带有 code-wrapper 类名的 div 元素
  const codeContainers = document.querySelectorAll('.code-wrapper');

  codeContainers.forEach((codeContainer) => {
      // 切换 dark 和 light 类名
      codeContainer.classList.toggle('dark');
      codeContainer.classList.toggle('light');

      // 获取每个代码块中的主题切换按钮
      const button = codeContainer.querySelector('.code-header__theme');
      if (button) {
          // 切换按钮文本内容
          button.textContent = button.textContent === 'dark' ? 'light' : 'dark';
      }
  });
  toggleCodeThemeCache();
};

export function markdownParse(mdText) {
  const html = marked.parse(mdText);
  return renderMath(html);
}

export { hljs };
export default marked;
