/**
 * build-lang-chart.mjs — 用 GitHub 官方 API 生成首页「语言分布方块城市」
 *
 * 为什么放在构建时而不是浏览器里（这是关键决策）：
 *   · 官方 API 未认证时只有 60 次/小时/**IP**，而且这个额度是访客共享的
 *     （公司、学校、运营商 NAT 出口会互相挤掉），页面上实时查迟早会被限流；
 *   · Actions 的内置 token 是 1000 次/小时/**仓库**，构建时查一次，
 *     访客打开页面时零请求、零配额消耗，还能被 CDN 缓存。
 *   所以：构建时生成静态 SVG 内联进页面。
 *
 * 用法：
 *   node scripts/build-lang-chart.mjs                          # 用 GITHUB_TOKEN / GH_TOKEN
 *   node scripts/build-lang-chart.mjs --token ghp_xxx
 *   node scripts/build-lang-chart.mjs --from-file data.json    # 离线：用已保存的数据
 *   node scripts/build-lang-chart.mjs --out assets/data/lang-chart.html
 *
 * 输出：一段 HTML 片段（SVG + 图例），由 build-home.mjs 注入 index.html 的
 *       LANG_CHART_START / LANG_CHART_END 标记之间。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderLangCity, renderLangDonut, renderLangLegend } from './lang-chart.mjs';

/* ---------------- 可在命令行覆盖的配置 ---------------- */

/**
 * 方块城市的观感参数。
 * 城市是 cols × rows 的等距地块网，空位画灰色地面，有效方块按占比分配。
 *
 * ⚠️ 网格与方块总数是**体积大户**：100×42 配 680 个方块曾让首页
 * 从 15KB 涨到 427KB（每个方块是三条 path、每个空位一条 path）。
 * 调大这两个值前先量一下产物大小。
 */
export const CITY_COLS = 14;          // 地块列数
export const CITY_ROWS = 6;           // 地块行数
export const CITY_STRIDE = 30;        // 地块间距（屏幕尺度基准）
export const CITY_FOOTPRINT = 0.82;   // 方块地面占地比例，<1 才留出街道缝隙
export const CITY_MAX_HEIGHT = 62;    // 最高方块的像素高度
export const CITY_MIN_HEIGHT = 7;     // 最矮方块的高度下限
export const CITY_BLOCK_TOTAL = 28;   // 有效方块总数（方块更多、高度更矮）
/**
 * 排布方式（对应 lang-chart.mjs 的 layoutGrid）：
 *   'corner'         聚在屏幕右下角那一个角（确定性）
 *   'corner-scatter' 贴右下角随机分布
 *   'right-middle'   中间偏右随机分布（当前）
 *   'scatter'        全网格随机散布
 *   'row-major'      按行优先填充（调试用）
 * 命令行可临时覆盖：--corner / --corner-scatter / --right-middle / --scatter
 */
export const CITY_MODE = 'right-middle';
/**
 * 'right-middle' / 'corner-scatter' 的距离权重（越小越散）。
 *
 * ⚠️ 这个值的量级必须和「随机项」匹配，否则加权会**失效**：
 *    打分公式是 score = random() - 距离 × 权重，
 *    其中 random() ∈ [0,1]，而网格内离锚点的最远距离约 16 个单位。
 *    所以权重一旦到 0.55，距离项跨度就有 0~8.9，完全压过随机项 ——
 *    选出来的永远是「离锚点最近的那批」，成了又紧又死的一簇。
 *
 *    实测（网格越密、最远距离越大，权重阈值也越低；下面是 20×8、28 个方块时的数据）：
 *      w=0     平均离锚点 6.5，遍布全网格
 *      w=0.05  平均 3.9，覆盖 70%
 *      w=0.1   平均 3.1，覆盖 53%   ← 当前：围绕锚点散开，仍有明显聚集感
 *      w=0.25  平均 2.5，覆盖 44%
 *      w=0.55  平均 2.2，覆盖 35%   ← 过紧，像一坨
 */
export const CITY_SCATTER_AMOUNT = 0.1;
/**
 * Others 的散布系数：在 CITY_SCATTER_AMOUNT 基础上再乘这个值（< 1 = 比主语言更散）。
 *
 * 当前取 **1.0 = 不额外放宽**：实测下来「所有语言都在锚点附近散开」本身就好看，
 * 再单独给 Others 拉开距离反而破坏了整体的聚集感。
 * 若哪天想突出「Others 是零碎的一堆」，可以调小（三档实测：
 * 1.0 → 平均离锚点 3.03、0.25 → 4.24、0.1 → 6.04）。
 */
