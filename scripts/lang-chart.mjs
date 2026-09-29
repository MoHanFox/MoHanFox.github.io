/**
 * lang-chart.mjs — 语言分布的等距「方块城市」+ 圆环占比图
 *
 * 视觉目标（对照参考图 gofurry/night-rainbow 的观感）：
 *   · 地面上是一块 **14 列 × 6 行** 的等距地块，每个地块上都立着一个
 *     **长条立方体**（一个整体，不是几个正方体叠起来），高度由它代表的量决定。
 *   · **没有语言的空地块用灰色画出地面**，于是整块地仍是完整的方格网，
 *     而有效的方块穿插其间、朝向**右下角**聚集。
 *   · **同一种语言的方块必须错开**，不能堆在一起 —— 用轮转发牌实现。
 *
 * 等距投影与绘制顺序（这里踩过坑，务必看清）：
 *   把网格坐标 (a, b)（a = 列，b = 行）映射到屏幕：
 *       sx = (a - b) * stride * cos30
 *       sy = (a + b) * stride * sin30
 *   于是 **a 轴朝屏幕右下、b 轴朝屏幕左下**，两者都取最大就是屏幕最下方，
 *   也就是「右下角」。所以「有效值优先靠近右下角」= 从 (cols-1, rows-1)
 *   倒着往前填。
 *   绘制顺序必须按 (a + b) 升序 —— 该值越小离观察者越远，先画；
 *   越大越近，后画才能正确遮挡。若按数组顺序画，远处方块会盖住近处，
 *   看起来"透视反了"。
 */

var ISO_COS30 = Math.cos(Math.PI / 6); // ≈ 0.8660
var ISO_SIN30 = 0.5;

/**
 * 同色系调色板：从深到浅单调排列，第 2 个是站点主色 #2d6bef。
 * 全部蓝色系（不含彩虹），靠明度区分不同语言。
 * 注意：灰色被「空地块」占用，所以这里不含灰色。
 */
export var PALETTE = [
    '#1b47b8',
    '#245ad4',
    '#2d6bef',
    '#4a80f2',
    '#6b96f5',
    '#8dacf8',
    '#aec3fb',
    '#cfd9fc'
];

/** 空地块（没有语言占用）的灰色地面 */
export var GROUND_COLOR = '#e8ebf0';
/** 长尾合并后的显示名 */
export var OTHERS_LABEL = 'Others';

function n(value) {
    return Math.round(value * 100) / 100;
}

function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 同色系派生：顶面用原色，左面稍暗、右面最暗，形成稳定光照方向 */
function shade(hex, amount) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return hex;
    var value = parseInt(m[1], 16);
    var channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    var target = amount < 0 ? 0 : 255;
    var ratio = Math.abs(amount);
    return '#' + channels.map(function (channel) {
        return Math.round(channel + (target - channel) * ratio).toString(16).padStart(2, '0');
    }).join('');
}

/* ---------------- 数据整理 ---------------- */

/**
 * 语言列表 → 绘图用的方块清单。
 *
 * @param {Array<{name:string, bytes:number}>} languages 已按字节降序
 * @param {Object} [options]
 *   keep       主流语言数（其余合并进 Others），默认 5
 *   total      方块总数，默认 14
 *   minHeight  最矮方块的相对高度（0~1），保证长尾也看得见，默认 0.10
 *   forceOthers 强制并入 Others 的语言名数组（大小写不敏感）。
 *               用于「这个名字我不想让它单独占一行」的场景，
 *               例如想突出某几种语言、把其它常见的都收起来。
 *               规则：**先剔除 forceOthers，再从剩下的里取前 keep 名**。
 * @returns {{items:Array, othersShare:number}}
 *   items 中每项含 name / isOthers / share / blocks / height
 *   othersShare 是长尾合计占比（图例最后一行用）
 */
