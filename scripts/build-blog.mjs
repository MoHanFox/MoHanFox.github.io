#!/usr/bin/env node
/**
 * scripts/build-blog.mjs
 *
 * 把 scripts/build-issues.mjs 抓到的 issues.json 渲染成博客静态页面：
 *
 *   pages/blog/data/issues.json
 *        ├─> pages/blog/index.html            文章列表
 *        └─> pages/blog/post-{number}.html    每篇文章详情（正文由 Markdown 渲染）
 *
 * 设计要点：
 *   - 页面骨架来自 assets/templates/blog/*.html，脚本只做 {{TOKEN}} 替换，
 *     因此调整博客版式不需要改这个脚本。
 *   - 正文渲染交给 scripts/markdown.mjs（构建时渲染而非浏览器渲染：利于 SEO、首屏更快）。
 *   - issue 的 title / tags 等字段一律经 escapeHtml 转义后才嵌入 HTML。
 *   - 全部产物先在内存里拼好、再删除过期文章页，最后才落盘：
 *     中途失败不会留下半成品，也不会让链接指向已删除的页面。
 *
 * 用法：
 *   node scripts/build-blog.mjs                  # 用默认路径
 *   node scripts/build-blog.mjs --data <path>    # 指定 issues.json
 *   node scripts/build-blog.mjs --out-dir <dir>  # 指定输出目录
 *   node scripts/build-blog.mjs --check          # 只校验不写盘（发现过期文件即失败）
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { renderMarkdown, escapeHtml, toPlainText, markedVersion } from './markdown.mjs';

const DEFAULT_DATA = 'pages/blog/data/issues.json';
const DEFAULT_OUT_DIR = 'pages/blog';
const TEMPLATE_DIR = 'assets/templates/blog';
const POST_FILE_PREFIX = 'post-';
/** 更新与创建相差超过这个天数才提示「编辑于」 */
const EDIT_HINT_DAYS = 2;
/** giscus（评论）配置；缺失时文章页照常生成，只是不显示评论区 */
const GISCUS_CONFIG_FILE = 'giscus.json';
const GISCUS_STYLE_TAG =
  '    <!-- 评论区样式（与博客样式分开，未启用评论时不加载） -->\n' +
  '    <link rel="stylesheet" href="../../assets/css/pages/blog/giscus.css">';
/** 文章页右侧章节导航：少于这个标题数就不显示（一两个标题没必要占一栏） */
const TOC_MIN_HEADINGS = 2;

/* ------------------------------------------------------------------ */
/* 参数与工具                                                          */
/* ------------------------------------------------------------------ */

/** 读取 giscus 配置。文件不存在时返回 null（表示「未启用评论」），不视为错误 */
export async function readGiscusConfig(file = GISCUS_CONFIG_FILE) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`读取 ${file} 失败：${error?.message ?? error}`);
  }

  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('顶层必须是一个对象');
    }
    return config;
  } catch (error) {
    // 配置文件写坏属于明确的操作失误，直接失败比静默不显示评论区更好
    throw new Error(`解析 ${file} 失败：${error?.message ?? error}`);
  }
}

/** 该配置是否足以真正加载 giscus */
export function isGiscusReady(config) {
  if (!config || config.enabled === false) return false;
  for (const key of ['repo', 'repoId', 'category', 'categoryId']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) return false;
  }
  return true;
}

