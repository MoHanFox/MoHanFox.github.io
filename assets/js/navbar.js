/**
 * navbar.js — 通用导航栏（所有页面顶部）
 *
 * 用法：在页面 <body> 末尾引用本脚本，路径相对于页面自身：
 *     <script src="assets/js/navbar.js"></script>          <!-- 页面在站点根目录 -->
 *     <script src="../assets/js/navbar.js"></script>       <!-- 页面在一级子目录 -->
 *     <script src="../../assets/js/navbar.js"></script>    <!-- 页面在二级子目录 -->
 *
 * 资源前缀自动推导：由 <script> 自身的 src 砍掉 "assets/js/navbar.js" 这一段反推站点根，
 * 不依赖 window.location，因此同一份脚本在任意层级页面都能正确工作
 * （一级：../ ；二级：../../ ；站点根：空）。
 * 若目录结构特殊，可用 <script data-halo-root="../../"> 手动指定前缀。
 *
 * 行为：
 *   1) 计算资源根前缀；
 *   2) 注入 base.css / components.css / navbar.css（浏览器会缓存，重复无害）；
 *   3) 在 <body> 首位插入导航栏 DOM（品牌 Logo + 首页 / 博客），并标出当前页。
 *
 * 注意：本脚本不含登录态逻辑，不读写 localStorage。
 */
(function () {
    'use strict';

    var initialized = false;

    function init() {
        if (initialized) return;
        initialized = true;

        var current = document.currentScript;

        // ---- 1. 计算资源根前缀：优先 data-halo-root，其次由本脚本 src 反推 ----
        var root = current && current.getAttribute('data-halo-root');
        if (!root) {
            var src = (current && current.getAttribute('src')) || '';
            // 去掉查询串/锚点，再砍掉 "assets/js/navbar.js" 这一段自身路径
            var clean = src.split('?')[0].split('#')[0];
            var suffix = 'assets/js/navbar.js';
            var idx = clean.lastIndexOf(suffix);
            root = idx >= 0 ? clean.slice(0, idx) : '';
        }

        // ---- 2. 注入样式（字体基础层 + 组件层 + 导航栏） ----
        ['base.css', 'components.css', 'navbar.css'].forEach(function (css) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = root + 'assets/css/' + css;
            document.head.appendChild(link);
        });

        // ---- 3. 创建导航栏 DOM ----
        // 当前页高亮：页面位于 /pages/blog/ 下时给「博客」加上选中态
        var inBlog = /\/pages\/blog\//.test(window.location.pathname);
        var links = [
            { label: '首页', href: root + 'index.html', active: !inBlog },
            { label: '博客', href: root + 'pages/blog/', active: inBlog }
        ];

        var linksHtml = links.map(function (item) {
            return '<a class="halo-nav-link' + (item.active ? ' is-active' : '') +
                '" href="' + item.href + '"' + (item.active ? ' aria-current="page"' : '') +
                '>' + item.label + '</a>';
        }).join('');

        var nav = document.createElement('nav');
        nav.className = 'halo-navbar';
        nav.innerHTML =
            '<div class="halo-navbar-left">' +
            '    <a class="halo-nav-brand" href="' + root + 'index.html">' +
            '        <img src="' + root + 'assets/img/halo.svg" alt="HALO">' +
            '        <span>MOHAN</span>' +
            '    </a>' +
            '    <nav class="halo-nav-menu">' + linksHtml + '</nav>' +
            '</div>';
        document.body.insertBefore(nav, document.body.firstChild);

        initAutoHide(nav);
    }

    /**
     * 滚动时自动隐藏 / 显示导航栏（加在 navbar.js 里，所有页面一次生效）。
     *   · 往下滚 -> 加 .is-hidden，导航栏上移滑出画面
     *   · 往上滚 -> 移除 .is-hidden，滑回来
     *
     * 两个细节：
     *   1) 顶部一小段距离内始终显示，避免刚进页面轻微滚动就把导航栏弹走；
     *   2) 刻意**不用 requestAnimationFrame 节流**。因为下面只在状态真正翻转时
     *      才写 class，本身就不是每帧操作 DOM，没有节流的必要；而 rAF 在后台标签页、
     *      无头浏览器等场景可能被饿死，反而会让导航栏该隐藏时不隐藏（本项目在
     *      toc.js 上踩过同一个坑）。
     */
    function initAutoHide(nav) {
        var lastY = window.scrollY || window.pageYOffset || 0;
        // 在这个距离以内不隐藏，始终显示
        var TOP_ZONE = 80;

        function update() {
            var y = window.scrollY || window.pageYOffset || 0;
            var delta = y - lastY;

            // 忽略几乎不动的抖动（触控板惯性、亚像素滚动）
            if (Math.abs(delta) < 6) return;

            var shouldHide = delta > 0 && y > TOP_ZONE;
            lastY = y;

            // 只在状态真的翻转时才碰 class，避免每次滚动都写 DOM
            if (nav.classList.contains('is-hidden') !== shouldHide) {
                nav.classList.toggle('is-hidden', shouldHide);
            }
        }

        window.addEventListener('scroll', update, { passive: true });
    }

    // 脚本置于 body 末尾时立即执行；若被 defer 或放到 head 中，则等 DOM 就绪
    if (document.body) {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
        window.addEventListener('load', init);
    }
})();