export function planBlocks(languages, options) {
    var opts = options || {};
    var keep = opts.keep || 5;
    var total = opts.total || 14;
    var minHeight = typeof opts.minHeight === 'number' ? opts.minHeight : 0.10;

    var list = (languages || []).filter(function (item) {
        return item && item.name && item.bytes > 0;
    });
    if (!list.length) return { items: [], othersShare: 0 };

    var sum = list.reduce(function (acc, item) { return acc + item.bytes; }, 0);
    if (sum <= 0) return { items: [], othersShare: 0 };

    // 强制并入 Others 的名字（大小写不敏感，顺便 trim）
    var forced = {};
    (opts.forceOthers || []).forEach(function (name) {
        if (typeof name === 'string' && name.trim()) forced[name.trim().toLowerCase()] = true;
    });

    var head = [];
    var tail = [];
    list.forEach(function (item) {
        if (forced[String(item.name).trim().toLowerCase()]) tail.push(item);
        else if (head.length < keep) head.push(item);
        else tail.push(item);
    });

    var othersShare = tail.reduce(function (acc, item) { return acc + item.bytes; }, 0) / sum;

    // 一个方块代表多少量：直接由「总量 ÷ 方块总数」决定，
    // 这样方块数之和就等于配置的总数。
    // 早先这里取过 max(最小语言/1.5, sum/total)，本意是让小语言至少占 1.5 块，
    // 但那会把 unit 抬高、把总方块数压小（14 会变成 6），得不偿失；
    // 「小语言不消失」改用下面的下限 1 块来保证。
    var unit = sum / total;
    if (!Number.isFinite(unit) || unit <= 0) return { items: [], othersShare: 0 };

    var items = head.map(function (item) {
        return {
            name: item.name,
            isOthers: false,
            share: item.bytes / sum,
            blocks: Math.max(1, Math.round(item.bytes / unit))
        };
    });

    // 长尾合并成 others 一组（图例只占一行，但方块仍按占比分配）
    if (tail.length) {
        items.push({
            name: OTHERS_LABEL,
            isOthers: true,
            share: othersShare,
            blocks: Math.max(1, Math.round((othersShare * sum) / unit))
        });
    }

    var maxShare = items.reduce(function (acc, item) {
        return Math.max(acc, item.share);
    }, 0);
    items.forEach(function (item) {
        // Others 只取最低高度：它是「其余语言的合计」，本身不是一种语言，
        // 不该在图上看起来像一根正常的高塔，压到最矮更能表达「零碎的一堆」。
        if (item.isOthers) {
            item.height = minHeight;
            return;
        }
        var ratio = maxShare > 0 ? item.share / maxShare : 0;
        item.height = minHeight + (1 - minHeight) * ratio;
    });

    return { items: items, othersShare: othersShare };
}

/** 语言名 → 颜色；主流按序取调色板，others 取最浅的一档 */
export function colorForIndex(index, isOthers) {
    if (isOthers) return PALETTE[PALETTE.length - 1];
    return PALETTE[index % PALETTE.length];
}

/* ---------------- 地块与方块 ---------------- */

/** 等距地块（地面菱形）的四角 */
function tileCorners(cx, cy, foot) {
    var hw = foot * ISO_COS30;
    var hh = foot * ISO_SIN30;
    return {
        back: [cx, cy - hh],
        right: [cx + hw, cy],
        front: [cx, cy + hh],
        left: [cx - hw, cy]
    };
}

function pathOf(points) {
    return 'M' + points.map(function (p) { return n(p[0]) + ',' + n(p[1]); }).join('L') + 'Z';
}

/**
 * 一个等距长条立方体：地面是单位地块，高度 height。
 * 三个可见面：顶面 + 左侧面 + 右侧面。
 */
function cuboid(cx, cy, foot, height) {
    var c = tileCorners(cx, cy, foot);
    var up = function (p) { return [p[0], n(p[1] - height)]; };
    return {
        top: pathOf([up(c.back), up(c.right), up(c.front), up(c.left)]),
        left: pathOf([c.left, c.front, up(c.front), up(c.left)]),
        right: pathOf([c.front, c.right, up(c.right), up(c.front)])
    };
}

