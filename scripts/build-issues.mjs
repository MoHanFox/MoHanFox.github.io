#!/usr/bin/env node
/**
 * scripts/build-issues.mjs
 *
 * 把 GitHub Issue 变成博客数据：
 *   带 `blog` label 的 issue -> pages/blog/data/issues.json（部署到 gh-pages 的静态数据）
 *
 * 设计约束（与 .github/workflows/blog.yml 配套）：
 *   - 纯 Node ESM，零第三方依赖，只用 Node 内置模块（fetch 为 Node 18+ 内置全局）。
 *   - 只读 GitHub REST API，不写仓库源码，唯一产物是 --out 指定的 JSON（默认
 *     pages/blog/data/issues.json）。CI 中该产物只进 gh-pages，不回写 dev 分支。
 *   - 失败（网络错误 / 非 2xx / 夹具非法）时非零退出，并且**不触碰**已有的
 *     issues.json —— 写入采用「临时文件 + rename」的原子替换，避免用空文件
 *     覆盖上一轮的好数据。
 *
 * 用法：
 *   node scripts/build-issues.mjs                       # CI：需要 GITHUB_TOKEN / GITHUB_REPOSITORY
 *   node scripts/build-issues.mjs --from-file fx.json   # 离线：从夹具读取 issue 数组，跳过网络
 *   node scripts/build-issues.mjs --out /tmp/x.json     # 覆盖输出路径
 *   node scripts/build-issues.mjs --repo owner/name     # 覆盖仓库（默认取 GITHUB_REPOSITORY）
 *
 * 环境变量：
 *   GITHUB_TOKEN       GitHub token（CI 里是 secrets.GITHUB_TOKEN）。缺省时仍可运行，
 *                      但未认证请求限速 60 次/小时，脚本会打印告警。
 *   GITHUB_REPOSITORY  "owner/repo"（Actions 自动注入）。
 *   GITHUB_API_URL     可选，API 基地址（GitHub Enterprise 用），默认 https://api.github.com。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 只有带这个 label 的 issue 才算文章。 */
export const POST_LABEL = 'blog';
/** 带这个 label 的 issue 一律不发布。 */
export const DRAFT_LABEL = 'draft';
/**
 * 小说模式标签：命中后文章按「换行即分段」的小说排版渲染。
 * 它属于**控制类标签**，和 `blog` 一样只控制构建行为 ——
 * 因此不会显示成文章标签，也不会生成分类目录项（由 build-blog 统一过滤）。
 */
export const NOVELMODE_TAGS = ['novel render'];
/** 没有 <!--more--> 标记时，摘录取正文的前 N 个字符。 */
export const EXCERPT_LIMIT = 200;
/** REST 分页大小。 */
export const PER_PAGE = 100;
/** 分页安全上限，避免异常响应导致死循环（50 * 100 = 5000 条）。 */
export const MAX_PAGES = 50;
/** 默认输出路径（仓库根目录相对路径）。 */
export const DEFAULT_OUT = 'pages/blog/data/issues.json';
/** 命中「更多」分隔符：<!--more--> / <!-- more --> 都算。 */
export const MORE_MARKER = /<!--\s*more\s*-->/i;

const USER_AGENT = 'mohanfox-blog-build-issues';

