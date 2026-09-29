/**
 * scripts/markdown.mjs
 *
 * Issue body（原始 Markdown）-> 可安全嵌入页面的 HTML。
 *
 * 用途：pages/blog/** 的模板把 issues.json 里每篇文章的 body 渲染成正文 HTML。
 *
 * 设计约束：
 *   - 纯 Node ESM，唯一第三方依赖是 `marked`（GFM：表格 / 删除线 / 任务列表 / 自动链接）。
 *   - marked 是 Markdown 编译器，**不是** HTML 消毒器：默认会把 md 里的原始 HTML
 *     原样吐出来。所以这里在 renderer 层把 html token 统一转义成纯文本，
 *     确保 `<script>`、`<img onerror=...>` 之类只会以字面文本出现在页面上。
 *   - 面向构建管线：任何输入都必须返回字符串，绝不抛异常（脏数据不能炸掉整个构建）。
 *
 * 用法：
 *   import { renderMarkdown, escapeHtml, markedVersion } from './scripts/markdown.mjs';
 *   const html = renderMarkdown(issue.body);
 *   const html2 = renderMarkdown(issue.body, { transform: (h) => h.replace(/…/g, '…') });
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Marked } from 'marked';

import { highlightCode } from './highlight.mjs';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// marked 版本号：从 marked/package.json 读，避免在源码里硬编码而日后漂移
// ---------------------------------------------------------------------------

function readMarkedVersion() {
  // 常规路径：marked 的 exports 里导出了 ./package.json。
  try {
    const pkg = require('marked/package.json');
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // marked 未安装，或该版本没有导出 package.json —— 走下面的兜底。
  }

  // 兜底：从解析出的入口文件往上找 name === 'marked' 的 package.json。
  try {
    let dir = path.dirname(require.resolve('marked'));
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        try {
          const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
          if (pkg && pkg.name === 'marked' && typeof pkg.version === 'string') return pkg.version;
        } catch {
          // 该 package.json 读不动就继续往上找，不因为某层坏掉而整体失败。
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // require.resolve 也失败：没有可报告的版本。
  }

  return 'unknown';
}

/** marked 的实际版本（如 '18.0.14'）；读取失败时为 'unknown'。 */
export const markedVersion = readMarkedVersion();

// ---------------------------------------------------------------------------
// escapeHtml：把不可信文本安全地拼进 HTML 模板
// ---------------------------------------------------------------------------

/**
 * 转义 HTML 的五个敏感字符。
 * `&` 必须最先替换，否则会把后面替换出来的 `&lt;` 二次转义成 `&amp;lt;`。
 *
 * @param {unknown} text 任意值；null / undefined 视为空串。
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------

/**
 * 独立的 Marked 实例（而不是全局单例）：只影响本模块，不污染同进程里别人
 * 调用 `marked.use()` / `marked.setOptions()` 的行为。
 *
 * 选项含义：
 *   gfm           开 GFM：表格、删除线、任务列表、自动链接。
 *   breaks        false：单个换行不折成 <br>（保持 Markdown 原语义）。
 *   async         false：parse 同步返回字符串，而不是 Promise。
 *   silent        false：内部异常抛出后由 renderMarkdown 兜住，不做静默降级。
 */
const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  silent: false,
});

/**
 * 独立实例，只用于重新解析标题里的内联 Markdown（见 renderInlineMarkdown）。
 * 单独一个实例是为了不与上面注册的 renderer 相互影响，
 * 而且只贡献内联 HTML、不涉及 href，所以不必再过 URL 白名单。
 */
const inlineParser = new Marked({ gfm: true, breaks: false, async: false, silent: false });

// ---------------------------------------------------------------------------
// URL scheme 白名单
// ---------------------------------------------------------------------------

/** 允许的协议（其余一律拒绝，含 javascript: / data: / vbscript: / file:） */
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * 还原常见 HTML 实体，避免用 `&#106;avascript:` 之类的写法绕过协议检查。
 * 只处理够用的几种，且只解一层（解完再解会引入新问题）。
 */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (whole, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    })
    .replace(/&#(\d+);?/g, (whole, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    })
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

/**
 * 校验链接/图片地址：
 *   - 相对地址、锚点、协议相对（//host）→ 放行；
 *   - http / https / mailto / tel（大小写不敏感）→ 放行；
 *   - 含控制字符或空白（`java\nscript:` 这类绕过写法）→ 拒绝；
 *   - 其余协议（javascript: / data: / vbscript: / file: …）→ 返回 null。
 *
 * @param {unknown} raw
 * @returns {string|null} 放行时返回可安全写入 href/src 的地址，拒绝时返回 null
 */
function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  const decoded = decodeEntities(trimmed);

  // 控制字符与空白在浏览器解析 URL 时会被忽略，可能被用来伪装协议名
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(decoded)) return null;

  // 相对地址（./a、../a、a/b）、根相对（/a）、锚点（#a）都是安全的
  if (/^[./#?]/.test(decoded)) return trimmed;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded);
  if (!scheme) return trimmed; // 没有协议前缀，按相对地址处理

  return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase()) ? trimmed : null;
}

