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
        var typeSpeed = typeof opts.typeSpeed === 'number' ? opts.typeSpeed : 110;
        var startDelay = typeof opts.startDelay === 'number' ? opts.startDelay : 420;

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
            typeSpeed: 110,
            startDelay: 420
        });
    }

    /* ---------------- 2. 滚动入场 ---------------- */

    /**
     * 滚动入场。
     * 健壮性关键点：区块默认是可见的（CSS 只在 .js-reveal 存在时才隐藏），
     * 由这里在确认脚本可用后主动加上 .js-reveal 开启动画。这样——即便 JS 被
     * 拦截、报错或浏览器不支持 IntersectionObserver——正文也不会永久不可见。
     */
    function initScrollReveal() {
        var nodes = document.querySelectorAll('[data-animate]');
        if (!nodes.length) return;

        // 不支持 IntersectionObserver 时保持默认可见，直接不做动画
        if (!('IntersectionObserver' in window)) return;

        document.documentElement.classList.add('js-reveal');

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            });
        }, {
            threshold: 0.12,
            rootMargin: '0px 0px -8% 0px'
        });

        Array.prototype.forEach.call(nodes, function (node) {
            observer.observe(node);
        });

        // 兜底：8 秒后仍未显示的一律直接显示，避免任何情况下内容被“藏住”
        window.setTimeout(function () {
            Array.prototype.forEach.call(nodes, function (node) {
                if (!node.classList.contains('is-visible')) {
                    node.classList.add('is-visible');
                    observer.unobserve(node);
                }
            });
        }, 8000);
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