export const CITY_OTHERS_SPREAD = 1.0;
/** 随机排布的种子；改这个值就换一种散布，但同值永远同布局 */
export const CITY_SEED = 20260929;
/**
 * 前 N 种语言各自单独成行，**第 N 名之后**才全部合并进 Others。
 *
 * 取 3：只列使用最多的前三名，其余全进 Others。
 *
 * ⚠️ 这个值和 CITY_FORCE_OTHERS **叠加**，不是二选一：
 *      先剔除 CITY_FORCE_OTHERS 里的语言，再从剩下的里取前 CITY_KEEP 名。
 *    例如当前配置（KEEP=3、排除 HTML/CSS/ShaderLab）下，
 *    单独列出的是「排除那三个之后的前 3 名」，其余归 Others。
 *
 * ⚠️ 这个值曾被误设成 2，结果 HTML / Go / Python 全被合并进 Others，
 *    图例里看不到 Python。改这个值等于改「列前几名」，务必想清再动。
 */
export const CITY_KEEP = 5;
/**
 * 强制并入 Others 的语言名（大小写不敏感）。
 *
 * 用途：某个语言你不想让它单独占一行 —— 可能是量级不匹配、
 * 或者是工具链语言（HTML/CSS/ShaderLab 之类）不算「编程主力」。
 *
 * 规则：**先剔除这个列表里的语言，再从剩下的里取前 CITY_KEEP 名**。
 * 所以名单和 CITY_KEEP 会叠加，例如这里放 3 个、CITY_KEEP 又是 5，
 * 最终单独列出的就是「排除这 3 个之后的前 5 名」。
 *
 * 想改就直接改这个数组，加名字即可（不用管大小写）。
 */
export const CITY_FORCE_OTHERS = ['HTML', 'CSS', 'ShaderLab'];

/** 圆环图尺寸（比城市更小，作为右侧辅助视图） */
export const DONUT_SIZE = 168;
export const DONUT_THICKNESS = 22;

/* ---------------- 数据源配置 ---------------- */

const DEFAULT_REPO = 'MoHanFox/MoHanFox.github.io';
const DEFAULT_OWNER = 'MoHanFox';
/**
 * Gitee 账号（可选，留空则只用 GitHub 数据）。
 * Gitee 的 /languages 接口比 GitHub 还详细：直接给每种语言的字节数与占比，
 * 所以两边的数据可以精确相加合并。
 */
const DEFAULT_GITEE_OWNER = 'MoHanBi';
const DEFAULT_OUT = 'assets/data/lang-chart.html';
const DATA_CACHE = 'assets/data/lang-chart.json';
const USER_AGENT = 'halo-lang-chart-builder';
/** 单次构建最多查多少个仓库的语言明细（每个仓库一次请求） */
const MAX_REPO_DETAIL = 30;
/** 仓库超过这个数量时，不再逐个查明细，改用 /repos 的 language + size 估算 */
const DETAIL_FALLBACK_THRESHOLD = 60;

/* ---------------- 工具 ---------------- */

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

/** 读 JSON，坏了就返回 null（守卫里用，不该因为旧缓存损坏而中断构建） */
function safeReadJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return null;
    }
}

function tokenFrom(args) {
    return args.token
        || process.env.GITHUB_TOKEN
        || process.env.GH_TOKEN
        || '';
}

function headers(token) {
    const head = {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) head.Authorization = `Bearer ${token}`;
    return head;
}

async function getJson(url, token) {
    const response = await fetch(url, { headers: headers(token) });
    if (!response.ok) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        const hint = response.status === 403 && remaining === '0'
            ? '（配额用尽，请带 --token 或设置 GITHUB_TOKEN）'
            : '';
        throw new Error(`GET ${url} 失败：HTTP ${response.status}${hint}`);
    }
    return response.json();
}

/* ---------------- 取数 ---------------- */

/** 某用户的公开仓库列表（排除 fork，fork 的语言统计不属于本人） */
export async function fetchRepos(owner, token) {
    const repos = [];
    for (let page = 1; page <= 5; page += 1) {
        const url = `https://api.github.com/users/${encodeURIComponent(owner)}/repos` +
            `?per_page=100&page=${page}&sort=updated&type=owner`;
        const batch = await getJson(url, token);
        if (!Array.isArray(batch) || !batch.length) break;
        repos.push(...batch);
        if (batch.length < 100) break;
    }
    return repos.filter((repo) => repo && !repo.fork && !repo.archived);
}

