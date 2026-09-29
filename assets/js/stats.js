/**
 * stats.js — GitHub 统计图表嵌入与降级（Halo 风格）
 *
 * 用法（容器已存在于文档中，脚本置于 </body> 之前）：
 *     <div id="halo-langs"></div>
 *     <div id="halo-stats"></div>
 *     <script src="assets/js/stats.js"></script>
 *     <script>
 *         HaloStats.mountLanguages('#halo-langs', 'MoHanFox');
 *         HaloStats.mountStats('#halo-stats', 'MoHanFox');
 *     </script>
 *
 * 公开 API：window.HaloStats
 *     mountLanguages(selectorOrEl, username)  语言分布卡（3D 语言）
 *     mountStats(selectorOrEl, username)      GitHub 总览卡 + 连续贡献卡（2D 维度）
 *     unmount(selectorOrEl)                   卸载并清理定时器
 *     CONFIG                                  当前生效配置对象（可在运行时改写基址）
 *     version                                 版本号
 *
 * 两个 mount 方法都接受 CSS 选择器字符串或 DOM 元素，容器不存在/选择器非法时静默返回，
 * 不抛异常、不产生控制台输出。必须在容器已插入文档之后调用（DOM 就绪或 <body> 末尾脚本）。
 *
 * 关于「3D 语言图」：现成的公共统计服务（github-readme-stats / streak-stats）只提供 2D SVG
 * 卡片，本项目又硬性禁止引入 three.js / echarts-gl 等第三方库，因此语言分布用 top-langs 的
 * pie 卡片呈现，并由本文件注入的 CSS 给它一个轻微的透视倾角（rotateX/rotateY）来模拟立体
 * 观感，悬停时回正。也就是说没有真正的三维渲染，只有卡片层面的立体视觉。
 *
 * 降级策略（本文件的核心）：
 *     骨架占位 → onload 成功显示图片
 *              → onerror 或超过 CONFIG.timeoutMs 仍未 load：移除图片，改渲染中文占位卡片
 *     每条路径只结算一次（settled 守卫），重复挂载会作废旧任务（state.stale 守卫），
 *     占位卡片保留卡片高度（min-height 预留 + 骨架绝对定位），因此图片失败不造成布局塌陷。
 *
 * 已知限制（如实记录，勿当成 bug）：
 *   1. 图片请求失败时，浏览器的控制台/网络面板会出现一条由浏览器自身生成的
 *      "Failed to load resource" 记录，这是网络层事实，JS 无法消除；本文件自身不产生任何
 *      JS 错误、异常或日志（除非显式打开 CONFIG.debug）。
 *   2. 若第三方服务以 HTTP 200 返回一张「错误提示卡」（例如用户名不存在），onload 会判定为
 *      成功并原样显示该图。跨域 SVG 无法读取内容，本文件不做内容嗅探，这是有意取舍。
 *   3. 统计图内部的文字由第三方服务渲染；本文件负责的卡片标题、说明与降级文案均为中文。
 *      streak-stats 支持 &locale=zh（已实测返回中文标签）；github-readme-stats 的
 *      &locale=cn 在本机网络不可达、无法实测，故默认不发送（见 CONFIG.locale 说明）。
 */