/**
 * 一个可复现的伪随机数发生器（mulberry32）。
 *
 * 为什么不用 Math.random()：
 *   布局由构建时生成、产物提交进仓库。用真随机的话每次构建出来的城市都不一样，
 *   diff 全是噪音，"这个布局我上次觉得挺好" 也复现不出来。
 *   用固定种子就能既随机散布、又完全可复现。
 */
function mulberry32(seed) {
    var state = seed >>> 0;
    return function () {
        state = (state + 0x6D2B79F5) >>> 0;
        var t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher–Yates 洗牌（用给定的随机源，保证可复现） */
function shuffle(list, random) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i -= 1) {
        var j = Math.floor(random() * (i + 1));
        var tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
    }
    return out;
}

/**
 * 计算网格在屏幕坐标下的范围与四角，供各种锚点使用。
 */
function screenExtent(cols, rows) {
    var minX = -((rows - 1) * ISO_COS30);
    var maxX = (cols - 1) * ISO_COS30;
    var minY = 0;
    var maxY = ((cols - 1) + (rows - 1)) * ISO_SIN30;
    return {
        minX: minX, maxX: maxX, minY: minY, maxY: maxY,
        spanX: maxX - minX, spanY: maxY - minY
    };
}

/** 「中间偏右」锚点：水平 71%、垂直 50% */
function anchorRightMiddle(cols, rows) {
    var e = screenExtent(cols, rows);
    return { x: e.minX + e.spanX * 0.71, y: e.minY + e.spanY * 0.5 };
}

/** 每个地块的屏幕坐标 */
function screenOf(cell) {
    return {
        x: (cell.a - cell.b) * ISO_COS30,
        y: (cell.a + cell.b) * ISO_SIN30
    };
}

/**
 * 把方块清单铺到 cols × rows 的网格上。
 *
 * 五种排布方式（opts.mode）：
 *
 *   'corner'         有效值聚在屏幕**右下角**那一个角（按到角的距离升序，确定性）
 *
 *   'right-middle'   **中间偏右随机分布**：以「水平 71%、垂直 50%」为锚点，
 *                    用「随机值 − 距离 × 权重」打分取前 N 格。
 *
 *   'corner-scatter' **贴右下角随机分布**：锚点就是右下角，算法同上。
 *
 *   'scatter'        全网格等概率随机散布。
 *
 *   'row-major'      按行优先顺序填充（调试用）。
 *
 * 「围绕锚点散开」的实现要点（踩过坑，值得看）：
 *
 *   1) 打分公式 score = random() − 距离 × 权重 里，random() 只有 0~1 的跨度，
 *      而网格内最远距离有十几个单位。权重一大（如 0.55）距离项就完全压过随机项，
 *      选出来永远是「离锚点最近的那批」，加权等于失效 —— 又紧又死的一簇。
 *      所以权重必须很小（见 build-lang-chart.mjs 的 CITY_SCATTER_AMOUNT）。
 *
 *   2) **每种语言各自独立选点**（用各自种子的随机源），而不是大家共用一条顺序、
 *      按轮转发牌分。共用顺序会让每种语言拿到的位置整体偏在一侧、显得扎堆。
 *
 *   3) **Others 单独放宽**（opts.othersSpread）：它是「其余语言的合计」，
 *      刻意让它比主语言散得更开 —— 主语言贴锚点成核，Others 铺在外围，
 *      一眼能看出「这些是零碎的一堆」。
 *
 * @param {Array} items 方块清单
 * @param {number} cols
 * @param {number} rows
 * @param {{mode?:string, scatter?:number, othersSpread?:number, seed?:number}} [opts]
 * @returns {Array<{a:number,b:number,item:Object|null}>}
 *   返回全部 cols × rows 个地块，item 为 null 表示空地块（画灰色地面）。
 */