/** 生成 giscus 的 <script> 标签（属性值全部转义） */
function renderGiscusScript(config) {
  const attr = (name, value) => `        ${name}="${escapeHtml(String(value))}"`;
  const bool = (value) => (value ? '1' : '0');

  return [
    '        <script src="https://giscus.app/client.js"',
    attr('data-repo', config.repo),
    attr('data-repo-id', config.repoId),
    attr('data-category', config.category),
    attr('data-category-id', config.categoryId),
    attr('data-mapping', config.mapping || 'pathname'),
    attr('data-strict', bool(config.strict)),
    attr('data-reactions-enabled', bool(config.reactionsEnabled !== false)),
    attr('data-emit-metadata', bool(config.emitMetadata)),
    attr('data-input-position', config.inputPosition || 'bottom'),
    attr('data-theme', config.theme || 'preferred_color_scheme'),
    attr('data-lang', config.lang || 'zh-CN'),
    config.loading === 'lazy' ? '        loading="lazy"' : '',
    '        crossorigin="anonymous"',
    '        async>',
    '        </script>'
  ].filter((line) => line !== '').join('\n');
}

/**
 * 文章页的评论区区块。
 *   - 配置齐全：渲染 giscus 容器 + 脚本；
 *   - 配置缺失或未启用：返回空串（不显示评论区）；
 *   - 显式开启但缺 id：渲染一张配置指引卡片，避免「开了却什么都没显示」的困惑。
 */
export function renderComments(config) {
  if (!config || config.enabled === false) return { html: '', style: '' };
  if (!isGiscusReady(config)) return { html: renderGiscusSetup(), style: GISCUS_STYLE_TAG };

  const html = [
    '        <section class="blog-comments">',
    '            <h2 class="blog-comments-title">评论</h2>',
    '            <!-- giscus 会把评论 iframe 放进这个容器 -->',
    '            <div class="giscus"></div>',
    renderGiscusScript(config),
    '        </section>'
  ].join('\n');

  return { html, style: GISCUS_STYLE_TAG };
}

/**
 * 文章页右侧章节导航（竖排 `-` 刻度 + 标题，点击定位、滚动高亮）。
 * 标题数与锚点 id 由 renderMarkdown 的 headingIds 提供，与正文里的 id 同源。
 * 标题少于 TOC_MIN_HEADINGS 时返回空，不显示这一栏。
 */
export function renderToc(headings) {
  const list = Array.isArray(headings) ? headings : [];
  if (list.length < TOC_MIN_HEADINGS) return { html: '', style: '', script: '' };

  const items = list.map((heading) => {
    const level = Math.min(Math.max(Number(heading.level) || 1, 2), 6);
    const href = `#${encodeURIComponent(heading.id)}`;
    // 点击时阻止默认跳转并手动平滑滚动到标题上方一点，保证不被固定导航遮住
    const onclick = ` onclick="event.preventDefault();var t=document.getElementById(decodeURIComponent(this.getAttribute('href').slice(1)));` +
      `if(t){window.scrollTo({top:t.getBoundingClientRect().top+window.scrollY-84,behavior:'smooth'});` +
      `history.replaceState(null,'',this.getAttribute('href'));}"`;
    return `        <li class="blog-toc-item blog-toc-item--${level}">` +
      `<a class="blog-toc-link" href="${escapeHtml(href)}" title="${escapeHtml(heading.text)}"${onclick}>` +
      `<span class="blog-toc-tick"></span><span class="blog-toc-label">${escapeHtml(heading.text)}</span>` +
      '</a></li>';
  });

  const html = [
    '    <aside class="blog-toc" data-toc aria-label="文章目录">',
    '        <p class="blog-toc-title">目录</p>',
    '        <nav class="blog-toc-nav">',
    '            <ul class="blog-toc-list">',
    items.join('\n'),
    '            </ul>',
    '        </nav>',
    '    </aside>'
  ].join('\n');

  return {
    html,
    style: '    <!-- 章节导航样式 -->\n' +
      '    <link rel="stylesheet" href="../../assets/css/pages/blog/toc.css">',
    script: '    <!-- 章节导航：滚动高亮 -->\n' +
      '    <script src="../../assets/js/toc.js"></script>'
  };
}