/**
 * 汇总语言字节数。
 * 优先用 /repos/{owner}/{repo}/languages 拿到精确字节数（与 GitHub 语言条一致）；
 * 仓库太多时退回按 /repos 的 language + size 估算，避免把配额打满。
 */
export async function collectLanguages(repos, token, log) {
    const bytes = new Map();
    const add = (name, value) => {
        if (!name || !value) return;
        bytes.set(name, (bytes.get(name) || 0) + value);
    };

    const useDetail = repos.length <= DETAIL_FALLBACK_THRESHOLD;
    if (!useDetail) {
        log(`仓库较多（${repos.length}），改用 language + size 估算，避免耗尽配额`);
        repos.forEach((repo) => {
            if (repo.language) add(repo.language, Math.max(1, Number(repo.size) || 1) * 1024);
        });
        return bytes;
    }

    const targets = repos.slice(0, MAX_REPO_DETAIL);
    if (repos.length > MAX_REPO_DETAIL) {
        log(`仓库超过 ${MAX_REPO_DETAIL} 个，只统计最近更新的 ${MAX_REPO_DETAIL} 个`);
    }

    for (const repo of targets) {
        try {
            const detail = await getJson(
                `https://api.github.com/repos/${repo.full_name}/languages`, token);
            Object.keys(detail).forEach((name) => add(name, Number(detail[name]) || 0));
        } catch (error) {
            // 单个仓库失败（空仓库、超大仓库 422 等）不该让整张图失败：退回估算
            log(`  ${repo.name}：${error.message} → 退回按 size 估算`);
            if (repo.language) add(repo.language, Math.max(1, Number(repo.size) || 1) * 1024);
        }
    }
    return bytes;
}

/** Map -> [{name, bytes}]，按字节降序 */
export function toLanguageList(bytes) {
    return [...bytes.entries()]
        .map(([name, value]) => ({ name, bytes: value }))
        .filter((item) => item.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes);
}

/* ---------------- Gitee ---------------- */

/**
 * Gitee 的公开仓库列表。
 * 注意：Gitee 的仓库对象**没有 size 字段**（GitHub 有），所以这里只用来拿仓库名，
 * 语言统计必须走 /languages 接口。
 */
export async function fetchGiteeRepos(owner, log) {
    const repos = [];
    for (let page = 1; page <= 5; page += 1) {
        const url = `https://gitee.com/api/v5/users/${encodeURIComponent(owner)}/repos` +
            `?per_page=100&page=${page}&sort=updated`;
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) throw new Error(`Gitee 仓库列表失败：HTTP ${response.status}`);
        const batch = await response.json();
        if (!Array.isArray(batch) || !batch.length) break;
        repos.push(...batch);
        if (batch.length < 100) break;
    }
    // 排除 fork：别人的代码不该算进自己的语言分布
    return repos.filter((repo) => repo && !repo.fork);
}

/**
 * 汇总 Gitee 各仓库的语言字节数。
 *
 * /languages 返回 { languages: [{ language, bytes, percent }] }，直接可用。
 * 但实测**只有部分仓库**支持该接口（其余返回 404），那些仓库只能用
 * /repos 里的主语言字段兜底。
 *
 * 兜底的量级怎么定：Gitee 的仓库对象**没有 size 字段**，无法估算体积，
 * 所以取「已拿到明细的仓库里，平均每种语言的字节数」再乘一个保守系数。
 * 早先这里只给 1 字节，等于把那些仓库完全忽略 —— 会让 Java / C++ / JavaScript
 * 这类只在兜底仓库里出现的语言被严重低报。
 */