export function layoutGrid(items, cols, rows, opts) {
    var options = opts || {};
    var mode = options.mode || 'corner';
    var seed = options.seed === undefined ? 20260929 : options.seed;

    // 1) 遍历出全部地块。
    //    这里**必须**用 a = 列号、b = 行号这种直白映射：
    //    早先用过「奇数行反向」的蛇形写法，第 1 行的 a 与第 0 行取值范围完全重叠，
    //    同一块地被算两次，后写入的方块覆盖先前的，方块数量凭空变少。
    //    绘制顺序另有画家算法负责（渲染时按 a + b 排序），不需要在这里做蛇形。
    var all = [];
    for (var b = 0; b < rows; b += 1) {
        for (var a = 0; a < cols; a += 1) {
            all.push({ a: a, b: b, item: null });
        }
    }

    var extent = screenExtent(cols, rows);

    // ---- corner：确定性贴角，不做随机 ----
    // 按到右下角的距离升序逐一分配，同距离时优先更靠下的地块（视觉上更贴角）。
    if (mode === 'corner') {
        var sorted = all.slice().sort(function (p, q) {
            var sp = screenOf(p);
            var sq = screenOf(q);
            var dp = Math.sqrt(Math.pow(extent.maxX - sp.x, 2) + Math.pow(extent.maxY - sp.y, 2));
            var dq = Math.sqrt(Math.pow(extent.maxX - sq.x, 2) + Math.pow(extent.maxY - sq.y, 2));
            if (dp !== dq) return dp - dq;
            return q.b - p.b;
        });
        fillSequentially(sorted, items);
        return all;
    }

    // ---- row-major：按行优先顺序 ----
    if (mode === 'row-major') {
        fillSequentially(all.slice(), items);
        return all;
    }

    var weight = options.scatter === undefined ? 0.1 : options.scatter;
    // Others 的散布权重再乘这个系数（< 1 = 散得更开）
    var othersFactor = options.othersSpread === undefined ? 0.25 : options.othersSpread;
    var anchor = mode === 'right-middle'
        ? { x: extent.minX + extent.spanX * 0.71, y: extent.minY + extent.spanY * 0.5 }
        : { x: extent.maxX, y: extent.maxY };   // 右下角

    var taken = new Set();
    var keyOf = function (cell) { return cell.a + ',' + cell.b; };

    // ---- scatter / right-middle / corner-scatter：每种语言各自独立选点 ----
    // 每种语言一条独立随机源（种子按序号错开），拿到的是位置分布而不是一条共用顺序，
    // 于是各语言的方块彼此穿插、不会扎堆到一侧。
    items.forEach(function (item, index) {
        var random = mulberry32(seed + index * 7919 + (item.isOthers ? 104729 : 0));
        var pool = all.filter(function (cell) { return !taken.has(keyOf(cell)); });

        var ordered;
        if (mode === 'scatter') {
            ordered = shuffle(pool, random);
        } else {
            // Others 用更小的权重 → 距离项更弱 → 选出来的点分布更宽
            var w = item.isOthers ? weight * othersFactor : weight;
            ordered = pool.map(function (cell) {
                var s = screenOf(cell);
                var dx = s.x - anchor.x;
                var dy = s.y - anchor.y;
                var dist = Math.sqrt(dx * dx + dy * dy);
                return { cell: cell, score: random() - dist * w };
            }).sort(function (p, q) {
                return q.score - p.score;
            }).map(function (entry) { return entry.cell; });
        }

        var need = Math.min(item.blocks, ordered.length);
        for (var i = 0; i < need; i += 1) {
            ordered[i].item = item;
            taken.add(keyOf(ordered[i]));
        }
    });

    return all;
}

/** 按给定顺序把方块逐段铺进地块（corner / row-major 用） */
function fillSequentially(cells, items) {
    var cursor = 0;
    items.forEach(function (item) {
        for (var i = 0; i < item.blocks && cursor < cells.length; i += 1) {
            cells[cursor].item = item;
            cursor += 1;
        }
    });
    return cells;
}

/* ---------------- 城市渲染 ---------------- */

