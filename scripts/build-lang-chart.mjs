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
import { renderLangCity, renderLangLegend } from './lang-chart.mjs';

/* ---------------- 可在命令行覆盖的配置 ---------------- */

/** 方块城市的外观参数。方块总数 = CITY_WIDTH × CITY_ROWS。 */
export const CITY_WIDTH = 7;   // 网格列数
export const CITY_ROWS = 6;    // 网格行数
export const CITY_BLOCK_SIZE = 15;   // 单块地面边长
export const CITY_BLOCK_HEIGHT = 11; // 单块高度（所有方块同高）
export const CITY_FOOTPRINT = 0.76;  // 占地比例：小于 1 才有「街道」缝隙

const DEFAULT_REPO = 'MoHanFox/MoHanFox.github.io';
const DEFAULT_OWNER = 'MoHanFox';
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

/* ---------------- 渲染 ---------------- */

/**
 * 生成注入用的 HTML 片段。
 * 数据为空时返回一段中性占位（而不是空字符串），避免页面上留一片空白。
 */
export function buildFragment(data, generatedAt) {
    const languages = (data && data.languages) || [];
    if (!languages.length) {
        return '<p class="lang-city-empty">还没有可用于统计的公开仓库。</p>';
    }

    const total = CITY_WIDTH * CITY_ROWS;
    const options = {
        width: CITY_WIDTH,
        blockSize: CITY_BLOCK_SIZE,
        blockHeight: CITY_BLOCK_HEIGHT,
        footprint: CITY_FOOTPRINT,
        blockTotal: total
    };

    const svg = renderLangCity({ languages }, options);
    const legend = renderLangLegend({ languages }, total);
    const stamp = generatedAt
        ? `<p class="lang-city-note">数据生成于 ${escapeText(generatedAt)}，由 GitHub 官方 API 统计各仓库语言字节数。</p>`
        : '';

    return `<div class="lang-city-wrap">${svg}${legend}</div>${stamp}`;
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
        log(token ? '使用 token 查询 GitHub API' : '未提供 token：仅 60 次/小时，仓库多时可能失败');
        const repos = await fetchRepos(owner, token);
        log(`公开非 fork 仓库 ${repos.length} 个`);
        const bytes = await collectLanguages(repos, token, log);
        const languages = toLanguageList(bytes);
        log(`统计到 ${languages.length} 种语言：` +
            languages.slice(0, 6).map((item) => `${item.name}(${item.bytes})`).join(', '));
        data = {
            generatedAt: new Date().toISOString(),
            owner,
            repoCount: repos.length,
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
    const fragment = buildFragment(data, stamp);

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
