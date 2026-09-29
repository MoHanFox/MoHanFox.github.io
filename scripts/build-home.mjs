/**
 * build-home.mjs — 把构建产物注入首页 index.html
 *
 * 首页里有一段「生成物区域」，用两个标记括起来：
 *     <!-- LANG_CHART_START -->
 *     ...构建时替换...
 *     <!-- LANG_CHART_END -->
 * 本脚本把 scripts/build-lang-chart.mjs 产出的片段填进去。
 *
 * 为什么用标记而不是 {{TOKEN}}：
 *   index.html 是要长期手工编辑的源文件，标记形式在编辑器里一眼能看出
 *   「这块是机器写的，别手改」，也不会和模板语法混淆。
 *
 * 用法：
 *   node scripts/build-home.mjs                        # 用默认输入
 *   node scripts/build-home.mjs --chart x.html --out index.html
 *   node scripts/build-home.mjs --check                # 只检查标记是否存在，不写文件
 *
 * 幂等：重复执行结果一致（标记保留，只换中间内容）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const START = '<!-- LANG_CHART_START -->';
const END = '<!-- LANG_CHART_END -->';

const DEFAULT_CHART = 'assets/data/lang-chart.html';
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
 * 找不到标记时抛错而不是静默跳过 —— 否则页面会悄悄少了整整一个板块。
 */
export function injectSection(html, fragment, label) {
    const name = label || 'index.html';
    const start = html.indexOf(START);
    const end = html.indexOf(END);
    if (start < 0 || end < 0) {
        throw new Error(`${name} 里找不到标记 ${START} / ${END}`);
    }
    if (end < start) {
        throw new Error(`${name} 里标记顺序反了：${END} 出现在 ${START} 之前`);
    }

    const before = html.slice(0, start + START.length);
    const after = html.slice(end);

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
    const chartPath = resolve(String(args.chart || DEFAULT_CHART));

    if (!existsSync(outPath)) {
        throw new Error(`找不到 ${outPath}`);
    }
    const html = readFileSync(outPath, 'utf8');

    if (args.check) {
        if (html.indexOf(START) < 0 || html.indexOf(END) < 0) {
            throw new Error(`检查失败：${outPath} 缺少 ${START} / ${END} 标记`);
        }
        console.log(`[build-home] 标记检查通过：${outPath}`);
        return;
    }

    if (!existsSync(chartPath)) {
        throw new Error(
            `找不到语言分布片段 ${chartPath}；请先运行 node scripts/build-lang-chart.mjs`);
    }
    const fragment = readFileSync(chartPath, 'utf8');

    const next = injectSection(html, fragment, outPath);
    if (next === html) {
        console.log('[build-home] 内容无变化，跳过写入');
        return;
    }
    writeFileSync(outPath, next, 'utf8');
    console.log(`[build-home] 已注入语言分布 → ${outPath}（${fragment.length} 字节片段）`);
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
