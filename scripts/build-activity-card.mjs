/**
 * build-activity-card.mjs — 抓取「账号活跃」卡片并内联进首页
 *
 * 为什么放在构建时（与语言分布同一套理由）：
 *   · 访客打开页面时零请求，不会被大陆网络拦截、不需要等第三方响应；
 *   · 第三方 SVG 直接进 HTML，首屏就位，不占额外连接；
 *   · 第三方挂了也只是这一块回退到上一版产物，不影响整站。
 *
 * 数据源：streak-stats 的公共实例（返回 SVG，含贡献日历与连续天数）。
 *
 * 用法：
 *   node scripts/build-activity-card.mjs
 *   node scripts/build-activity-card.mjs --user MoHanFox --from-file saved.svg
 *   node scripts/build-activity-card.mjs --out assets/data/activity-card.html
 *
 * 容错：抓取失败时**不覆盖**已有产物（保留上一版可用卡片）并非零退出，
 * 与 build-lang-chart.mjs 的守卫一致。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_USER = 'MoHanFox';
const DEFAULT_OUT = 'assets/data/activity-card.html';
const DEFAULT_SOURCE = 'https://streak-stats.demolab.com';
const USER_AGENT = 'halo-activity-card-builder';

export function parseArgs(argv) {
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

/** 只接受看起来像 SVG 的响应，避免把第三方的错误页原样内联进站点 */
export function looksLikeSvg(text) {
    return typeof text === 'string'
        && text.trim().length > 200
        && /<svg[\s>]/i.test(text);
}

/**
 * 把第三方 SVG 变成可内联的片段。
 * 1) 去掉 XML 声明与外层 <style> 里的动画无关部分不动，只做最小必要处理；
 * 2) 加一个包裹容器便于样式控制（第三方 SVG 尺寸/字体不受本站令牌影响）。
 */
export function buildFragment(svg) {
    const cleaned = String(svg)
        .replace(/<\?xml[\s\S]*?\?>/gi, '')
        .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
        .trim();
    return '<div class="activity-card">' + cleaned + '</div>';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const user = args.user || DEFAULT_USER;
    const outPath = resolve(args.out || DEFAULT_OUT);
    const log = (message) => console.log(`[activity] ${message}`);

    let svg;
    if (args['from-file']) {
        const file = resolve(String(args['from-file']));
        svg = readFileSync(file, 'utf8');
        log(`离线模式：读取 ${file}`);
    } else {
        const base = String(args.source || DEFAULT_SOURCE).replace(/\/$/, '');
        const url = `${base}/?user=${encodeURIComponent(user)}&hide_border=true&locale=zh`;
        log(`抓取 ${url}`);
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'image/svg+xml,*/*' }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        svg = await response.text();
    }

    if (!looksLikeSvg(svg)) {
        throw new Error('响应不是有效的 SVG（可能是第三方错误页），拒绝写入');
    }

    const fragment = buildFragment(svg);
    if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, fragment + '\n', 'utf8');
    log(`已生成 ${outPath}（${fragment.length} 字节）`);
}

const isDirectRun = process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
    main().catch((error) => {
        // 不覆盖已有产物：宁可首页继续用上一版卡片，也不要写进坏内容
        console.error(`[activity] 失败：${error.message}（保留已有产物不覆盖）`);
        process.exit(1);
    });
}