// ---------------------------------------------------------------------------
// 日志（stdout 给进度，stderr 给警告/错误）
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[build-issues] ${msg}`);
}

function warn(msg) {
  console.warn(`[build-issues] WARN: ${msg}`);
}

// ---------------------------------------------------------------------------
// 文本处理：纯函数，便于离线单测
// ---------------------------------------------------------------------------

/** 把连续空白（含换行）折叠成单个空格并 trim。 */
export function collapseWhitespace(input) {
  return String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 剥标签时标签位置被替换成了空格，会出现 "link ." 这种标点前多一个空格的情况。
 * 这里把紧贴在收尾标点前的空白去掉（中英文标点都覆盖）。
 */
export function tidyPunctuation(input) {
  return String(input ?? '').replace(/\s+([.,!?;:%)\]}\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a\uff09\u3011\u300b\u300d\u300f])/g, '$1');
}

/** 剥掉 HTML 注释 / script / style / 标签（标签替换成空格，避免相邻文本粘连）。 */
export function stripHtml(input) {
  return String(input ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/**
 * 把 Markdown 链接 [文字](url) 压成纯文字。
 * 顺带把图片 ![alt](url) 压成 alt 文字（否则会残留一个孤立的 "!"）。
 */
export function flattenMarkdownLinks(input) {
  return String(input ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * 摘录规则：
 *   1. 取 body 中首个 <!--more--> 之前的内容；
 *   2. 没有该标记则取前 200 个字符（在剥离之前按原始 Markdown 计长）；
 *   3. 剥 HTML 标签 -> 压平 Markdown 链接 -> 折叠空白 -> 收尾标点前不留空格。
 *
 * 注意「先截断、后剥离」的顺序是刻意为之：规格里写的是「没有该标记则取**前 200
 * 字符**」，所以 200 是按原始 Markdown 计长的。剥掉标签后长度会略少于 200。
 */
export function buildExcerpt(body) {
  const raw = typeof body === 'string' ? body : '';
  const markerIndex = raw.search(MORE_MARKER);
  const sliced = markerIndex >= 0 ? raw.slice(0, markerIndex) : raw.slice(0, EXCERPT_LIMIT);
  return tidyPunctuation(collapseWhitespace(flattenMarkdownLinks(stripHtml(sliced))));
}

/** 把 REST 的 labels 归一化成名字数组；兼容 [{name}] 与 ["name"] 两种形状。 */
export function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  for (const label of labels) {
    const name =
      typeof label === 'string' ? label : label && typeof label.name === 'string' ? label.name : null;
    if (name && name.trim()) out.push(name.trim());
  }
  return out;
}

/** REST issue -> 输出条目。 */
export function normalizeIssue(issue) {
  const labels = labelNames(issue.labels);
  const tags = labels.filter((name) => name.toLowerCase() !== POST_LABEL && name.toLowerCase() !== DRAFT_LABEL);
  const body = typeof issue.body === 'string' ? issue.body : '';
  // 作者取自 issue 的创建者。user 可能缺失（例如 API 返回被裁剪），所以逐层判空。
  const author =
    issue.user && typeof issue.user.login === 'string' ? issue.user.login.trim() : '';
  return {
    number: typeof issue.number === 'number' ? issue.number : Number(issue.number) || 0,
    title: typeof issue.title === 'string' ? issue.title.trim() : '',
    author,
    url: issue.html_url || issue.url || '',
    state: typeof issue.state === 'string' ? issue.state : '',
    createdAt: issue.created_at || null,
    updatedAt: issue.updated_at || null,
    labels,
    tags,
    body,
    excerpt: buildExcerpt(body),
  };
}

/**
 * 按 issue **序号从高到低**排序。
 *
 * 早先是按 updatedAt 倒序，结果是「改了一下旧文章，它就窜到列表最前面」——
 * 对读者来说顺序会莫名其妙地变。issue 号本身就是稳定的发布顺序，
 * 用它能保证「新写的在最上面，旧文章修改后仍留在原位」。
 *
 * 兜底：没有 number 的数据（例如旧版本生成的文件）退回按创建时间倒序；
 * 号相同（不该发生）再按 updatedAt 倒序，保证排序结果稳定。
 */
export function sortIssues(issues) {
  const ts = (value) => {
    const parsed = Date.parse(value ?? '');
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return [...issues].sort((a, b) => {
    const byNumber = (Number(b.number) || 0) - (Number(a.number) || 0);
    if (byNumber !== 0) return byNumber;
    const byCreated = ts(b.createdAt) - ts(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return ts(b.updatedAt) - ts(a.updatedAt);
  });
}

/**
 * 过滤 + 归一化 + 排序：
 *   - 排除 pull_request（REST 的 issues 接口会把 PR 混进来）；
 *   - 排除带 draft label 的 issue；
 *   - 排除畸形条目。
 */
export function selectIssues(rawIssues) {
  const list = Array.isArray(rawIssues) ? rawIssues : [];
  return sortIssues(
    list
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .filter((item) => !item.pull_request)
      .filter((item) => !labelNames(item.labels).some((name) => name.toLowerCase() === DRAFT_LABEL))
      .map(normalizeIssue),
  );
}

// ---------------------------------------------------------------------------
// 网络：REST GET /repos/{owner}/{repo}/issues
// ---------------------------------------------------------------------------

/** 解析 Link 响应头里的 rel="next"。 */
export function nextLink(header) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next') return match[1];
  }
  return null;
}

function issuesUrl(apiBase, repo, page) {
  const [owner, name] = repo.split('/');
  const query = new URLSearchParams({
    state: 'all',
    labels: POST_LABEL,
    per_page: String(PER_PAGE),
    page: String(page),
    sort: 'updated',
    direction: 'desc',
  });
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?${query}`;
}

