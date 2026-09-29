/**
 * build-home.mjs — 把构建产物注入首页 index.html
 *
 * 首页里有若干「生成物区域」，各用两个标记括起来：
 *     <!-- LANG_CHART_START -->
 *     ...构建时替换...
 *     <!-- LANG_CHART_END -->
 *     <!-- ACTIVITY_CARD_START -->
 *     ...
 *     <!-- ACTIVITY_CARD_END -->
 * 本脚本把对应片段填进去。
 *
 * 为什么用标记而不是 {{TOKEN}}：
 *   index.html 是要长期手工编辑的源文件，标记形式在编辑器里一眼能看出
 *   「这块是机器写的，别手改」，也不会和模板语法混淆。
 *
 * 用法：
 *   node scripts/build-home.mjs            # 注入全部已配置的区域
 *   node scripts/build-home.mjs --check    # 只检查标记是否存在，不写文件
 *
 * 幂等：重复执行结果一致（标记保留，只换中间内容）。
 * 某个片段文件不存在时**跳过该区域并保留原内容**，不会把页面挖空。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 区域的唯一来源：加新板块只要在这里加一条 */
export const SECTIONS = [
    { name: '语言分布', start: '<!-- LANG_CHART_START -->', end: '<!-- LANG_CHART_END -->', file: 'assets/data/lang-chart.html' },
    { name: '账号活跃', start: '<!-- ACTIVITY_CARD_START -->', end: '<!-- ACTIVITY_CARD_END -->', file: 'assets/data/activity-card.html' }
];

const DEFAULT_OUT = 'index.html';

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

/**
 * 把片段注入到两个标记之间。
 * 找不到标记时抛错而不是静默跳过 —— 否则页面会悄悄少掉整整一个板块。
 */
export function injectSection(html, fragment, start, end, label) {
    const name = label || 'index.html';
    const startAt = html.indexOf(start);
    const endAt = html.indexOf(end);
    if (startAt < 0 || endAt < 0) {
        throw new Error(`${name} 里找不到标记 ${start} / ${end}`);
    }
    if (endAt < startAt) {
        throw new Error(`${name} 里标记顺序反了：${end} 出现在 ${start} 之前`);
    }

    const before = html.slice(0, startAt + start.length);
    const after = html.slice(endAt);

    // 片段自身缩进到与标记同级，保持文件整洁
    const indent = ' '.repeat(20);
    const body = fragment
        .trim()
        .split('\n')
        .map((line) => (line.trim() ? indent + line : line))
        .join('\n');

    return before + '\n' + body + '\n' + ' '.repeat(20) + after;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const outPath = resolve(String(args.out || DEFAULT_OUT));

    if (!existsSync(outPath)) {
        throw new Error(`找不到 ${outPath}`);
    }
    let html = readFileSync(outPath, 'utf8');

    if (args.check) {
        const missing = SECTIONS.filter((section) =>
            html.indexOf(section.start) < 0 || html.indexOf(section.end) < 0);
        if (missing.length) {
            throw new Error(`检查失败：${outPath} 缺少标记 → ` +
                missing.map((s) => `${s.name}(${s.start})`).join(', '));
        }
        console.log(`[build-home] 标记检查通过：${outPath}（${SECTIONS.length} 个区域）`);
        return;
    }

    let changed = 0;
    let skipped = 0;

    SECTIONS.forEach((section) => {
        const chartPath = resolve(section.file);
        if (!existsSync(chartPath)) {
            // 产物不存在就原样保留：宁可留上一版内容，也不要把板块挖空
            console.log(`[build-home] 跳过「${section.name}」：找不到 ${section.file}`);
            skipped += 1;
            return;
        }
        const fragment = readFileSync(chartPath, 'utf8');
        const next = injectSection(html, fragment, section.start, section.end, outPath);
        if (next === html) {
            console.log(`[build-home] 「${section.name}」内容无变化`);
        } else {
            html = next;
            changed += 1;
            console.log(`[build-home] 已注入「${section.name}」（${fragment.length} 字节）`);
        }
    });

    if (changed > 0) {
        writeFileSync(outPath, html, 'utf8');
        console.log(`[build-home] 已写入 ${outPath}（更新 ${changed} 个区域，跳过 ${skipped} 个）`);
    } else {
        console.log(`[build-home] 无需写入（更新 0 个区域，跳过 ${skipped} 个）`);
    }
}

const isDirectRun = process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
    try {
        main();
    } catch (error) {
        console.error(`[build-home] 失败：${error.message}`);
        process.exit(1);
    }
}