export async function collectGiteeLanguages(repos, log) {
    const bytes = new Map();
    const fallback = [];   // 只能拿到主语言的仓库
    const targets = repos.slice(0, MAX_REPO_DETAIL);

    for (const repo of targets) {
        const url = `https://gitee.com/api/v5/repos/${repo.full_name}/languages`;
        try {
            const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const list = Array.isArray(data) ? data : (data && data.languages) || [];
            let used = 0;
            list.forEach((item) => {
                const name = item && item.language;
                const value = Number(item && item.bytes);
                if (name && value > 0) {
                    bytes.set(name, (bytes.get(name) || 0) + value);
                    used += value;
                }
            });
            if (!used) fallback.push(repo);
        } catch (error) {
            // 404 是常态（该仓库不提供明细），不算错误，只是要兜底
            if (!/404/.test(error.message)) log(`  Gitee ${repo.name}：${error.message}`);
            fallback.push(repo);
        }
    }

    // 兜底：给一个保守的量级估计。
    // 系数刻意取小（0.2）—— 这是**估算值**，不该和精确字节数同等权重；
    // 它的作用只是别让只在兜底仓库里出现的语言从图上消失。
    if (fallback.length) {
        const known = [...bytes.values()];
        const average = known.length
            ? known.reduce((acc, value) => acc + value, 0) / known.length
            : 0;
        const estimate = Math.round(average * 0.2);
        fallback.forEach((repo) => {
            if (!repo.language) return;   // 连主语言都没有（如空仓库）就跳过
            bytes.set(repo.language, (bytes.get(repo.language) || 0) + estimate);
        });
        log(`  有 ${fallback.length} 个仓库无语言明细，按主语言保守估计（每个约 ${estimate} 字节）`);
    }

    return bytes;
}

/** 把多个来源的「语言 → 字节数」合并成一张表，并记录每个来源贡献了多少 */
export function mergeLanguageBytes(sources) {
    const bytes = new Map();
    const bySource = {};
    sources.forEach((source) => {
        let total = 0;
        source.bytes.forEach((value, name) => {
            bytes.set(name, (bytes.get(name) || 0) + value);
            total += value;
        });
        bySource[source.label] = { languages: source.bytes.size, bytes: total };
    });
    return { bytes, bySource };
}

/* ---------------- 渲染 ---------------- */

/**
 * 生成注入用的 HTML 片段：
 * 左栏 = 方块城市，右栏 = 二维圆环占比图 + 图例（图上不写字，数值放图例）。
 * 数据为空时返回中性占位（而不是空字符串），避免页面上留一片空白。
 */
export function buildFragment(data, generatedAt, options) {
    const opts = options || {};
    const languages = (data && data.languages) || [];
    if (!languages.length) {
        return '<p class="lang-city-empty">还没有可用于统计的公开仓库。</p>';
    }

    const mode = opts.mode || CITY_MODE;

    // 三处必须用同一套参数，否则配色与分组会对不上号
    const shared = {
        keep: CITY_KEEP,
        total: CITY_BLOCK_TOTAL,
        forceOthers: CITY_FORCE_OTHERS
    };
    const city = renderLangCity({ languages }, Object.assign({}, shared, {
        cols: CITY_COLS,
        rows: CITY_ROWS,
        stride: CITY_STRIDE,
        footprint: CITY_FOOTPRINT,
        maxHeight: CITY_MAX_HEIGHT,
        minHeightPx: CITY_MIN_HEIGHT,
        mode: mode,
        scatterAmount: CITY_SCATTER_AMOUNT,
        othersSpread: CITY_OTHERS_SPREAD,
        seed: CITY_SEED
    }));
    const donut = renderLangDonut({ languages }, Object.assign({}, shared, {
        size: DONUT_SIZE,
        thickness: DONUT_THICKNESS
    }));
    const legend = renderLangLegend({ languages }, shared);
    // 数据来源可能不止一个（GitHub + Gitee），按实际来源生成说明
    const sourceNames = Object.keys((data && data.sources) || {})
        .map((key) => (key === 'gitee' ? 'Gitee' : 'GitHub'));
    const sourceLabel = sourceNames.length ? sourceNames.join(' + ') : 'GitHub';
    const stamp = generatedAt
        ? `<p class="lang-city-note">数据生成于 ${escapeText(generatedAt)}，由 ${sourceLabel} 开放 API 统计各仓库语言字节数后合并。</p>`
        : '';

    return '<div class="lang-panel">' +
        `<div class="lang-panel-city">${city}</div>` +
        '<div class="lang-panel-chart">' +
        `<div class="lang-panel-donut">${donut}</div>` +
        `<div class="lang-panel-legend">${legend}</div>` +
        '</div>' +
        '</div>' + stamp;
}