async function fetchIssues({ apiBase, repo, token }) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is unavailable: Node 18+ is required (CI uses Node 20).');
  }

  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const collected = [];
  let page = 1;
  let url = issuesUrl(apiBase, repo, page);

  for (;;) {
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      // 网络层失败（DNS / TLS / 连接中断）——直接抛出，绝不落盘。
      throw new Error(`network error while calling ${apiBase}/repos/${repo}/issues: ${error?.message ?? error}`);
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 500);
      } catch {
        detail = '<unreadable response body>';
      }
      throw new Error(
        `GitHub API responded ${response.status} ${response.statusText} (page ${page}).\n` +
          `  url: ${apiBase}/repos/${repo}/issues?...page=${page}\n` +
          `  body: ${detail || '<empty>'}`,
      );
    }

    let batch;
    try {
      batch = await response.json();
    } catch (error) {
      throw new Error(`GitHub API returned non-JSON body (page ${page}): ${error?.message ?? error}`);
    }
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub API returned unexpected payload (page ${page}): expected an array of issues`);
    }

    collected.push(...batch);
    log(`page ${page}: +${batch.length} raw item(s), accumulated ${collected.length}`);

    const linkNext = nextLink(response.headers.get('link'));
    if (linkNext) {
      if (page >= MAX_PAGES) {
        warn(`stopped at MAX_PAGES=${MAX_PAGES}; some issues may be missing`);
        break;
      }
      page += 1;
      url = linkNext;
      continue;
    }

    // 没有 Link 头时退化为「满页则继续」。
    if (batch.length < PER_PAGE) break;
    if (page >= MAX_PAGES) {
      warn(`stopped at MAX_PAGES=${MAX_PAGES}; some issues may be missing`);
      break;
    }
    page += 1;
    url = issuesUrl(apiBase, repo, page);
  }

  return collected;
}

// ---------------------------------------------------------------------------
// 写盘：临时文件 + rename（原子替换，失败不破坏旧数据）
// ---------------------------------------------------------------------------

export async function writeJsonAtomic(outPath, payload) {
  const dir = path.dirname(outPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tempPath, outPath);
  return outPath;
}

/**
 * 读出现有产物里的 count，用来做「不许静默清空」的判定。
 * 文件不存在 / 不是 JSON / 没有 count 时一律当作「没有可保护的数据」。
 */
export async function readExistingCount(outPath) {
  try {
    const parsed = JSON.parse(await readFile(outPath, 'utf8'));
    return Number.isFinite(parsed?.count) ? parsed.count : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node scripts/build-issues.mjs [options]

Options:
  --from-file <path>  Read a JSON fixture (array of issue objects, or {"issues":[...]})
                      instead of calling the GitHub API. Network is skipped entirely.
                      Offline runs do NOT require GITHUB_TOKEN, but the output's "repo"
                      field comes from --repo / $GITHUB_REPOSITORY; without either it
                      is written as null. Pass e.g. --repo owner/repo to fill it in.
  --out <path>        Output path (default: ${DEFAULT_OUT}).
  --repo <owner/repo> Repository to query (default: $GITHUB_REPOSITORY).
  --allow-empty       Allow replacing a non-empty existing output with an empty one.
                      By default the script REFUSES to do that when the API returned
                      ZERO raw items (suspicious: label renamed, token lost read
                      access, or a 200 with an empty body). Legitimate emptying of
                      the dataset (the last post lost its "blog" label / was deleted)
                      needs this flag or ALLOW_EMPTY=1. A zero COUNT that still had
                      raw items (all drafts/PRs) is written without the flag.
  -h, --help          Show this help.

Environment:
  GITHUB_TOKEN        Token for the REST API (optional; unauthenticated is rate limited).
  GITHUB_REPOSITORY   "owner/repo".
  GITHUB_API_URL      API base URL (default: https://api.github.com).
  ALLOW_EMPTY         "1"/"true" behaves like --allow-empty (used by the workflow).`);
}

