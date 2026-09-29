/**
 * hero.js — 主页首屏：打字机标题 + 滚动入场
 *
 * 打字机行为（按需求）：
 *   主标题「丨漠寒MOHAN」逐字出现 → 子标题「· Welcome To」接着逐字出现
 *   → 结束后子标题末尾的 _ 光标持续闪烁。
 * 滚动入场：带 [data-animate] 的区块进入视口时淡入上移。
 * 无障碍：用户系统开启“减弱动态效果”时，文字直接完整显示，不做逐字动画。
 */
(function () {
    'use strict';

    var reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------------- 1. 打字机 ---------------- */

    /**
     * 逐字打印一组元素。
     * @param {Array}  queue    待打印元素，按顺序依次打印
     * @param {Object} options  cursor / typeSpeed / startDelay
     * @param {Function} done   全部打印完成后的回调
     */
    function typeSequence(queue, options, done) {
        var opts = options || {};
        var cursor = opts.cursor || null;
        var typeSpeed = typeof opts.typeSpeed === 'number' ? opts.typeSpeed : 55;
        var startDelay = typeof opts.startDelay === 'number' ? opts.startDelay : 220;

        // 元素无文本时直接跳过，避免出现「打印空串」的停顿
        var items = (queue || []).filter(function (entry) {
            return entry && entry.el && typeof entry.text === 'string' && entry.text.length > 0;
        });

        if (!items.length) {
            if (cursor) cursor.classList.add('is-done');
            if (typeof done === 'function') done();
            return;
        }

        // 光标默认停在最后一段文字之后；每进入下一段就把它挪过去
        if (cursor) cursor.style.display = '';

        var queueIndex = 0;
        var charIndex = 0;
        var current = items[0];

        if (cursor && current.el.parentNode) {
            current.el.parentNode.appendChild(cursor);
        }

        function step() {
            if (charIndex >= current.text.length) {
                queueIndex += 1;
                charIndex = 0;

                if (queueIndex >= items.length) {
                    if (cursor) cursor.classList.add('is-done');
                    if (typeof done === 'function') done();
                    return;
                }

                current = items[queueIndex];
                if (cursor && current.el.parentNode) {
                    current.el.parentNode.appendChild(cursor);
                }
            }

            charIndex += 1;
            current.el.textContent = current.text.slice(0, charIndex);
            window.setTimeout(step, typeSpeed);
        }

        window.setTimeout(step, startDelay);
    }

    function initTypewriter() {
        var titleEl = document.querySelector('.hero-title [data-type-text]');
        var subEl = document.querySelector('.hero-sub [data-type-text]');
        var cursor = document.querySelector('[data-type-cursor]');

        // 页面上没有首屏标题（例如被复用到其它页面）时静默退出
        if (!titleEl && !subEl) return;

        var titleText = titleEl ? (titleEl.textContent || '').trim() : '';
        var subText = subEl ? (subEl.textContent || '').trim() : '';

        // 先在 HTML 里写好完整文本（无 JS 也能看到内容），再清空给打字机用
        if (titleEl) titleEl.textContent = '';
        if (subEl) subEl.textContent = '';

        if (reduceMotion) {
            if (titleEl) titleEl.textContent = titleText;
            if (subEl) subEl.textContent = subText;
            if (cursor) {
                cursor.style.display = '';
                cursor.classList.add('is-done');
            }
            return;
        }

        typeSequence([
            { el: titleEl, text: titleText },
            { el: subEl, text: subText }
        ], {
            cursor: cursor,
            // 打字速度：每字 55ms（比原来的 110ms 快一倍），起始停顿也缩短
            typeSpeed: 55,
            startDelay: 220
        });
    }

    /* ---------------- 2. 滚动划入 / 划出（非对称） ---------------- */

    /**
     * 滚动动画，刻意做成**非对称**的：
     *
     *   · 往下滑：板块进入视口时划入；划出视口**顶部**的板块保持原样（已经读过了，
     *     不该在身后突然消失）。
     *   · 往上滑：板块进入视口时划入；划出视口**底部**的板块淡出（那是还没读的
     *     内容，收回视线时让它退场才符合直觉）。
     *
     * 所以判断依据不是「是否在视口内」这一个布尔值，而是「离开的是哪条边」，
     * 这需要知道滚动方向 —— 见下面的 lastY。
     *
     * 健壮性关键点：区块默认是可见的（CSS 只在 .js-reveal 存在时才隐藏），
     * 由这里在确认脚本可用后主动加上 .js-reveal 开启动画。这样——即便 JS 被
     * 拦截、报错或浏览器不支持 IntersectionObserver——正文也不会永久不可见。
     *
     * 另外**不能** unobserve：要处理「划出」，就得持续收到进出通知。
     */
    function initScrollReveal() {
        var nodes = document.querySelectorAll('[data-animate]');
        if (!nodes.length) return;

        // 不支持 IntersectionObserver 时保持默认可见，直接不做动画
        if (!('IntersectionObserver' in window)) return;

        document.documentElement.classList.add('js-reveal');

        var lastY = window.scrollY;

        var observer = new IntersectionObserver(function (entries) {
            var goingDown = window.scrollY >= lastY;
            lastY = window.scrollY;

            entries.forEach(function (entry) {
                var target = entry.target;

                if (entry.isIntersecting) {
                    target.classList.add('is-visible');
                    return;
                }

                // 视口之外：位于视口上方说明是「往下滑时从顶部离开」→ 保留状态；
                // 位于下方说明是「往上滑时从底部离开」→ 淡出。
                var rect = entry.boundingClientRect;
                var above = rect.bottom <= 0;

                if (above) {
                    target.classList.add('is-visible');
                } else if (!goingDown) {
                    target.classList.remove('is-visible');
                }
            });
        }, {
            // 阈值取 0，配一点内缩：区块基本离开视口才处理，避免边缘反复抖动
            threshold: 0,
            rootMargin: '-6% 0px -6% 0px'
        });

        Array.prototype.forEach.call(nodes, function (node) {
            observer.observe(node);
        });

        // 兜底：4 秒后把「当前在视口内」的补上显示，避免任何情况下内容被“藏住”
        window.setTimeout(function () {
            Array.prototype.forEach.call(nodes, function (node) {
                var rect = node.getBoundingClientRect();
                var inView = rect.bottom > 0 && rect.top < window.innerHeight;
                if (inView) node.classList.add('is-visible');
            });
        }, 4000);
    }

    /* ---------------- 启动 ---------------- */

    function init() {
        initTypewriter();
        initScrollReveal();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