marked.use({
  renderer: {
    /**
     * 默认实现是 `return text`，也就是把用户写的原始 HTML 原样输出（block 与
     * inline 的 html token 都会走到这里）。改为转义后，`<script>alert(1)</script>`
     * 只会以字面文本出现在页面上，不会被浏览器当标签执行。
     *
     * block 级 token 之间原本靠 raw 里的换行分隔（tokenizer 把换行切进了 space
     * token），转义后要把换行补回来，否则相邻的块会被粘成一行；inline token 则
     * 绝不能加换行，会污染段落文本。
     */
    html({ text, block }) {
      const escaped = escapeHtml(text);
      return block === true ? `${escaped}\n` : escaped;
    },

    /**
     * 链接：过滤危险 URL scheme。
     *
     * 只堵原始 HTML 是不够的 —— marked 不是消毒器，`[点我](javascript:alert(1))`
     * 会原样生成 `<a href="javascript:alert(1)">`，大小写变体与 data:/vbscript: 同理。
     * 这里对 href 做白名单校验，不通过时**去掉 href**（保留链接文字），
     * 让它退化为无害的纯文本而不是可点击的注入点。
     */
    link(token) {
      const href = sanitizeUrl(token.href);
      // 交给默认 link 渲染器，拿到它已经处理好的内部 HTML（含标题）。
      const inner = renderLinkInner(this, token);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      if (href === null) return `<a${title}>${inner}</a>`;
      // 外链新窗口打开时补 rel="noopener"，避免新页面拿到 window.opener
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
      const rel = external ? ' rel="noopener noreferrer"' : '';
      const target = external ? ' target="_blank"' : '';
      return `<a href="${escapeHtml(href)}"${title}${target}${rel}>${inner}</a>`;
    },

    /** 图片：同样过滤 src；不通过时去掉 src，只保留 alt 文本 */
    image(token) {
      const src = sanitizeUrl(token.href);
      const alt = escapeHtml(renderInlineText(token.text));
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      if (src === null) return `<img alt="${alt}"${title}>`;
      return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`;
    },
  },
});

/**
 * 取链接内部 HTML。
 *
 * marked 18.0.14 里 link token 的 `tokens` 实测恒为数组（空文字、尖括号 autolink、
 * 裸 URL、邮箱、引用式链接都验过），但 `^18` 允许升到更高的次版本；万一将来某个
 * 形状不再带 `tokens`，这里的异常会被 renderMarkdown 的 try/catch 兜成空串 ——
 * 整页空白且毫无提示。所以先做形状检查，退化时用纯文本，不把静默失败留给上层。
 */
function renderLinkInner(renderer, token) {
  const plain = token.text === null || token.text === undefined ? '' : String(token.text);
  const parser = renderer && renderer.parser;
  if (Array.isArray(token.tokens) && parser && typeof parser.parseInline === 'function') {
    try {
      return parser.parseInline(token.tokens);
    } catch {
      // this.parser 在 marked 18 里对部分 token 形状不可靠（heading 已实测会抛）。
      // 链接这里实测正常，但仍兜一层：失败时退化为纯文本，不让整页变空。
    }
  }
  return escapeHtml(plain);
}

/**
 * 取行内纯文本用于图片 alt：去掉 Markdown 标记，`![**粗体** alt](url)`
 * 得到 `alt="粗体 alt"`（与 marked 默认行为一致）。
 */
function renderInlineText(text) {
  const raw = text === null || text === undefined ? '' : String(text);
  if (!raw) return '';
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '');
}

/**
 * 把标题文本转成锚点 id。
 * 非 ASCII 字符（含中文）直接保留 —— URL 里会被百分号编码，不影响跳转，
 * 而且锚点保持可读；标点与空白折成 `-`，首尾去 `-`。
 * 不做大小写折叠：`丨漠寒MOHAN` 这类标题保留原样更易读。
 * 结果为空时由调用方指定兜底值。
 */
export function slugify(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[`*_~[\]]/g, '')
    .trim()
    .replace(/[^\w\u4e00-\u9fff\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 把任意输入归一成 marked 能接受的字符串。
 * marked 对非字符串入参会直接抛错，所以这里必须先收口。
 */
function coerceMarkdown(md) {
  if (md === null || md === undefined) return '';
  if (typeof md === 'string') return md;
  try {
    return String(md);
  } catch {
    // 例如 toString 抛异常的对象：当作空内容，绝不把异常带出去。
    return '';
  }
}

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

/**
 * 把一个 token 的原始 Markdown 文本重新解析成内联 HTML。
 *
 * 为什么要重解析：marked 18 的 `heading` token 里 `tokens` 是**未补 type 字段**的
 * 子 token，而 `this.parser.parseInline()` 对数组入口依赖该字段（报
 * `t.text is not a function` / `Token with "undefined" type was not found`）。
 * 这里改走**字符串入口**（`m.parseInline(md)`），它工作正常。
 * 标题文本被包在 `[...](0)` 里，所以内部即便出现裸 URL 也不会被自动链接成 `<a>`。
 */
function renderInlineMarkdown(md) {
  const text = String(md === null || md === undefined ? '' : md);
  if (!text.trim()) return '';
  try {
    const html = inlineParser.parseInline(`[${text}](0)`);
    const match = /^<a[^>]*>([\s\S]*)<\/a>$/.exec(String(html).trim());
    return match ? match[1] : escapeHtml(text);
  } catch {
    // 解析失败就退化为纯文本，绝不让标题丢失
    return escapeHtml(text);
  }
}

/** 取 HTML 的纯文本（用于目录标签与标题锚点），并折叠空白 */
function stripTags(html) {
  return String(html === null || html === undefined ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一段 Markdown 的标记去掉，得到适合做摘要/搜索匹配的纯文本。
 * 摘要来源可能是 build-issues 生成好的（已清理），也可能是手写或旧数据里的原始
 * Markdown —— 后者若直接显示，卡片上会出现 `##`、`**` 之类的标记，所以统一过一遍。
 */
export function toPlainText(md) {
  const raw = String(md === null || md === undefined ? '' : md);
  if (!raw.trim()) return '';

  return raw
    // 代码围栏整段去掉（含内容），摘要里出现代码没有意义
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // 图片留 alt，链接留文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 标题、引用、列表符号（按行首处理）
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    // 兜底：摘要可能是一整行（标题不在行首），此时把残留的 `## ` / `- ` 也去掉
    .replace(/#{1,6}\s+/g, ' ')
    .replace(/(?:^|\s)(?:[-*+]|\d+\.)\s+/g, ' ')
    // 表格分隔行（| --- | :--: |）本身没有语义，留着会污染搜索匹配
    .replace(/^\s{0,3}\|?[\s:|-]*\|[\s:|-]*$/gm, ' ')
    // 分隔线与行内标记
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/[*_~`]/g, '')
    // 行内 HTML 标签
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 小说模式：把「单个换行」也当成段落分隔。
 *
 * 标准 Markdown 把单换行当软换行（渲染成一个空格），小说却靠换行分段 ——
 * 一整章对话会被并进同一个 <p>，读起来全糊在一起。
 *
 * 做法是在解析**之前**重写正文：把段落内的每一行拆成独立段落。
 * 三条刻意保留的规则（否则会破坏其它语法）：
 *   · 围栏代码块（``` / ~~~）内部原样保留；
 *   · 已有块级语法含义的行（标题、列表、引用、表格、分隔线、HTML）不拆；
 *   · 行尾的两个空格（Markdown 的硬换行）去掉，避免和分段重复。
 */
export function expandNovelParagraphs(md) {
  const lines = coerceMarkdown(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null; // 记住当前围栏（``` 或 ~~~）及其长度

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      out.push(line);
      continue;
    }

    // 围栏内部：原样
    if (fence !== null) {
      out.push(line);
      continue;
    }

    // 空行：段落分隔，原样保留
    if (/^\s*$/.test(line)) {
      out.push('');
      continue;
    }

    // 已有块级含义的行：不拆
    if (/^\s{0,3}(#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s|_{3,}|\*{3,}|-{3,}|<)/.test(line)) {
      out.push(line);
      continue;
    }

    // 段内普通文本行 -> 独立段落；行尾两个空格（硬换行）去掉，避免重复
    out.push(line.replace(/ {2,}$/, ''));
    out.push('');
  }

  return out.join('\n');
}

/**
 * Markdown -> HTML。
 *
 * @param {unknown} md 原始 Markdown。undefined / null / 非字符串 / 空串都合法。
 * @param {{
 *   transform?: (html: string) => string,
 *   headingIds?: Array<{ id: string, text: string, level: number }>,
 *   novel?: boolean
 * }} [options]
 *        - transform：可选后处理钩子，在默认渲染完成后调用，用它的返回值替换结果。
 *        - headingIds：传入数组时，渲染过程中把每个标题的 { id, text, level }
 *          依次推进去，供调用方生成目录（id 与页面上的锚点完全一致）。
 *        - novel：true 时启用小说模式（换行即分段），默认 false 走标准 Markdown。
 * @returns {string} HTML 字符串；任何情况下都不抛异常。
 */
export function renderMarkdown(md, options) {
  const isNovel = Boolean(options && options.novel);
  const source = isNovel ? expandNovelParagraphs(md) : md;
  return renderMarkdownCore(source, options);
}

function renderMarkdownCore(md, options) {
  let html = '';

  // 标题收集：先用局部数组，解析结束后才写回调用方传入的数组，
  // 避免中途失败时把不完整的结果暴露出去。
  const headingIds = [];
  const usedIds = new Map();
  const collectHeadings = Boolean(options && options.headingIds);

  // 用 marked.use() 注册标题渲染器，而不是 marked.parse(md, { renderer })。
  // 后者会用传入对象**整体替换** renderer，丢掉 space/paragraph 等默认方法，
  // 表现为解析到空行时抛 `this.renderer.space is not a function`（已实测）。
  // marked.use 是「合并」语义，只覆盖 heading，其余方法保持默认。
  // 每次调用都重新注册一次，后注册的覆盖先注册的，不会累积。
  marked.use({
    renderer: {
      heading(token) {
        // 用 token.raw 去掉 # 前缀（比 token.text 更贴近原始写法，且能覆盖标题尾部 #）
        const markdown = String(token.raw || token.text || '')
          .replace(/^\s{0,3}#{1,6}[ \t]*/, '')
          .replace(/[ \t]+#+[ \t]*$/, '');
        const inner = renderInlineMarkdown(markdown);
        const plain = stripTags(inner);

        let id = slugify(plain) || `section-${headingIds.length + 1}`;
        const seen = usedIds.get(id) || 0;
        usedIds.set(id, seen + 1);
        if (seen > 0) id = `${id}-${seen}`;

        if (collectHeadings) {
          headingIds.push({ id, text: plain, level: Number(token.depth) || 1 });
        }

        return `<h${token.depth} id="${escapeHtml(id)}">${inner}</h${token.depth}>\n`;
      },

      /**
       * 围栏代码块：做构建时语法高亮。
       *
       * 注意 marked **在调用渲染器之前就已经转义**了 token.text
       * （`<` 变 `&lt;`、`"` 变 `&quot;`），所以 highlightCode 内部是
       * 「先解码 → 高亮 → 再统一转义」，避免出现 `&amp;lt;` 这种双重转义。
       *
       * 语言标识挂在 token.lang 上（实测字段为 type/raw/lang/text），
       * 形如 "go"、"java"；可能带额外参数（```go title=x），只取第一段。
       */
      code(token) {
        const lang = String(token.lang || '').trim().split(/\s+/)[0] || '';
        const highlighted = highlightCode(token.text, lang);
        // 未标注语言时不加 language-* 类，避免生成无意义的 class="language-"
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        return `<pre><code${cls}>${highlighted}</code></pre>\n`;
      }
    }
  });

  try {
    html = marked.parse(coerceMarkdown(md));
  } catch (error) {
    // marked 对畸形输入极少数情况下会抛（例如内部 tokenizer 出错）。
    // 构建管线不该因为一篇文章渲染失败就整体挂掉：退化为空串。
    if (process.env.HALO_MD_DEBUG) console.error('[markdown] parse threw:', error);
    html = '';
  }

  if (typeof html !== 'string') html = '';

  if (collectHeadings && options && typeof options === 'object') {
    // 原地填充，而不是 options.headingIds = headingIds。
    // 整体重新赋值时调用方持有的那个数组对象不会被更新（实测过），
    // 而调用方通常就是「先建好数组再传进来」，所以必须改原数组本身。
    const target = options.headingIds;
    if (Array.isArray(target)) {
      target.length = 0;
      for (const heading of headingIds) target.push(heading);
    } else {
      options.headingIds = headingIds;
    }
  }

  const transform = options && typeof options.transform === 'function' ? options.transform : null;
  if (transform) {
    try {
      const transformed = transform(html);
      if (typeof transformed === 'string') html = transformed;
    } catch {
      // transform 是调用方的代码，它失败时保留未后处理的结果，而不是往上抛。
    }
  }

  return html;
}