export function parseArgs(argv) {
  const opts = {
    fromFile: null,
    out: DEFAULT_OUT,
    repo: process.env.GITHUB_REPOSITORY || '',
    allowEmpty: /^(1|true|yes)$/i.test(String(process.env.ALLOW_EMPTY ?? '').trim()),
    help: false,
  };
  // index 先声明再被 takeValue 闭包引用（顺序刻意如此，避免任何 TDZ 疑虑）。
  let index = 0;
  const takeValue = (flag, inline) => {
    if (inline !== undefined) {
      if (!inline) throw new Error(`missing value for ${flag}`);
      return inline;
    }
    const next = argv[++index];
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${flag}`);
    return next;
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from-file') opts.fromFile = takeValue('--from-file', undefined);
    else if (arg.startsWith('--from-file=')) opts.fromFile = takeValue('--from-file', arg.slice('--from-file='.length));
    else if (arg === '--out') opts.out = takeValue('--out', undefined);
    else if (arg.startsWith('--out=')) opts.out = takeValue('--out', arg.slice('--out='.length));
    else if (arg === '--repo') opts.repo = takeValue('--repo', undefined);
    else if (arg.startsWith('--repo=')) opts.repo = takeValue('--repo', arg.slice('--repo='.length));
    else if (arg === '--allow-empty') opts.allowEmpty = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.out && !String(opts.out).trim()) throw new Error('--out must not be empty');
  return opts;
}

/**
 * 当前 run 真正要写的输出路径。写盘失败时用来如实报出「哪个文件没被动过」，
 * 而不是写死默认路径（用户可能用 --out 指了别处）。
 */
let activeOutPath = path.resolve(DEFAULT_OUT);

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printUsage();
    return 0;
  }

  const outPath = path.resolve(opts.out);
  activeOutPath = outPath;
  const repo = String(opts.repo || '').trim();
  let rawIssues;

  if (opts.fromFile) {
    const fixturePath = path.resolve(opts.fromFile);
    log(`offline mode: reading fixture ${fixturePath} (network skipped)`);
    let text;
    try {
      text = await readFile(fixturePath, 'utf8');
    } catch (error) {
      throw new Error(`cannot read fixture "${fixturePath}": ${error?.message ?? error}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`fixture "${fixturePath}" is not valid JSON: ${error?.message ?? error}`);
    }
    if (Array.isArray(parsed)) rawIssues = parsed;
    else if (parsed && Array.isArray(parsed.issues)) rawIssues = parsed.issues;
    else
      throw new Error(
        `fixture "${fixturePath}" must be a JSON array of issue objects, or an object with an "issues" array`,
      );
    log(`fixture loaded: ${rawIssues.length} raw item(s)`);
  } else {
    if (!repo) {
      throw new Error(
        'GITHUB_REPOSITORY is not set (expected "owner/repo"). Pass --repo owner/repo for a local run.',
      );
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error(`GITHUB_REPOSITORY must look like "owner/repo", got "${repo}"`);
    }
    if (!process.env.GITHUB_TOKEN) {
      warn('GITHUB_TOKEN is not set — unauthenticated GitHub API requests are limited to 60/hour.');
    }
    const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    log(`fetching issues with label "${POST_LABEL}" from ${repo} via ${apiBase}`);
    rawIssues = await fetchIssues({ apiBase, repo, token: process.env.GITHUB_TOKEN });
    log(`fetched ${rawIssues.length} raw item(s) (includes PRs and drafts, filtered next)`);
  }

  const issues = selectIssues(rawIssues);

  // 「不许静默清空」保护：API 正常返回 200，但一条 raw 都没有，而现有产物是非空的。
  // 这种组合几乎不可能是用户本意（更像是改了 label 名、token 丢了读权限、或 200 空 body），
  // 所以默认拒绝覆盖而非写空。注意：raw>0 但过滤后为 0（全是 draft/PR）是合法结果，照写。
  if (rawIssues.length === 0 && !opts.allowEmpty) {
    const existingCount = await readExistingCount(outPath);
    if (existingCount > 0) {
      throw new Error(
        `refusing to overwrite ${outPath}: the API returned 0 issues for labels="${POST_LABEL}" ` +
          `but the existing file has count=${existingCount}.\n` +
          '  If the dataset really should become empty (last post unlabeled or deleted), re-run with\n' +
          '  --allow-empty (or set ALLOW_EMPTY=1).',
      );
    }
  }

  if (issues.length === 0) {
    warn(
      rawIssues.length === 0
        ? `API returned 0 raw items; writing count=0 with publishable data = 0 (allowed: ${opts.allowEmpty ? 'yes' : 'no existing data to protect'}).`
        : 'no publishable issue after filtering (PRs excluded, "draft" excluded). Writing count=0.',
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    repo: repo || null,
    count: issues.length,
    issues,
  };

  await writeJsonAtomic(outPath, payload);
  log(`wrote ${outPath} (count=${payload.count}, generatedAt=${payload.generatedAt})`);
  return 0;
}

// ---------------------------------------------------------------------------
// 入口：仅在直接执行本文件时才跑 main()，被 import 时保持纯函数可用
// ---------------------------------------------------------------------------

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
      console.error(`[build-issues] FAILED: ${error?.message ?? error}`);
      console.error(`[build-issues] aborting: no output written, ${activeOutPath} left untouched.`);
      process.exitCode = 1;
    });
}