/**
 * 渲染等距方块城市：14 × 6 地块，空位画灰色地面。
 * @param {{languages:Array}} data
 * @param {Object} [options]
 *   cols/rows   地块网格，默认 14 × 6
 *   stride      地块间距（屏幕尺度基准），默认 30
 *   footprint   方块地面占地比例，<1 才有街道缝隙，默认 0.84
 *   maxHeight   最高方块的像素高度，默认 132
 *   minHeightPx 最矮方块的高度下限，默认 11
 *   scatter     排布模式：'corner' | 'right-middle' | 'scatter' | 'row-major'（默认 corner）
 *   scatterAmount  'right-middle' 的距离权重，越大越散
 *   seed        随机种子，固定后布局可复现
 *   keep/total/minHeight 透传给 planBlocks
 */
export function renderLangCity(data, options) {
    var opts = options || {};
    var cols = opts.cols || 14;
    var rows = opts.rows || 6;
    var stride = opts.stride || 30;
    var footprint = typeof opts.footprint === 'number' ? opts.footprint : 0.84;
    var maxHeight = opts.maxHeight || 132;
    var minHeightPx = opts.minHeightPx || 11;

    var planned = planBlocks((data && data.languages) || [], {
        keep: opts.keep,
        total: opts.total,
        minHeight: opts.minHeight,
        forceOthers: opts.forceOthers
    });
    var items = planned.items;
    if (!items.length) return '';

    // 定色 + 定像素高度
    var headCount = 0;
    items.forEach(function (item) {
        item.color = colorForIndex(headCount, item.isOthers);
        if (!item.isOthers) headCount += 1;
        item.px = minHeightPx + (maxHeight - minHeightPx) * item.height;
    });

    var cells = layoutGrid(items, cols, rows, {
        mode: opts.mode,
        scatter: opts.scatterAmount,
        othersSpread: opts.othersSpread,
        seed: opts.seed
    });
    var foot = stride * footprint;

    // 画家算法：(a + b) 小的是远处，先画
    var ordered = cells.slice().sort(function (p, q) {
        return (p.a + p.b) - (q.a + q.b);
    });

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var parts = ordered.map(function (cell) {
        var cx = (cell.a - cell.b) * stride * ISO_COS30;
        var cy = (cell.a + cell.b) * stride * ISO_SIN30;
        var corners = tileCorners(cx, cy, foot);
        var hw = foot * ISO_COS30;
        var hh = foot * ISO_SIN30;

        minX = Math.min(minX, cx - hw);
        maxX = Math.max(maxX, cx + hw);
        maxY = Math.max(maxY, cy + hh);

        if (!cell.item) {
            // 空地块：只画灰色地面，给城市一个完整的场地
            minY = Math.min(minY, cy - hh);
            return '<path d="' + pathOf([corners.back, corners.right, corners.front, corners.left]) +
                '" fill="' + GROUND_COLOR + '"/>';
        }

        var item = cell.item;
        var faces = cuboid(cx, cy, foot, item.px);
        minY = Math.min(minY, cy - hh - item.px);
        return '<g>' +
            '<path d="' + faces.left + '" fill="' + shade(item.color, -0.20) + '"/>' +
            '<path d="' + faces.right + '" fill="' + shade(item.color, -0.38) + '"/>' +
            '<path d="' + faces.top + '" fill="' + item.color + '"/>' +
            '</g>';
    }).join('');

    var pad = n(stride * 0.6);
    var box = [
        n(minX - pad), n(minY - pad),
        n(maxX - minX + pad * 2), n(maxY - minY + pad * 2)
    ].join(' ');

    return '<svg class="lang-city" xmlns="http://www.w3.org/2000/svg" viewBox="' + box + '" ' +
        'preserveAspectRatio="xMidYMid meet" role="img" ' +
        'aria-label="语言分布方块城市：方块越高占比越大，灰色为空位">' +
        parts + '</svg>';
}

/* ---------------- 圆环占比图 ---------------- */

