/**
 * toc.js — 文章页右侧章节导航的滚动高亮
 *
 * 只做一件事：根据当前滚动位置给目录里对应的一项加 .is-active。
 * 页面结构由构建脚本生成（见 scripts/build-blog.mjs 的 renderToc）。
 *
 * 为什么不用 IntersectionObserver：一屏内同时可见多个标题时，它给不出
 * 「现在读到哪一节」的单一答案，容易出现高亮跳来跳去。这里直接按
 * 「最后一个已越过视口上沿的标题」判定，简单且与人的阅读位置一致。
 */
(function () {
    'use strict';

    var toc = document.querySelector('[data-toc]');
    if (!toc) return;

    var links = Array.prototype.slice.call(toc.querySelectorAll('.blog-toc-link'));
    if (links.length < 2) return;

    // 提前取好锚点元素；构建时 id 与链接 href 同源，正常不会缺
    var targets = links
        .map(function (link) {
            var id = decodeURIComponent((link.getAttribute('href') || '').replace(/^#/, ''));
            var el = id ? document.getElementById(id) : null;
            return el ? { link: link, el: el } : null;
        })
        .filter(Boolean);

    if (targets.length < 2) return;

    var activeIndex = -1;

    function setActive(index) {
        if (index === activeIndex) return;
        activeIndex = index;
        targets.forEach(function (item, i) {
            item.link.classList.toggle('is-active', i === index);
        });
        ensureVisible(targets[index] && targets[index].link);
    }

    /**
     * 让高亮项在目录面板内可见。
     *
     * 这里**不能**用 link.scrollIntoView()：它会把所有可滚动祖先都滚一遍，
     * 包括 window —— 结果是每次滚动都被目录自己拽回标题位置，页面永远滚不动
     * （实测踩过）。所以只手动调整目录面板自身的 scrollTop。
     */
    function ensureVisible(link) {
        var panel = toc.querySelector('.blog-toc-nav') || toc;
        if (!link || panel.scrollHeight <= panel.clientHeight) return;
        // 用 offsetTop 累计（link 的 offsetParent 是 .blog-toc-nav 里的列表），
        // 不用 getBoundingClientRect：面板自身滚动会让 rect 基准漂移。
        var top = link.offsetTop + (link.offsetParent ? link.offsetParent.offsetTop : 0);
        var bottom = top + link.offsetHeight;
        if (top < panel.scrollTop) {
            panel.scrollTop = top;
        } else if (bottom > panel.scrollTop + panel.clientHeight) {
            panel.scrollTop = bottom - panel.clientHeight;
        }
    }

    /** 各标题距文档顶部的距离（滚动后重新测量，避免用到过期坐标） */
    function measure() {
        return targets.map(function (item) {
            var rect = item.el.getBoundingClientRect();
            return rect.top + window.scrollY;
        });
    }

    function update() {
        // 距视口顶部 120px 作为「读到这里」的判定线
        var line = window.scrollY + 120;
        var positions = measure();

        // 最后一个已越过判定线的标题即为当前章节；都还没到就用第一个
        var index = 0;
        for (var i = 0; i < positions.length; i += 1) {
            if (positions[i] <= line) index = i;
        }

        // 滚到页面底部时，末尾几个标题可能都不足以越过判定线，此时高亮最后一节
        var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        if (atBottom) index = positions.length - 1;

        setActive(index);
    }

    // 事件驱动更新，另加一个低频兜底轮询。
    //
    // 两点实测经验：
    //   1. 不要用 requestAnimationFrame 做节流 —— 一旦 rAF 不回调（标签页隐藏、
    //      无头浏览器等），「已排队」标志会永久卡住，滚动高亮就此失效。
    //   2. 不能只依赖 scroll 事件 —— 在无头浏览器里实测该事件可能完全不触发
    //      （同一份判定逻辑换成轮询则 5/5 正确）。低频轮询同时也能覆盖
    //      「整页锚点跳转」「CSS 滚动吸附」等不产生连续 scroll 事件的场景。
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    window.setInterval(update, 250);
    update();
})();