function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ---------------- 主流程 ---------------- */

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const owner = args.owner || DEFAULT_OWNER;
    const outPath = resolve(args.out || DEFAULT_OUT);
    const cachePath = resolve(args.cache || DATA_CACHE);
    const log = (message) => console.log(`[lang-chart] ${message}`);

    let data;
    if (args['from-file']) {
        const file = resolve(String(args['from-file']));
        data = JSON.parse(readFileSync(file, 'utf8'));
        log(`离线模式：读取 ${file}`);
    } else {
        const token = tokenFrom(args);
        const sources = [];

        // ---- GitHub ----
        log(token ? '使用 token 查询 GitHub API' : '未提供 token：仅 60 次/小时，仓库多时可能失败');
        const repos = await fetchRepos(owner, token);
        log(`GitHub 公开非 fork 仓库 ${repos.length} 个`);
        const ghBytes = await collectLanguages(repos, token, log);
        sources.push({ label: 'github', bytes: ghBytes });

        // ---- Gitee（可选；失败不影响 GitHub 数据）----
        const giteeOwner = args.gitee === undefined ? DEFAULT_GITEE_OWNER : String(args.gitee);
        if (giteeOwner && giteeOwner !== 'false') {
            try {
                const giteeRepos = await fetchGiteeRepos(giteeOwner, log);
                log(`Gitee 公开非 fork 仓库 ${giteeRepos.length} 个（账号 ${giteeOwner}）`);
                const giteeBytes = await collectGiteeLanguages(giteeRepos, log);
                sources.push({ label: 'gitee', bytes: giteeBytes });
            } catch (error) {
                log(`Gitee 取数失败：${error.message} → 只使用 GitHub 数据`);
            }
        }

        const merged = mergeLanguageBytes(sources);
        const languages = toLanguageList(merged.bytes);
        const origin = sources.map((s) => s.label).join(' + ');
        log(`合并 ${origin}：${languages.length} 种语言`);
        log(languages.slice(0, 8).map((item) => `${item.name}(${item.bytes})`).join(', '));

        // ---- 数据完整性守卫 ----
        // 某个来源失败时（Gitee 未认证调用会被限流返回 403、GitHub 配额用尽等），
        // 上面会「优雅降级」成只用剩下的来源。那会让图表**静默退化成半份数据**，
        // 而且后面的写缓存会把上一次的完整数据覆盖掉 —— 这比直接报错更糟：
        // 首页悄悄少了几种语言，没有任何提示。
        // 所以这里比一比：本次语言数明显少于已有数据就拒绝写入并非零退出。
        if (existsSync(cachePath)) {
            const previous = safeReadJson(cachePath);
            const before = Array.isArray(previous && previous.languages)
                ? previous.languages.length : 0;
            if (before >= 3 && languages.length < before * 0.7) {
                throw new Error(
                    `本次只统计到 ${languages.length} 种语言，上一次是 ${before} 种，` +
                    `疑似某个来源取数失败（本次成功来源：${origin}）。` +
                    `为避免首页的图退化成半份数据，已拒绝写入，产物保留上一次结果。` +
                    `请稍后重试，或配置 GITHUB_TOKEN、降低调用频率。`);
            }
        }

        data = {
            generatedAt: new Date().toISOString(),
            owner,
            giteeOwner: giteeOwner && giteeOwner !== 'false' ? giteeOwner : null,
            repoCount: repos.length,
            sources: merged.bySource,
            languages
        };
    }

    // 缓存原始数据：便于排查、也便于将来换数据源时对比
    const languages = (data && data.languages) || [];
    if (languages.length) {
        if (!existsSync(dirname(cachePath))) mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        log(`已写入数据缓存 ${cachePath}`);
    }

    const stamp = data && data.generatedAt
        ? new Date(data.generatedAt).toISOString().slice(0, 10)
        : '';
    // 排布方式：命令行 --corner / --right-middle / --scatter 可临时覆盖配置
    const mode = args['corner-scatter'] ? 'corner-scatter'
        : (args['right-middle'] ? 'right-middle'
            : (args.scatter ? 'scatter' : (args.corner ? 'corner' : CITY_MODE)));
    log(`排布方式：${mode}（种子 ${CITY_SEED}）`);
    const fragment = buildFragment(data, stamp, { mode: mode });

    // 数据为空时**不覆盖**已有产物：宁可让首页继续用上一版可用的图，
    // 也不要用「还没有可用数据」把好不容易生成的城市冲掉。
    if (!languages.length) {
        if (existsSync(outPath)) {
            log('本次没有统计到任何语言，保留已有产物不覆盖');
            return;
        }
        log('本次没有统计到任何语言，且无历史产物，写入中性占位');
    }

    if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, fragment + '\n', 'utf8');
    log(`已生成 ${outPath}（${fragment.length} 字节）`);
}

// 仅在被直接执行时跑主流程，被 import 时只导出函数（便于测试）
const isDirectRun = process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
    main().catch((error) => {
        console.error(`[lang-chart] 失败：${error.message}`);
        process.exit(1);
    });
}