function polar(cx, cy, radius, angle) {
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

function arcPath(cx, cy, radius, start, end) {
    var sweep = end - start;
    if (sweep >= Math.PI * 2 - 1e-6) {
        return arcPath(cx, cy, radius, start, start + Math.PI) + ' ' +
            arcPath(cx, cy, radius, start + Math.PI, start + Math.PI * 2 - 1e-6);
    }
    var a = polar(cx, cy, radius, start);
    var b = polar(cx, cy, radius, end);
    var large = sweep > Math.PI ? 1 : 0;
    return 'M' + n(a[0]) + ',' + n(a[1]) +
        'A' + n(radius) + ',' + n(radius) + ' 0 ' + large + ' 1 ' + n(b[0]) + ',' + n(b[1]);
}

/** 二维圆环占比图。配色与城市一致，两栏可以互相对照。 */
export function renderLangDonut(data, options) {
    var opts = options || {};
    var size = opts.size || 168;
    var thickness = opts.thickness || 22;
    var radius = (size - thickness) / 2 - 2;
    var cx = size / 2;
    var cy = size / 2;

    var items = planBlocks((data && data.languages) || [], {
        keep: opts.keep,
        total: opts.total,
        minHeight: opts.minHeight,
        forceOthers: opts.forceOthers
    }).items;
    if (!items.length) return '';

    var sum = items.reduce(function (acc, item) { return acc + item.share; }, 0);
    var headCount = 0;
    var angle = -Math.PI / 2;

    var arcs = items.map(function (item) {
        var color = colorForIndex(headCount, item.isOthers);
        if (!item.isOthers) headCount += 1;
        var sweep = (item.share / sum) * Math.PI * 2;
        var path = arcPath(cx, cy, radius, angle, angle + sweep);
        angle += sweep;
        return '<path d="' + path + '" fill="none" stroke="' + color +
            '" stroke-width="' + thickness + '"/>';
    }).join('');

    return '<svg class="lang-donut" xmlns="http://www.w3.org/2000/svg" ' +
        'viewBox="0 0 ' + size + ' ' + size + '" role="img" ' +
        'aria-label="语言占比圆环图">' + arcs + '</svg>';
}

/* ---------------- 图例 ---------------- */

/**
 * 图例：色块 + 语言名 + 占比，**最后一行固定是 others 的合计占比**。
 * 颜色索引必须与城市/圆环一致，否则图例对不上号。
 */
export function renderLangLegend(data, options) {
    var opts = options || {};
    var planned = planBlocks((data && data.languages) || [], {
        keep: opts.keep,
        total: opts.total,
        minHeight: opts.minHeight,
        forceOthers: opts.forceOthers
    });
    var items = planned.items;
    if (!items.length) return '';

    var sum = items.reduce(function (acc, item) { return acc + item.share; }, 0);
    var headCount = 0;

    var rows = items.map(function (item) {
        var color = colorForIndex(headCount, item.isOthers);
        if (!item.isOthers) headCount += 1;
        var share = Math.round((item.share / sum) * 1000) / 10;
        return '<li class="lang-legend-item' + (item.isOthers ? ' is-others' : '') + '">' +
            '<span class="lang-legend-swatch" style="background:' + color + '"></span>' +
            '<span class="lang-legend-name">' + escapeText(item.name) + '</span>' +
            '<span class="lang-legend-share">' + share + '%</span>' +
            '</li>';
    }).join('');

    // 没有长尾语言时也补一行 others（0%），保持版式稳定、含义明确
    if (!items.some(function (item) { return item.isOthers; })) {
        rows += '<li class="lang-legend-item is-others">' +
            '<span class="lang-legend-swatch" style="background:' + PALETTE[PALETTE.length - 1] + '"></span>' +
            '<span class="lang-legend-name">' + OTHERS_LABEL + '</span>' +
            '<span class="lang-legend-share">' + Math.round(planned.othersShare * 1000) / 10 + '%</span>' +
            '</li>';
    }

    return '<ul class="lang-legend">' + rows + '</ul>';
}