/** 配置指引卡片：只在「开了评论但还没填 id」时出现 */function renderGiscusSetup() {
  const missing = ['category', 'categoryId'];
  return [
    '        <section class="blog-comments">',
    '            <h2 class="blog-comments-title">评论</h2>',
    '            <div class="blog-comments-setup">',
    '                <p class="blog-comments-setup-title">评论区即将开放</p>',
    '                <p class="blog-comments-setup-desc">',
    '                    评论基于 GitHub Discussions，无需注册本站账号，也无需后端。',
    '                    站点维护者补齐 <code>giscus.json</code> 里的 ',
    `                    <code>${missing.join('</code> 与 <code>')}</code> 后即会显示评论区。`,
    '                </p>',
    '                <ol class="blog-comments-setup-steps">',
    '                    <li>仓库 Settings → Features 勾选 <code>Discussions</code></li>',
    '                    <li>安装 giscus App：<code>https://github.com/apps/giscus</code></li>',
    '                    <li>在 Discussions 新建一个分类（类型建议 <code>Announcements</code>）</li>',
    '                    <li>打开 <code>https://giscus.app</code>，填入仓库后把 <code>data-category</code> 与 <code>data-category-id</code> 抄进 <code>giscus.json</code></li>',
    '                </ol>',
    '            </div>',
    '        </section>'
  ].join('\n');
}

