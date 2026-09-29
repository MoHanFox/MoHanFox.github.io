/**
 * lang-chart.mjs — 语言分布「方块城市」等距图
 *
 * 数据来自 GitHub 官方 API（见 scripts/build-lang-chart.mjs），本文件只负责渲染：
 * 纯函数 (data) -> SVG 字符串，不联网、不碰 DOM，因此构建时与浏览器里都能用。
 *
 * 设计：
 *   · 所有方块**同高**，语言占比体现在**方块数量**上 —— 一片铺开的小城市，
 *     而不是高低不一的柱状图。
 *   · **不用彩虹**：颜色全部由站点主色 --color-primary #2d6bef 派生，
 *     同色系深浅，保证与主页其它板块统一。
 *   · 每个方块画三个面（顶 / 左 / 右）制造等距立体感。
 *
 * 坐标系：方块用网格坐标 (x, y) 表示地面位置，映射到等距屏幕坐标
 *   sx = (x - y) * BLOCK * COS30
 *   sy = (x + y) * BLOCK * SIN30
 */

/**
 * 同色系调色板：第 0 个是站点主色，其余按**从深到浅**单调排列。
 *
 * 单调这件事很重要：语言按占比降序排列，占比大的用深色、小的用浅色，
 * 读图时亮度本身就是一条信息。若色阶忽深忽浅，图例和方块就对不上号了。
 *
 * 8 级足够覆盖常见语言数；更多语言时色阶会回绕（此时占比已经很接近，
 * 靠图例区分即可）。
 */
export var PALETTE = [
    '#1b47b8',
    '#245ad4',
    '#2d6bef', // 站点主色
    '#4a80f2',
    '#6b96f5',
    '#8dacf8',
    '#aec3fb',
    '#cfd9fc'
];

var ISO_COS30 = Math.cos(Math.PI / 6);
var ISO_SIN30 = 0.5;

/** 数字收敛，避免 SVG 里出现 12.000000000000002 这类脏值 */
function n(value) {
    return Math.round(value * 100) / 100;
}

/** 默认方块总数 = 网格宽 × 3 行 */
export function defaultBlockTotal(width) {
    return Math.max(1, width) * 3;
}

/**
 * 把每种语言的占比换算成方块数量（最大余数法）。
 *
 * 两个刻意的设计：
 *   · 每种语言**至少 1 块** —— 否则占比很小的语言会显示成 0 块，等于凭空消失。
 *     因此实际方块总数可能略多于 total（语言种类多时）。
 *   · 语言种类多于方块总数时，总数会被抬高到语言数，保证每块地都有人住。
 */
export function apportionBlocks(languages, total) {
    var list = (languages || []).filter(function (item) {
        return item && item.bytes > 0 && item.name;
    });
    if (!list.length) return [];

    var sum = list.reduce(function (acc, item) { return acc + item.bytes; }, 0);
    if (sum <= 0) return [];

    var slots = Math.max(total, list.length);
    var exact = list.map(function (item) { return (item.bytes / sum) * slots; });
    var base = exact.map(function (value) { return Math.floor(value); });
    var used = base.reduce(function (acc, value) { return acc + value; }, 0);

    // 余数从大到小补足剩余名额
    var order = exact
        .map(function (value, index) { return { index: index, rest: value - Math.floor(value) }; })
        .sort(function (a, b) { return b.rest - a.rest; });
    for (var i = 0; i < order.length && used < slots; i++) {
        base[order[i].index] += 1;
        used += 1;
    }

    // 兜底补足（理论上到不了这里）
    var cursor = 0;
    while (used < slots) {
        base[cursor % base.length] += 1;
        used += 1;
        cursor += 1;
    }

    // 至少 1 块
    base = base.map(function (value) { return Math.max(1, value); });

    return list.map(function (item, index) {
        return { name: item.name, bytes: item.bytes, blocks: base[index] };
    });
}

/**
 * 把方块排进等距网格。蛇形填充（偶数行向右、奇数行向左）：
 * 每行都紧接上一行末尾，城市连成一片，不会留出大片空洞。
 */
export function layoutCity(groups, width) {
    var cells = [];
    groups.forEach(function (group) {
        for (var i = 0; i < group.blocks; i++) cells.push(group);
    });

    var w = Math.max(1, width);
    return cells.map(function (group, index) {
        var row = Math.floor(index / w);
        var col = index % w;
        // 奇数行反向 → 蛇形
        var x = row % 2 === 0 ? col : (w - 1 - col);
        return { x: x, y: row, group: group };
    });
}

/** 一个等距方块的三个面（顶 / 左 / 右）的 path 数据 */
function blockPaths(px, py, size, height) {
    var halfW = size * ISO_COS30;
    var halfH = size * ISO_SIN30;
    var top = [
        [px, py - halfH],
        [px + halfW, py],
        [px, py + halfH],
        [px - halfW, py]
    ];
    var path = function (points) {
        return 'M' + points.map(function (p) { return n(p[0]) + ',' + n(p[1]); }).join('L') + 'Z';
    };
    // 左面与右面从顶面的下半两条边向下延伸
    return {
        top: path(top),
        left: path([top[3], top[2],
            [top[2][0], n(top[2][1] + height)],
            [top[3][0], n(top[3][1] + height)]]),
        right: path([top[1], top[2],
            [top[2][0], n(top[2][1] + height)],
            [top[1][0], n(top[1][1] + height)]])
    };
}