(function () {
    'use strict';

    /* ============================================================
       1. 配置：服务基址集中在此，便于整体换成自建/反代实例
       ============================================================ */
    var CONFIG_DEFAULTS = {
        // github-readme-stats 实例（末尾斜杠会被自动去掉；运行时可整体改写以切换到自建实例）
        readmeStatsBase: 'https://github-readme-stats.vercel.app/api',
        // streak-stats 实例（同上）
        streakBase: 'https://streak-stats.demolab.com',
        // 默认用户名 / 降级链接
        username: 'MoHanFox',
        profileBase: 'https://github.com/',
        profileUrl: '',                 // 留空 = profileBase + username；也可整体覆盖成任意主页
        // 卡片参数
        theme: 'default',
        langsCount: 10,
        // 统计图内部标签语言：'' = 不发送 locale 参数（默认）。
        // streak-stats 传 'zh' 实测返回中文标签；传 'cn' 会 HTTP 500，不要用。
        // github-readme-stats 文档支持 locale=cn，但本机网络不可达未能实测，故不默认开启。
        streakLocale: 'zh',
        readmeStatsLocale: '',
        // 超时（毫秒）：超时即降级，避免大陆网络下无限等待
        timeoutMs: 8000,
        // 仅在需要排查时打开：打开后本文件会输出诊断日志（默认关闭，保持零控制台噪音）
        debug: false
    };

    // 页面可在引入本脚本之前用 window.HALO_STATS_CONFIG 覆盖（只识别上面的已知字段）
    var CONFIG = mergeConfig(CONFIG_DEFAULTS, window.HALO_STATS_CONFIG);
    CONFIG.readmeStatsBase = trimSlash(CONFIG.readmeStatsBase);
    CONFIG.streakBase = trimSlash(CONFIG.streakBase);

    var STYLE_ID = 'halo-stats-style';
    var VERSION = '1.0.0';

    /* ============================================================
       2. 通用小工具
       ============================================================ */

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function trim(value) {
        return String(value == null ? '' : value).replace(/^\s+|\s+$/g, '');
    }

    function trimSlash(value) {
        return trim(value).replace(/\/+$/, '');
    }

    /** 只合并 DEFAULTS 中已知的字段，并做基础类型校验，避免外部配置把内部状态弄坏 */
    function mergeConfig(defaults, overrides) {
        var out = {};
        var key;
        for (key in defaults) {
            if (hasOwn(defaults, key)) out[key] = defaults[key];
        }
        if (!overrides || typeof overrides !== 'object') return out;
        for (key in defaults) {
            if (!hasOwn(defaults, key)) continue;
            var value = overrides[key];
            if (value === undefined || value === null) continue;
            if (typeof value === 'string') {
                out[key] = trim(value);
            } else if (typeof value === 'number') {
                if (isFinite(value) && value > 0) out[key] = value;
            } else if (typeof value === 'boolean') {
                out[key] = value;
            }
        }
        return out;
    }

    function debugLog() {
        if (!CONFIG.debug) return;
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[HaloStats]');
            if (window.console && typeof window.console.log === 'function') {
                window.console.log.apply(window.console, args);
            }
        } catch (e) { /* 日志本身不允许引发问题 */ }
    }

    function encode(value) {
        return encodeURIComponent(String(value));
    }

    function normalizeUser(value) {
        if (typeof value !== 'string') return '';
        return trim(value).slice(0, 100);
    }

    /** 取服务基址：读取时再规整一次，运行时改 CONFIG 时多写/少写末尾斜杠都不影响 URL */
    function serviceBase(key) {
        return trimSlash(CONFIG[key]);
    }

    /** 由 [key, value] 数组拼查询串，统一做 URL 编码 */
    function buildQuery(params) {
        var parts = [];
        for (var i = 0; i < params.length; i++) {
            var pair = params[i];
            if (pair[1] === '' || pair[1] === null || pair[1] === undefined) continue;
            parts.push(encode(pair[0]) + '=' + encode(pair[1]));
        }
        return parts.length ? '?' + parts.join('&') : '';
    }

    /* ============================================================
       3. 卡片定义（每张卡 = 一个第三方统计图 URL + 中文标题）
       ============================================================ */

    var CARDS = {
        // 3D 语言：top-langs 饼图卡片（立体观感由 .halo-stats-tilt 的 CSS 倾角提供）
        languages: {
            key: 'languages',
            title: '语言分布',
            caption: 'GitHub 仓库语言占比',
            size: 'tall',
            tilt: true,
            loadingText: '正在加载语言统计图…',
            alt: function (user) { return user + ' 的 GitHub 仓库语言分布饼图'; },
            url: function (user) {
                return serviceBase('readmeStatsBase') + '/top-langs/' + buildQuery([
                    ['username', user],
                    ['layout', 'pie'],
                    ['langs_count', CONFIG.langsCount],
                    ['theme', CONFIG.theme],
                    ['hide_border', 'true'],
                    ['locale', CONFIG.readmeStatsLocale]
                ]);
            }
        },
        // 2D 维度之一：GitHub 总览（提交 / Star / PR / Issue）
        stats: {
            key: 'stats',
            title: '数据总览',
            caption: '提交 / Star / PR / Issue 概览',
            size: 'normal',
            tilt: false,
            loadingText: '正在加载数据总览…',
            alt: function (user) { return user + ' 的 GitHub 数据总览统计图'; },
            url: function (user) {
                return serviceBase('readmeStatsBase') + '/' + buildQuery([
                    ['username', user],
                    ['show_icons', 'true'],
                    ['theme', CONFIG.theme],
                    ['hide_border', 'true'],
                    ['locale', CONFIG.readmeStatsLocale]
                ]);
            }
        },
        // 2D 维度之二：连续贡献
        streak: {
            key: 'streak',
            title: '连续贡献',
            caption: '当前连续与最长连续贡献天数',
            size: 'normal',
            tilt: false,
            loadingText: '正在加载连续贡献…',
            alt: function (user) { return user + ' 的 GitHub 连续贡献统计图'; },
            url: function (user) {
                return serviceBase('streakBase') + '/' + buildQuery([
                    ['user', user],
                    ['theme', CONFIG.theme],
                    ['hide_border', 'true'],
                    ['locale', CONFIG.streakLocale]
                ]);
            }
        }
    };

    /* ============================================================
       4. 组件级样式（本文件无法改 CSS 文件，故在此注入；类名统一 halo-stats- 前缀）
          颜色/圆角一律取 base.css 的设计令牌；var() 的第二参数只是令牌缺失时的兜底，
          取值与 base.css :root 完全一致，不是另立一套色板。
       ============================================================ */
    var STYLE_TEXT = [
        '/* halo-stats: 由 assets/js/stats.js 注入，前缀 halo-stats- 以避免与其它样式冲突 */',
        '.halo-stats-root { width: 100%; box-sizing: border-box; }',
        '.halo-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; width: 100%; box-sizing: border-box; }',
        '.halo-stats-grid--single { grid-template-columns: minmax(0, 420px); justify-content: center; }',
        '@media (max-width: 380px) { .halo-stats-grid { grid-template-columns: 1fr; } }',
        '',
        '/* 卡片：白底 + 极浅描边 + 柔和阴影，留白舒展 */',
        '.halo-stats-card { display: flex; flex-direction: column; min-width: 0; box-sizing: border-box; background: var(--color-surface, #ffffff); border: 1px solid var(--color-border, #e2e8f0); border-radius: var(--radius-md, 8px); box-shadow: 0 2px 10px var(--color-border, #e2e8f0); }',
        '.halo-stats-card-head { padding: 16px 18px 0; }',
        '.halo-stats-card-title { margin: 0; font-family: var(--font-medium, sans-serif); font-size: 15px; font-weight: 500; letter-spacing: 0.5px; color: var(--color-ink, #1a1a2e); }',
        '.halo-stats-card-caption { margin: 6px 0 0; font-family: var(--font-light, sans-serif); font-size: 12px; line-height: 1.5; color: var(--color-muted, #6b7280); }',
        '/* 卡片主体预留最小高度：图片未加载/已失败时都不会塌陷 */',
        '.halo-stats-card-body { position: relative; flex: 1 1 auto; display: flex; align-items: center; justify-content: center; min-width: 0; padding: 14px 18px 18px; }',
        '.halo-stats-card-body[data-halo-stats-size="tall"] { min-height: 300px; }',
        '.halo-stats-card-body[data-halo-stats-size="normal"] { min-height: 190px; }',
        '',
        '/* 语言卡：轻微透视倾角模拟 3D 观感，悬停/聚焦回正；transform 不改变布局盒尺寸 */',
        '.halo-stats-tilt { display: flex; min-width: 0; perspective: 1100px; }',
        '.halo-stats-tilt > .halo-stats-card { width: 100%; transform: rotateX(3deg) rotateY(-2deg); transition: transform 0.35s ease, box-shadow 0.35s ease; }',
        '.halo-stats-tilt > .halo-stats-card:hover, .halo-stats-tilt > .halo-stats-card:focus-within { transform: rotateX(0deg) rotateY(0deg); box-shadow: 0 6px 18px var(--color-border, #e2e8f0); }',
        '@media (prefers-reduced-motion: reduce) { .halo-stats-tilt > .halo-stats-card, .halo-stats-tilt > .halo-stats-card:hover { transform: none; transition: none; } }',
        '',
        '/* 统计图：加载完成前 visibility:hidden，保留其原有的尺寸占位 */',
        '.halo-stats-img { display: block; max-width: 100%; height: auto; visibility: hidden; }',
        '.halo-stats-img--ready { visibility: visible; }',
        '',
        '/* 骨架占位（绝对定位铺满主体，不参与撑高） */',
        '.halo-stats-skeleton { position: absolute; inset: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--color-surface-alt, #f3f4f6); border-radius: var(--radius-sm, 4px); }',
        '.halo-stats-skeleton::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, var(--color-primary-soft, #ebf4ff) 50%, transparent 70%); animation: halo-stats-shimmer 1.5s linear infinite; }',
        '.halo-stats-skeleton-text { position: relative; z-index: 1; font-family: var(--font-light, sans-serif); font-size: 12px; letter-spacing: 0.5px; color: var(--color-muted, #6b7280); }',
        '@keyframes halo-stats-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }',
        '@media (prefers-reduced-motion: reduce) { .halo-stats-skeleton::after { animation: none; } }',
        '',
        '/* 降级占位卡片内容 */',
        '.halo-stats-fallback { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 6px 2px; text-align: center; }',
        '.halo-stats-fallback-icon { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; background: var(--color-primary-soft, #ebf4ff); color: var(--color-primary, #2d6bef); }',
        '.halo-stats-fallback-title { margin: 0; font-family: var(--font-medium, sans-serif); font-size: 14px; letter-spacing: 0.5px; color: var(--color-ink, #1a1a2e); }',
        '.halo-stats-fallback-desc { margin: 0; max-width: 34em; font-family: var(--font-light, sans-serif); font-size: 12.5px; line-height: 1.7; color: var(--color-muted, #6b7280); }',
        '.halo-stats-fallback-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; }',
        '.halo-stats-link { font-family: var(--font-medium, sans-serif); font-size: 13px; color: var(--color-primary, #2d6bef); text-decoration: none; border-bottom: 1px solid var(--color-primary-soft, #ebf4ff); padding-bottom: 1px; transition: var(--ease-base, all 0.25s ease); }',
        '.halo-stats-link:hover { color: var(--color-primary-hover, #357abd); border-bottom-color: var(--color-primary-hover, #357abd); }',
        '.halo-stats-retry { font-family: var(--font-regular, sans-serif); font-size: 12px; color: var(--color-muted, #6b7280); background: var(--color-surface, #ffffff); border: 1px solid var(--color-border, #e2e8f0); border-radius: var(--radius-pill, 20px); padding: 5px 14px; cursor: pointer; transition: var(--ease-base, all 0.25s ease); }',
        '.halo-stats-retry:hover { color: var(--color-primary, #2d6bef); border-color: var(--color-primary, #2d6bef); background: var(--color-primary-soft, #ebf4ff); }',
        '.halo-stats-retry:focus-visible { outline: 2px solid var(--color-primary, #2d6bef); outline-offset: 2px; }'
    ].join('\n');

    var styleInjected = false;

    function injectStyles() {
        if (styleInjected) return;
        try {
            if (document.getElementById(STYLE_ID)) { styleInjected = true; return; }
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.type = 'text/css';
            style.appendChild(document.createTextNode(STYLE_TEXT));
            (document.head || document.documentElement).appendChild(style);
            styleInjected = true;
        } catch (e) {
            // 样式注入失败不应该阻断渲染（退化为无样式的纯内容，但不报错）
            debugLog('style injection failed:', e);
        }
    }

    /* ============================================================
       5. 挂载状态：每个 root 一份，重复挂载时作废旧任务并清掉遗留定时器
       ============================================================ */

    var stateStore = (typeof WeakMap === 'function') ? new WeakMap() : null;

    function readState(root) {
        if (stateStore) return stateStore.get(root) || null;
        return root.__haloStatsState || null;
    }

    function writeState(root, state) {
        if (stateStore) { stateStore.set(root, state); return; }
        try { root.__haloStatsState = state; } catch (e) { /* 只读节点等极端情况 */ }
    }

    function resetState(root) {
        var previous = readState(root);
        if (previous) {
            previous.stale = true;                       // 旧任务的回调全部作废
            for (var i = 0; i < previous.timers.length; i++) {
                clearTimeout(previous.timers[i]);
            }
            previous.timers = [];
        }
        var fresh = { stale: false, timers: [] };
        writeState(root, fresh);
        return fresh;
    }

    function dropTimer(state, id) {
        for (var i = 0; i < state.timers.length; i++) {
            if (state.timers[i] === id) { state.timers.splice(i, 1); return; }
        }
    }

    /* ============================================================
       6. 图片加载 → 成功 / 失败 / 超时 的一次性结算
       ============================================================ */

    function createCard(spec, user, state) {
        var card = document.createElement('article');
        card.className = 'halo-stats-card';
        card.setAttribute('data-halo-stats-kind', spec.key);
        card.setAttribute('data-halo-stats-state', 'loading');

        var head = document.createElement('div');
        head.className = 'halo-stats-card-head';

        var title = document.createElement('h3');
        title.className = 'halo-stats-card-title';
        title.textContent = spec.title;
        head.appendChild(title);

        var caption = document.createElement('p');
        caption.className = 'halo-stats-card-caption';
        caption.textContent = spec.caption + ' · @' + user;
        head.appendChild(caption);

        var body = document.createElement('div');
        body.className = 'halo-stats-card-body';
        body.setAttribute('data-halo-stats-size', spec.size);

        card.appendChild(head);
        card.appendChild(body);

        attemptImage(spec, user, card, body, state);

        if (!spec.tilt) return card;
        // 语言卡外面套一层透视容器，用于营造立体观感（不影响网格布局）
        var tilt = document.createElement('div');
        tilt.className = 'halo-stats-tilt';
        tilt.appendChild(card);
        return tilt;
    }

    /** 发起一次图片加载；无论成功、onerror 还是超时，都只结算一次 */
    function attemptImage(spec, user, card, body, state) {
        var settled = false;
        var timer = null;
        var image = null;
        var skeleton = null;

        // 重试：先清干净上一次的内容与标记，保证同一张卡内永远只有一个图片/占位
        body.textContent = '';
        body.setAttribute('aria-busy', 'true');
        card.setAttribute('data-halo-stats-state', 'loading');
        card.removeAttribute('data-halo-stats-failure');

        function alive() {
            return state.stale !== true;
        }

        function release() {
            if (timer !== null) {
                clearTimeout(timer);
                dropTimer(state, timer);
                timer = null;
            }
            if (image) {
                image.onload = null;
                image.onerror = null;
            }
        }

        function succeed() {
            if (settled || !alive()) return;
            settled = true;
            release();
            if (skeleton && skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
            skeleton = null;
            if (image) image.classList.add('halo-stats-img--ready');
            body.setAttribute('aria-busy', 'false');
            card.setAttribute('data-halo-stats-state', 'ready');
            debugLog('card ready:', spec.key);
        }

        function fail(reason) {
            if (settled || !alive()) return;
            settled = true;
            release();
            if (image) {
                // 先摘掉回调再中断请求，避免取消加载又触发一次 onerror 造成二次降级
                try { image.removeAttribute('src'); } catch (e) { /* 忽略 */ }
                if (image.parentNode) image.parentNode.removeChild(image);
                image = null;
            }
            skeleton = null;
            body.textContent = '';
            body.setAttribute('aria-busy', 'false');
            card.setAttribute('data-halo-stats-state', 'failed');
            card.setAttribute('data-halo-stats-failure', reason);
            debugLog('card degraded:', spec.key, reason);
            renderFallback(spec, user, card, body, state);
        }

        skeleton = document.createElement('div');
        skeleton.className = 'halo-stats-skeleton';
        skeleton.setAttribute('aria-hidden', 'true');
        var skeletonText = document.createElement('span');
        skeletonText.className = 'halo-stats-skeleton-text';
        skeletonText.textContent = spec.loadingText;
        skeleton.appendChild(skeletonText);

        image = document.createElement('img');
        image.className = 'halo-stats-img';
        image.alt = spec.alt(user);
        image.decoding = 'async';
        try { image.referrerPolicy = 'no-referrer'; } catch (e) { /* 老浏览器忽略即可 */ }
        image.onload = function () { succeed(); };
        image.onerror = function () { fail('error'); };

        body.appendChild(skeleton);
        body.appendChild(image);

        // 计时在设置 src 之前启动：即使个别浏览器同步回调也在覆盖范围内
        timer = setTimeout(function () {
            timer = null;
            fail('timeout');
        }, CONFIG.timeoutMs);
        state.timers.push(timer);

        try {
            image.src = spec.url(user);
        } catch (e) {
            fail('error');
            return;
        }

        // 缓存命中：设置 src 后已同步加载完成。只判成功不判失败，避免误降级。
        if (image.complete && image.naturalWidth > 0) succeed();
    }

    /* ============================================================
       7. 降级占位卡片（中文文案 + 可点击替代链接 + 重试）
       ============================================================ */

    function createAlertIcon() {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        var triangle = document.createElementNS(NS, 'path');
        triangle.setAttribute('d', 'M12 3.2 L21 19.8 H3 Z');
        triangle.setAttribute('fill', 'none');
        triangle.setAttribute('stroke', 'currentColor');
        triangle.setAttribute('stroke-width', '1.6');
        triangle.setAttribute('stroke-linejoin', 'round');

        var stem = document.createElementNS(NS, 'path');
        stem.setAttribute('d', 'M12 9.6 V14.2');
        stem.setAttribute('stroke', 'currentColor');
        stem.setAttribute('stroke-width', '1.6');
        stem.setAttribute('stroke-linecap', 'round');

        var dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', '12');
        dot.setAttribute('cy', '16.6');
        dot.setAttribute('r', '0.95');
        dot.setAttribute('fill', 'currentColor');

        svg.appendChild(triangle);
        svg.appendChild(stem);
        svg.appendChild(dot);
        return svg;
    }

    function resolveProfileUrl(user) {
        if (CONFIG.profileUrl) return CONFIG.profileUrl;
        return trimSlash(CONFIG.profileBase) + '/' + encode(user);
    }

    function renderFallback(spec, user, card, body, state) {
        var profileUrl = resolveProfileUrl(user);

        var panel = document.createElement('div');
        panel.className = 'halo-stats-fallback';
        panel.setAttribute('role', 'status');

        var icon = document.createElement('span');
        icon.className = 'halo-stats-fallback-icon';
        icon.appendChild(createAlertIcon());
        panel.appendChild(icon);

        var title = document.createElement('p');
        title.className = 'halo-stats-fallback-title';
        title.textContent = '该统计服务当前无法访问';
        panel.appendChild(title);

        var desc = document.createElement('p');
        desc.className = 'halo-stats-fallback-desc';
        desc.textContent = '公共统计图服务在大陆网络下可能超时或被拦截，本卡片暂时无法显示，' +
            '这不影响本站其它内容。';
        panel.appendChild(desc);

        var actions = document.createElement('div');
        actions.className = 'halo-stats-fallback-actions';

        var link = document.createElement('a');
        link.className = 'halo-stats-link';
        link.href = profileUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '前往 github.com/' + user + ' 查看';
        actions.appendChild(link);

        var retry = document.createElement('button');
        retry.className = 'halo-stats-retry';
        retry.type = 'button';
        retry.textContent = '重试';
        retry.addEventListener('click', function () {
            if (state.stale) return;
            debugLog('retry card:', spec.key);
            attemptImage(spec, user, card, body, state);
        });
        actions.appendChild(retry);

        panel.appendChild(actions);
        body.appendChild(panel);
    }

    /* ============================================================
       8. 挂载 / 卸载
       ============================================================ */

    function resolveContainer(target) {
        if (!target) return null;
        if (typeof target === 'string') {
            var selector = trim(target);
            if (!selector) return null;
            try {
                return document.querySelector(selector);
            } catch (e) {
                return null;             // 非法选择器：静默返回
            }
        }
        if (target.nodeType === 1) return target;
        return null;
    }

    function ensureRoot(container) {
        var children = container.children || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.classList && child.classList.contains('halo-stats-root')) return child;
        }
        var root = document.createElement('div');
        root.className = 'halo-stats-root';
        container.appendChild(root);
        return root;
    }

    function render(target, kinds, username) {
        try {
            var container = resolveContainer(target);
            if (!container) {
                debugLog('container not found, skip:', target);
                return api;
            }
            var user = normalizeUser(username) || normalizeUser(CONFIG.username);
            if (!user) {
                debugLog('username missing, skip');
                return api;
            }

            injectStyles();

            var root = ensureRoot(container);
            var state = resetState(root);
            root.textContent = '';        // 幂等重挂载：先清掉上一次的卡片

            var grid = document.createElement('div');
            grid.className = (kinds.length === 1)
                ? 'halo-stats-grid halo-stats-grid--single'
                : 'halo-stats-grid';

            for (var i = 0; i < kinds.length; i++) {
                var spec = CARDS[kinds[i]];
                if (!spec) continue;
                grid.appendChild(createCard(spec, user, state));
            }

            root.appendChild(grid);
            debugLog('mounted:', kinds.join(','), 'for', user);
        } catch (e) {
            // 降级原则优先：任何意外都不向页面抛错
            debugLog('render failed:', e);
        }
        return api;
    }

    function unmount(target) {
        try {
            var container = resolveContainer(target);
            if (!container) return api;
            var root = null;
            var children = container.children || [];
            for (var i = 0; i < children.length; i++) {
                var child = children[i];
                if (child.classList && child.classList.contains('halo-stats-root')) { root = child; break; }
            }
            if (!root) return api;
            var state = readState(root);
            if (state) {
                state.stale = true;
                for (var j = 0; j < state.timers.length; j++) clearTimeout(state.timers[j]);
                state.timers = [];
            }
            container.removeChild(root);
        } catch (e) {
            debugLog('unmount failed:', e);
        }
        return api;
    }

    var api = {
        version: VERSION,
        CONFIG: CONFIG,
        mountLanguages: function (target, username) { return render(target, ['languages'], username); },
        mountStats: function (target, username) { return render(target, ['stats', 'streak'], username); },
        unmount: unmount
    };

    window.HaloStats = api;
})();