export function parseArgs(argv) {
  const opts = { data: DEFAULT_DATA, outDir: DEFAULT_OUT_DIR, check: false, allowMissingData: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    if (arg === '--data') opts.data = next();
    else if (arg.startsWith('--data=')) opts.data = arg.slice('--data='.length);
    else if (arg === '--out-dir') opts.outDir = next();
    else if (arg.startsWith('--out-dir=')) opts.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--check') opts.check = true;
    else if (arg === '--allow-missing-data') opts.allowMissingData = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** 模板里所有 {{TOKEN}} 会被替换；未提供的 token 替换为空串 */
export function fillTemplate(template, tokens) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    const value = tokens[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** 列出模板里实际用到的 token，便于校验模板与脚本是否同步 */
export function templateTokens(template) {
  const found = new Set();
  for (const match of template.matchAll(/\{\{([A-Z_]+)\}\}/g)) found.add(match[1]);
  return [...found].sort();
}

/**
 * 模板里出现了脚本未提供的 token 时直接报错。
 * 否则会被静默替换成空串，页面缺一块却毫无提示——这类问题最难排查。
 */
export function assertTokensSupported(template, tokens, label) {
  const supported = new Set(Object.keys(tokens));
  const missing = templateTokens(template).filter((key) => !supported.has(key));
  if (missing.length) {
    throw new Error(`模板 ${label} 使用了脚本未提供的 token：${missing.join(', ')}`);
  }
}

/** 2026-09-29T07:03:56Z -> 2026-09-29 */
export function formatDate(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 两个时间相差是否超过若干天 */
export function daysApart(fromIso, toIso) {
  const a = Date.parse(fromIso ?? '');
  const b = Date.parse(toIso ?? '');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / 86400000;
}

/** meta description 用的单行短摘要 */
export function toMetaText(text, limit = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* 片段渲染                                                            */
/* ------------------------------------------------------------------ */

/** 标签胶囊组；无标签时返回空串（不留空容器） */
function renderTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const items = list
    .filter((tag) => tag !== null && tag !== undefined && String(tag).trim() !== '')
    .map((tag) => `<span class="blog-tag">${escapeHtml(String(tag))}</span>`);
  if (!items.length) return '';
  return `                <div class="blog-tags">${items.join('')}</div>`;
}

/** 文章正文写进 data-content 时保留的最大字符数（搜索结果用，截断只为控制页面体积） */
const SEARCH_CONTENT_LIMIT = 3000;

/** 卡片与文章页共用：作者 - 日期。作者名做成 GitHub 链接（若具备条件），二者之间补一个分隔符。 */
function renderByline(issue) {
  const author = typeof issue.author === 'string' ? issue.author.trim() : '';
  const date = formatDate(issue.createdAt || issue.updatedAt);
  const parts = [];

  if (author) {
    const safeAuthor = escapeHtml(author);
    // 只有看起来是合法 GitHub 用户名时才做成外链，避免把奇怪的值拼进 URL
    const linked = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(author)
      ? `<a class="blog-byline-author" href="https://github.com/${encodeURIComponent(author)}"` +
        ` target="_blank" rel="noopener noreferrer">${safeAuthor}</a>`
      : `<span class="blog-byline-author">${safeAuthor}</span>`;
    parts.push(linked);
  }
  if (author && date) parts.push('<span class="blog-byline-sep" aria-hidden="true">-</span>');
  if (date) parts.push(`<time class="blog-byline-date" datetime="${escapeHtml(isoDate(issue.createdAt || issue.updatedAt))}">${date}</time>`);

  return parts.join('');
}

/** 取出 ISO 日期（YYYY-MM-DD）供 <time datetime> 用；解析失败返回空串 */
function isoDate(value) {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 列表页的一张文章卡。
 * data-cats    分类路径（空格分隔），侧栏据此筛选；
 * data-text    标题+摘要+标签的小写拼接，供「标题、摘要、标签」范围搜索；
 * data-content 正文纯文本（截断到 SEARCH_CONTENT_LIMIT），供「文章内关键字」范围搜索。
 * 三者都在构建时算好，前端搜索不需要发请求。
 */
function renderCard(issue, categories) {
  const number = Number(issue.number) || 0;
  const title = String(issue.title || `（无标题 issue #${number}）`);
  // 摘要可能来自 build-issues（已清理），也可能是手写/旧数据里的原始 Markdown，统一去标记
  const excerpt = toPlainText(issue.excerpt);
  const closed = String(issue.state).toLowerCase() === 'closed';
  const cats = Array.isArray(categories) ? categories : [];
  const searchText = [title, excerpt].concat(Array.isArray(issue.tags) ? issue.tags : [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const contentText = toPlainText(issue.body).slice(0, SEARCH_CONTENT_LIMIT).toLowerCase();

  const lines = [
    `<li class="blog-card" data-cats="${escapeHtml(cats.join(' '))}"` +
    ` data-text="${escapeHtml(searchText)}"` +
    ` data-content="${escapeHtml(contentText)}"` +
    ` data-number="${number}">`,
    `<h2 class="blog-card-title"><a href="./${POST_FILE_PREFIX}${number}.html">${escapeHtml(title)}</a></h2>`,
    '<p class="blog-card-meta">',
    renderByline(issue),
    `<span>#${number}</span>`,
    closed ? '<span class="blog-tag blog-tag--closed">已关闭</span>' : '',
    '</p>'
  ];

  if (excerpt) lines.push(`<p class="blog-card-excerpt">${escapeHtml(excerpt)}</p>`);

  const tags = renderTags(issue.tags);
  if (tags) lines.push(tags);

  return lines.filter((line) => line !== '').map((line) => `                ${line}`).join('\n');
}

/**
 * 从文章的 tags 推导分类路径（支持任意层级）。
 * 约定：标签里的 `/` 表示层级，例如
 *   `Go`            → 顶层分类
 *   `Go/精选`        → Go 下的子栏目
 *   `Go/精选/并发`    → 再下一层，层数不限
 * 返回该文章所属的全部路径（含每一级的祖先，便于父级计数与筛选）。
 */
export function categoryPaths(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const seen = new Set();
  const out = [];

  for (const tag of list) {
    if (tag === null || tag === undefined) continue;
    // 统一分隔符周围的空白，并去掉首尾多余的斜杠
    const normalized = String(tag).trim().replace(/\s*\/\s*/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) continue;

    const segments = normalized.split('/').filter(Boolean);
    // 每一级都记一份，这样「Go」能覆盖「Go/精选」下的文章
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/');
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }

  return out;
}

/**
 * 汇总侧栏用的分类树。
 * 返回根节点数组，每个节点形如
 *   { name, fullPath, count, children: [...] }
 * count 含自身与所有后代的文章数；同层按「文章数降序 → 名称」排序。
 */
export function collectCategories(issues) {
  /** fullPath -> node */
  const nodes = new Map();

  function ensure(path, name) {
    let node = nodes.get(path);
    if (!node) {
      node = { name, fullPath: path, count: 0, children: [] };
      nodes.set(path, node);
    }
    return node;
  }

  for (const issue of issues) {
    // 同一篇文章在同一路径上只计一次
    for (const path of categoryPaths(issue.tags)) {
      const segments = path.split('/');
      const name = segments[segments.length - 1];
      ensure(path, name).count += 1;
    }
  }

  // 按路径层级挂到父节点上
  const roots = [];
  for (const path of [...nodes.keys()].sort()) {
    const node = nodes.get(path);
    const slash = path.lastIndexOf('/');
    if (slash === -1) {
      roots.push(node);
    } else {
      ensure(path.slice(0, slash), path.slice(slash + 1)).children.push(node);
    }
  }

  const sortTree = (list) => {
    list.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'));
    list.forEach((node) => sortTree(node.children));
  };
  sortTree(roots);

  return roots;
}

/**
 * 列表页侧边栏：全部 + 可展开的分类树（任意层级）。
 * 所有按钮都只是前端筛选的开关，不产生新页面。
 */
export function renderSidebar(categories, total) {
  const lines = [];

  const renderNode = (node, depth) => {
    const hasChildren = node.children.length > 0;
    const indent = '                ' + '    '.repeat(depth);

    lines.push(`${indent}<li class="blog-side-group" data-depth="${depth}" style="--depth:${depth}">`);
    lines.push(`${indent}    <div class="blog-side-row">`);
    lines.push(
      `${indent}        <button type="button" class="blog-side-item" data-filter="${escapeHtml(node.fullPath)}" aria-pressed="false">` +
      `<span class="blog-side-name">${escapeHtml(node.name)}</span>` +
      // 箭头紧跟分类名，计数统一靠右，这样展开箭头不会被挤到最右侧
      (hasChildren
        ? `<span class="blog-side-toggle" data-toggle role="button" tabindex="-1" aria-hidden="true" aria-expanded="false"><span class="blog-side-caret"></span></span>`
        : '') +
      `<span class="blog-side-count">${node.count}</span></button>`
    );
    lines.push(`${indent}    </div>`);

    if (hasChildren) {
      lines.push(`${indent}    <ul class="blog-side-subs" data-subs hidden>`);
      node.children.forEach((child) => renderNode(child, depth + 1));
      lines.push(`${indent}    </ul>`);
    }

    lines.push(`${indent}</li>`);
  };

  lines.push('            <aside class="blog-side" data-sidebar aria-label="博客分类">');
  lines.push('                <p class="blog-side-title">分类</p>');
  lines.push('                <ul class="blog-side-list">');
  lines.push(
    '                    <li class="blog-side-group">' +
    '<button type="button" class="blog-side-item blog-side-item--all is-active" data-filter="" aria-pressed="true">' +
    `<span class="blog-side-name">全部</span><span class="blog-side-count">${total}</span></button></li>`
  );
  categories.forEach((node) => renderNode(node, 0));
  lines.push('                </ul>');
  lines.push('            </aside>');

  return lines.join('\n');
}

/** 列表页主体：有文章则列表，没有则给出可操作的引导 */
function renderPostsBlock(issues, categories) {
  if (!issues.length) {
    return [
      '<div class="blog-empty">',
      '<p class="blog-empty-title">暂无内容</p>',
      '<p class="blog-empty-desc">博客文章来自本仓库的 Issue。在仓库里写一篇 Issue 并打上 <code>blog</code> 标签，构建完成后就会出现在这里。</p>',
      '</div>'
    ].map((line) => `        ${line}`).join('\n');
  }

  const cards = issues.map((issue) => renderCard(issue, categoryPaths(issue.tags))).join('\n');
  return `        <ul class="blog-list" data-list>\n${cards}\n        </ul>`;
}

/** 文章页里「编辑于」提示的片段 */
function renderUpdatedHint(issue) {
  if (daysApart(issue.createdAt, issue.updatedAt) < EDIT_HINT_DAYS) return '';
  const date = formatDate(issue.updatedAt);
  return date ? `<span>编辑于 ${date}</span>` : '';
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 依据 issues 数据算出所有待写文件：路径 -> 内容 */
export async function buildPages(payload, repo, giscusConfig = null) {
  const indexTpl = await readFile(path.join(TEMPLATE_DIR, 'index.html'), 'utf8');
  const postTpl = await readFile(path.join(TEMPLATE_DIR, 'post.html'), 'utf8');

  const issues = Array.isArray(payload?.issues) ? payload.issues : [];
  const generatedAt = formatDate(payload?.generatedAt) || '';
  const slug = repo || payload?.repo || '';

  // 评论区：配置齐全才渲染，否则给出指引或直接不显示
  const comments = renderComments(giscusConfig);

  const files = new Map();

  // 分类侧栏（由 issue 的 tags 推导）
  const categories = collectCategories(issues);

  const indexTokens = {
    PAGE_TITLE: '博客 · 漠寒 MOHAN',
    PAGE_DESCRIPTION: toMetaText(`漠寒 MOHAN 的博客，共 ${issues.length} 篇文章，内容来自 GitHub Issues。`),
    SIDEBAR: renderSidebar(categories, issues.length),
    POSTS: renderPostsBlock(issues, categories),
    COUNT: String(issues.length),
    GENERATED_AT: generatedAt,
    REPO: escapeHtml(slug)
  };
  assertTokensSupported(indexTpl, indexTokens, 'index.html');

  files.set('index.html', fillTemplate(indexTpl, indexTokens));

  for (const issue of issues) {
    const number = Number(issue.number) || 0;
    const title = String(issue.title || `（无标题 issue #${number}）`);
    const body = typeof issue.body === 'string' ? issue.body : '';
    // 传入数组即开启标题收集；渲染结束时 marked 会把它填满
    const headingIds = [];
    const content = renderMarkdown(body, { headingIds });
    const excerpt = toPlainText(issue.excerpt) || toMetaText(toPlainText(body));
    const toc = renderToc(headingIds);

    const postTokens = {
      PAGE_TITLE: `${escapeHtml(title)} · 漠寒 MOHAN`,
      PAGE_DESCRIPTION: escapeHtml(toMetaText(excerpt)),
      NUMBER: String(number),
      TITLE: escapeHtml(title),
      // 作者与日期合并成一个 byline（作者 - 日期），模板里不再单独使用 DATE
      AUTHOR: renderByline(issue),
      DATE: formatDate(issue.createdAt || issue.updatedAt),
      UPDATED: renderUpdatedHint(issue),
      STATE: String(issue.state).toLowerCase() === 'closed'
        ? '<span class="blog-tag blog-tag--closed">已关闭</span>'
        : '',
      TAGS: renderTags(issue.tags),
      CONTENT: content,
      ISSUE_URL: escapeHtml(String(issue.url || (slug ? `https://github.com/${slug}/issues/${number}` : '#'))),
      TOC: toc.html,
      TOC_STYLE: toc.style,
      TOC_SCRIPT: toc.script,
      COMMENTS: comments.html,
      GISCUS_STYLE: comments.style
    };
    assertTokensSupported(postTpl, postTokens, `post-${number}.html`);

    files.set(`${POST_FILE_PREFIX}${number}.html`, fillTemplate(postTpl, postTokens));
  }

  return files;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(`Usage: node scripts/build-blog.mjs [options]

Options:
  --data <path>           issues.json 路径（默认 ${DEFAULT_DATA}）
  --out-dir <dir>         输出目录（默认 ${DEFAULT_OUT_DIR}）
  --check                 只校验，不写盘；若存在过期文章页则以非零退出
  --allow-missing-data    没有 issues.json 时按「暂无文章」生成（本地预览用）
  -h, --help              显示帮助`);
    return 0;
  }

  const dataPath = path.resolve(opts.data);
  const outDir = path.resolve(opts.outDir);

  let payload;
  try {
    payload = JSON.parse(await readFile(dataPath, 'utf8'));
  } catch (error) {
    // --allow-missing-data 是给本地预览用的：没有 issues.json 时按「暂无文章」生成，
    // 这样在编辑器里直接打开博客页也能看到样式，而不是 404。
    if (opts.allowMissingData && error && error.code === 'ENOENT') {
      console.log(`[build-blog] 未找到 ${dataPath}，按「暂无文章」生成（--allow-missing-data）`);
      payload = { generatedAt: new Date().toISOString(), repo: null, count: 0, issues: [] };
    } else {
      throw new Error(`读取 ${dataPath} 失败：${error?.message ?? error}（请先运行 scripts/build-issues.mjs，或加 --allow-missing-data 本地预览）`);
    }
  }

  const giscusConfig = await readGiscusConfig();
  const files = await buildPages(payload, payload?.repo, giscusConfig);
  const issues = Array.isArray(payload?.issues) ? payload.issues : [];

  // 找出目录里已存在、但本次不该再有的文章页（文章下线后要清掉，否则留下死链）
  await mkdir(outDir, { recursive: true });
  const existing = await readdir(outDir);
  const stale = existing.filter((name) => {
    if (!name.startsWith(POST_FILE_PREFIX) || !name.endsWith('.html')) return false;
    return !files.has(name);
  });

  if (opts.check) {
    if (stale.length) {
      throw new Error(`${outDir} 存在 ${stale.length} 个过期文章页：${stale.join(', ')}（重新运行去掉 --check 即可清理）`);
    }
    console.log(`[build-blog] 校验通过：${files.size} 个页面待生成，无过期文件`);
    return 0;
  }

  // 先全部渲染（上面的 buildPages 已完成），再清理过期页，最后写盘
  for (const name of stale) {
    await rm(path.join(outDir, name), { force: true });
    console.log(`[build-blog] 已删除过期文章页 ${name}`);
  }

  let bytes = 0;
  for (const [name, content] of files) {
    const target = path.join(outDir, name);
    await writeFile(target, content, 'utf8');
    bytes += Buffer.byteLength(content, 'utf8');
  }

  console.log(`[build-blog] marked ${markedVersion}；已生成 ${files.size} 个页面（${issues.length} 篇文章，${bytes} 字节）→ ${outDir}`);

  // 评论状态值得显式说明：否则「开了评论却没显示」很难排查
  if (!giscusConfig || giscusConfig.enabled === false) {
    console.log('[build-blog] 评论：未启用');
  } else if (isGiscusReady(giscusConfig)) {
    console.log(`[build-blog] 评论：已启用（giscus，分类 ${giscusConfig.category}）`);
  } else {
    const missing = ['repo', 'repoId', 'category', 'categoryId'].filter((key) => {
      const value = giscusConfig[key];
      return typeof value !== 'string' || !value.trim();
    });
    console.log(`[build-blog] 评论：等待补全 ${GISCUS_CONFIG_FILE} 的 ${missing.join(' / ')}（当前显示配置指引卡片）`);
  }

  return 0;
}

// 仅在被直接执行时跑 main()；被 import 时保持纯函数可用。
// 用 import.meta.url 比对而非文件名后缀，避免文件被改名/复制后整个脚本静默不执行。
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    })
    .catch((error) => {
      console.error(`[build-blog] FAILED: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