/** 同色系派生：顶面用原色，左面稍暗，右面最暗，形成稳定的光照方向 */
function shade(hex, amount) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return hex;
    var value = parseInt(m[1], 16);
    var channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    var target = amount < 0 ? 0 : 255;
    var ratio = Math.abs(amount);
    return '#' + channels.map(function (channel) {
        var mixed = Math.round(channel + (target - channel) * ratio);
        return mixed.toString(16).padStart(2, '0');
    }).join('');
}

function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 语言名 → 调色板颜色，保证同一语言在图上与图例里颜色一致 */
function colorOf(name) {
    var index = 0;
    var list = arguments[1] || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].name === name) { index = i; break; }
    }
    return PALETTE[index % PALETTE.length];
}

/**
 * 渲染城市 SVG。
 *
 * 关于「城市感」的两个关键参数：
 *   · footprint —— 方块在地面上的占地比例。设为小于 1 的值让每个方块缩小一点，
 *     块与块之间就出现缝隙（街道），城市才立得起来；否则所有方块会贴合成一整块板。
 *     注意缩的是**地面占地**，方块高度不变，所以「同高」这个要求依然成立。
 *   · blockTotal —— 方块总数。数量越多、格子越小，越像一片城市而不是几个大方块。
 *
 * @param {{languages: Array<{name:string, bytes:number}>}} data
 * @param {{blockSize?:number, blockHeight?:number, width?:number, blockTotal?:number, footprint?:number}} [options]
 * @returns {string} SVG 字符串；没有数据时返回空串
 */
export function renderLangCity(data, options) {
    var opts = options || {};
    var size = opts.blockSize || 30;
    var height = opts.blockHeight || Math.round(size * 0.62);
    var width = opts.width || 5;
    var total = opts.blockTotal || defaultBlockTotal(width);
    var footprint = typeof opts.footprint === 'number' ? opts.footprint : 0.78;

    var groups = apportionBlocks((data && data.languages) || [], total);
    if (!groups.length) return '';

    var placed = layoutCity(groups, width);
    var cell = size * footprint; // 实际占地边长
    var inset = (size - cell) / 2; // 居中偏移

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var marks = placed.map(function (place) {
        // 网格中心 + 内缩，使每个方块在格子内居中
        var px = (place.x - place.y) * size * ISO_COS30;
        var py = (place.x + place.y) * size * ISO_SIN30 + inset * ISO_SIN30;
        minX = Math.min(minX, px - cell * ISO_COS30);
        maxX = Math.max(maxX, px + cell * ISO_COS30);
        minY = Math.min(minY, py - cell * ISO_SIN30);
        maxY = Math.max(maxY, py + cell * ISO_SIN30 + height);
        return { paths: blockPaths(px, py, cell, height), color: colorOf(place.group.name, groups) };
    });

    var pad = n(size * 0.5);
    var box = [n(minX - pad), n(minY - pad),
        n(maxX - minX + pad * 2), n(maxY - minY + pad * 2)].join(' ');

    var body = marks.map(function (mark) {
        return '<g>' +
            '<path d="' + mark.paths.left + '" fill="' + shade(mark.color, -0.18) + '"/>' +
            '<path d="' + mark.paths.right + '" fill="' + shade(mark.color, -0.36) + '"/>' +
            '<path d="' + mark.paths.top + '" fill="' + mark.color + '"/>' +
            '</g>';
    }).join('');

    return '<svg class="lang-city" xmlns="http://www.w3.org/2000/svg" viewBox="' + box + '" ' +
        'role="img" aria-label="语言分布：每种语言的方块数量代表其占比">' +
        body + '</svg>';
}

/**
 * 图例：色块 + 语言名 + 百分比。
 * 等距斜面上的文字很难读，所以数值放在图外的图例里。
 * @param {{languages: Array}} data
 * @param {number} [total] 必须与 renderLangCity 用同一个方块总数，否则百分比与图上块数对不上
 */
export function renderLangLegend(data, total) {
    var groups = apportionBlocks((data && data.languages) || [], total || defaultBlockTotal(5));
    if (!groups.length) return '';

    var sum = groups.reduce(function (acc, item) { return acc + item.bytes; }, 0);
    var items = groups.map(function (group) {
        var share = Math.round((group.bytes / sum) * 1000) / 10;
        return '<li class="lang-legend-item">' +
            '<span class="lang-legend-swatch" style="background:' + colorOf(group.name, groups) + '"></span>' +
            '<span class="lang-legend-name">' + escapeText(group.name) + '</span>' +
            '<span class="lang-legend-share">' + share + '%</span>' +
            '</li>';
    }).join('');

    return '<ul class="lang-legend">' + items + '</ul>';
}
