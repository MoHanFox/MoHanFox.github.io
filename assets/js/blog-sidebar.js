/**
 * blog-sidebar.js — 博客首页的分类侧栏 + 文章搜索
 *
 * 三件事：
 *   1. 展开 / 收起任意层级的分类（层数不限，节点由构建脚本递归生成）；
 *   2. 点分类筛选文章列表；
 *   3. 按关键字搜索标题 / 摘要 / 标签。
 *
 * 分类与搜索是**与**关系：先按分类缩小，再在结果里搜关键字；清掉关键字就回到该分类的全部。
 * 状态写进 URL 的 `?cat=` 与 `?q=`，因此刷新、分享链接、浏览器前进后退都能还原，
 * 全部在前端完成，不产生额外页面。
 */
(function () {
    'use strict';

    var sidebar = document.querySelector('[data-sidebar]');
    var list = document.querySelector('[data-list]');
    if (!list) return; // 没有列表（例如空状态页）就没必要继续

    var cards = Array.prototype.slice.call(list.querySelectorAll('.blog-card'));
    var statusEl = document.querySelector('[data-filter-status]');
    var emptyEl = document.querySelector('[data-filter-empty]');
    var emptyTitleEl = emptyEl ? emptyEl.querySelector('.blog-empty-title') : null;
    var emptyDescEl = emptyEl ? emptyEl.querySelector('.blog-empty-desc') : null;

    var input = document.querySelector('[data-search-input]');
    var clearBtn = document.querySelector('[data-search-clear]');
    var scopeSelect = document.querySelector('[data-search-scope]');
    var filterButtons = sidebar ? Array.prototype.slice.call(sidebar.querySelectorAll('[data-filter]')) : [];

    /**
     * state.scope 决定搜哪个字段：
     *   'meta'    标题 + 摘要 + 标签（构建时写进 data-text）
     *   'content' 文章正文（构建时写进 data-content，超长会截断以控制页面体积）
     */
    var state = { cat: '', query: '', scope: 'meta' };

    var SCOPE_PLACEHOLDER = {
        meta: '搜索标题、摘要或标签…',
        content: '搜索文章内的关键字…'
    };
    var SCOPE_LABEL = {
        meta: '标题、摘要、标签',
        content: '文章内关键字'
    };

    /* ---------------- 卡片数据 ---------------- */

    function cardPaths(card) {
        var raw = card.getAttribute('data-cats') || '';
        return raw ? raw.split(/\s+/).filter(Boolean) : [];
    }

    /** 关键词检索用的纯文本：按当前范围取 data-text 或 data-content */
    function cardText(card) {
        var attr = state.scope === 'content' ? 'data-content' : 'data-text';
        return (card.getAttribute(attr) || '').toLowerCase();
    }

    /** 命中分类：完全相等，或所选分类是该文章分类的祖先路径 */
    function matchCat(card, selected) {
        if (!selected) return true;
        var paths = cardPaths(card);
        for (var i = 0; i < paths.length; i += 1) {
            var path = paths[i];
            if (path === selected) return true;
            // 前缀必须是完整的一段，避免 Go 命中 Gopher
            if (path.length > selected.length &&
                path.slice(0, selected.length) === selected &&
                path.charAt(selected.length) === '/') {
                return true;
            }
        }
        return false;
    }

    function matchQuery(card, query) {
        if (!query) return true;
        var text = cardText(card);
        // 多个关键字按「都要命中」处理，便于逐步缩小范围
        var words = query.split(/\s+/).filter(Boolean);
        for (var i = 0; i < words.length; i += 1) {
            if (text.indexOf(words[i]) === -1) return false;
        }
        return true;
    }

    /* ---------------- 应用筛选 ---------------- */

    function setActiveButton(selected) {
        filterButtons.forEach(function (button) {
            var value = button.getAttribute('data-filter') || '';
            var active = value === selected;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    /** 展开选中项的所有祖先，保证它可见 */
    function revealAncestors(selected) {
        if (!selected) return;
        filterButtons.forEach(function (button) {
            if ((button.getAttribute('data-filter') || '') !== selected) return;
            var node = button.closest('.blog-side-group');
            while (node) {
                var parentList = node.parentElement;
                if (!parentList || !parentList.hasAttribute('data-subs')) break;
                parentList.removeAttribute('hidden');
                var parentGroup = parentList.closest('.blog-side-group');
                var parentToggle = parentGroup ? parentGroup.querySelector('.blog-side-row [data-toggle]') : null;
                if (parentToggle) parentToggle.setAttribute('aria-expanded', 'true');
                node = parentGroup;
            }
        });
    }

    function updateEmptyState(shown) {
        if (!emptyEl) return;
        if (shown > 0) {
            emptyEl.setAttribute('hidden', '');
            return;
        }
        // 有筛选条件却一篇都没有，才提示；完全没文章时由构建脚本的静态空状态负责
        if (!state.cat && !state.query) {
            emptyEl.setAttribute('hidden', '');
            return;
        }
        if (emptyTitleEl) emptyTitleEl.textContent = '未找到相关文章';
        if (emptyDescEl) {
            emptyDescEl.textContent = state.query
                ? '换个关键字试试，或点侧栏的「全部」查看所有文章。'
                : '这个分类下还没有文章。换一个分类，或点侧栏的「全部」查看所有文章。';
        }
        emptyEl.removeAttribute('hidden');
    }

    function updateStatus(shown) {
        if (!statusEl) return;
        var parts = [];
        if (state.cat) parts.push('分类：' + state.cat);
        if (state.query) parts.push('搜索「' + state.query + '」（' + SCOPE_LABEL[state.scope] + '）');

        if (!parts.length) {
            statusEl.textContent = '';
            statusEl.setAttribute('hidden', '');
            return;
        }
        statusEl.textContent = parts.join(' · ') + '（' + shown + ' 篇）';
        statusEl.removeAttribute('hidden');
    }

    function apply(updateUrl) {
        var shown = 0;
        cards.forEach(function (card) {
            var visible = matchCat(card, state.cat) && matchQuery(card, state.query);
            card.hidden = !visible;
            if (visible) shown += 1;
        });

        setActiveButton(state.cat);
        updateStatus(shown);
        updateEmptyState(shown);

        if (clearBtn) {
            if (state.query) clearBtn.removeAttribute('hidden');
            else clearBtn.setAttribute('hidden', '');
        }

        if (updateUrl !== false) syncUrl();
    }

    function syncUrl() {
        try {
            var url = new URL(window.location.href);
            if (state.cat) url.searchParams.set('cat', state.cat);
            else url.searchParams.delete('cat');
            if (state.query) url.searchParams.set('q', state.query);
            else url.searchParams.delete('q');
            // 只有非默认范围才写进 URL，避免地址栏里出现冗余参数
            if (state.query && state.scope !== 'meta') url.searchParams.set('scope', state.scope);
            else url.searchParams.delete('scope');
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        } catch (error) {
            // 例如 file:// 下的异常：筛选照常工作，只是不同步到地址栏
        }
    }

    /* ---------------- 分类侧栏交互 ---------------- */

    if (sidebar) {
        sidebar.addEventListener('click', function (event) {
            var target = event.target;
            if (!target || !target.closest) return;

            // 箭头位于筛选按钮内部，所以必须先判断它，否则点箭头会连带触发筛选
            var toggle = target.closest('[data-toggle]');
            if (toggle && sidebar.contains(toggle)) {
                event.preventDefault();
                event.stopPropagation();

                var group = toggle.closest('.blog-side-group');
                var subs = group ? group.querySelector(':scope > [data-subs]') : null;
                if (!subs) return;

                var expanded = toggle.getAttribute('aria-expanded') === 'true';
                toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                if (expanded) subs.setAttribute('hidden', '');
                else subs.removeAttribute('hidden');
                // 记住展开状态，返回/刷新后仍保持
                saveExpanded();
                return;
            }

            var button = target.closest('[data-filter]');
            if (!button || !sidebar.contains(button)) return;
            event.preventDefault();
            state.cat = button.getAttribute('data-filter') || '';
            // 选中深层分类时把祖先展开，否则看不到自己选中的是哪一项
            revealAncestors(state.cat);
            // 这次展开也要记住：否则返回后祖先收回去，选中的子项又藏起来了
            saveExpanded();
            apply(true);
        });
    }

    /* ---------------- 搜索交互 ---------------- */

    function normalize(value) {
        return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    }

    if (input) {
        var timer = null;
        input.addEventListener('input', function () {
            // 输入时不必每敲一下就重排，略作延迟手感更好
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(function () {
                state.query = normalize(input.value);
                apply(true);
            }, 120);
        });

        // 回车立即生效，不等延迟
        input.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (timer) window.clearTimeout(timer);
            state.query = normalize(input.value);
            apply(true);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            if (input) input.value = '';
            state.query = '';
            apply(true);
            if (input) input.focus();
        });
    }

    /** 输入框的提示语与选择框保持一致 */
    function syncPlaceholder() {
        if (input) input.setAttribute('placeholder', SCOPE_PLACEHOLDER[state.scope] || SCOPE_PLACEHOLDER.meta);
    }

    if (scopeSelect) {
        scopeSelect.addEventListener('change', function () {
            state.scope = scopeSelect.value === 'content' ? 'content' : 'meta';
            syncPlaceholder();
            // 换范围后清空关键字：否则旧关键字在新范围下可能一篇都搜不到，让人以为坏了
            if (state.query) {
                state.query = '';
                if (input) input.value = '';
            }
            apply(true);
            if (input) input.focus();
        });
    }

    // 浏览器前进 / 后退（同页内的筛选历史）
    window.addEventListener('popstate', function () {
        readUrl();
        if (input) input.value = state.query;
        if (scopeSelect) scopeSelect.value = state.scope;
        syncPlaceholder();
        apply(false);
        // 同页返回也算「返回」：同样恢复到原来的位置
        restorePageScroll();
    });

    function readUrl() {
        try {
            var params = new URL(window.location.href).searchParams;
            state.cat = params.get('cat') || '';
            state.query = normalize(params.get('q'));
            state.scope = params.get('scope') === 'content' ? 'content' : 'meta';
        } catch (error) {
            state.cat = '';
            state.query = '';
            state.scope = 'meta';
        }
    }

    /* ---------------- 状态记忆（展开项 + 滚动位置） ----------------
       分类本身已经写在 URL（?cat=…）里，所以「返回时记住分类」天然成立；
       这里补上两件不带 URL 的状态：展开的分组、滚动位置。
       用 sessionStorage：刷新与返回/前进都保留，关掉标签页即清空
       （比 localStorage 更符合「这次浏览的上下文」语义）。 */

    var EXPANDED_KEY = 'halo:blog:expanded';
    var SCROLL_KEY = 'halo:blog:scroll';

    function groupKey(group) {
        if (!group) return '';
        // 注意用后代选择器：data-filter 与 data-toggle 都嵌在同一个 <button> 内部，
        // 箭头是 button 的子元素而不是 .blog-side-row 的直接子元素（这里踩过坑）
        var button = group.querySelector('.blog-side-row [data-filter]');
        return button ? button.getAttribute('data-filter') || '' : '';
    }

    /** 记录当前已展开的分组（用分类路径作 key，刷新后仍能对上） */
    function saveExpanded() {
        if (!sidebar) return;
        try {
            var list = [];
            sidebar.querySelectorAll('.blog-side-group [data-toggle][aria-expanded="true"]')
                .forEach(function (toggle) {
                    var key = groupKey(toggle.closest('.blog-side-group'));
                    if (key) list.push(key);
                });
            window.sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(list));
        } catch (error) {
            // 隐私模式 / 存储被禁用：记不住不影响使用
        }
    }

    function restoreExpanded() {
        if (!sidebar) return;
        var list;
        try {
            list = JSON.parse(window.sessionStorage.getItem(EXPANDED_KEY) || '[]');
        } catch (error) {
            list = [];
        }
        if (!Array.isArray(list) || !list.length) return;

        list.forEach(function (key) {
            sidebar.querySelectorAll('.blog-side-group').forEach(function (group) {
                if (groupKey(group) !== key) return;
                var subs = group.querySelector(':scope > [data-subs]');
                var toggle = group.querySelector('.blog-side-row [data-toggle]');
                if (subs) subs.removeAttribute('hidden');
                if (toggle) toggle.setAttribute('aria-expanded', 'true');
            });
        });
    }

    /**
     * 修复品读位置：读者读完列表最下面那篇，返回列表页时不该再从头翻。
     *
     * 靠浏览器自己的滚动恢复不可靠 —— 本站的列表是「构建时全渲染 + JS 筛选」，
     * 页面加载早期卡片可能还是隐藏的、文档高度不足，浏览器的自动恢复会落空。
     * 所以这里改成显式控制：
     *   · history.scrollRestoration = 'manual'，不让浏览器和我们抢；
     *   · 只有「返回/前进历史」或「刷新」才恢复；
     *     从导航栏重新点进博客（type=reload 之外的新导航）则从顶部开始，
     *     符合「我主动进列表页，想从头看」的预期。
     */
    var navType = (function () {
        try {
            return (window.performance && performance.getEntriesByType
                ? (performance.getEntriesByType('navigation')[0] || {}).type
                : '') || '';
        } catch (error) {
            return '';
        }
    })();
    var SHOULD_RESTORE = navType === 'back_forward' || navType === 'reload' || navType === 'prerender';

    if ('scrollRestoration' in window.history) {
        try {
            window.history.scrollRestoration = 'manual';
        } catch (error) {
            // 个别浏览器只读：不影响，下面的显式恢复仍然生效
        }
    }

    function saveScroll() {
        try {
            window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
                page: window.scrollY || window.pageYOffset || 0,
                side: sidebar ? sidebar.scrollTop || 0 : 0
            }));
        } catch (error) {
            // 隐私模式 / 存储被禁用：记不住不影响浏览
        }
    }

    function restorePageScroll() {
        var saved;
        try {
            saved = JSON.parse(window.sessionStorage.getItem(SCROLL_KEY) || 'null');
        } catch (error) {
            saved = null;
        }
        if (!saved || typeof saved.page !== 'number') return;

        var target = saved.page;
        // 参考当前高度先给哨兵，便于自动化测试确认「恢复逻辑确实执行过」
        document.documentElement.setAttribute('data-scroll-target', String(target));
        // 文档高度在筛选/字体加载后才会稳定，所以带几次重试；
        // 这是「返回后停在原位」可靠性的关键，不能只设一次。
        var tries = 0;
        var apply = function () {
            tries += 1;
            window.scrollTo(0, target);
            var doc = document.documentElement;
            var reached = Math.abs((window.scrollY || 0) - target) < 2;
            // 还没滚到目标（文档高度不够）就再试几次；已经到底则不必空转
            if (!reached && tries < 6 && doc.scrollHeight > doc.clientHeight) {
                window.setTimeout(apply, 60);
            }
        };
        window.requestAnimationFrame(apply);

        if (sidebar && typeof saved.side === 'number' && saved.side > 0) {
            window.setTimeout(function () {
                sidebar.scrollTop = saved.side;
            }, 0);
        }
    }

    /**
     * 首次加载时是否该恢复位置。
     * 只有「返回/前进历史」或「刷新」才恢复；从导航栏主动点进博客则从顶部开始。
     * 注意：同页 popstate 的导航类型仍是 'navigate'，所以那条路径不走这个判断，
     * 由 popstate 处理器直接调用 restorePageScroll()。
     */
    function restoreOnFirstLoad() {
        if (SHOULD_RESTORE) restorePageScroll();
    }

    // 节流保存滚动位置：scroll 事件很密集，没必要每次都写 sessionStorage
    var scrollTimer = null;
    function onScroll() {
        if (scrollTimer) return;
        scrollTimer = window.setTimeout(function () {
            scrollTimer = null;
            saveScroll();
        }, 150);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    if (sidebar) sidebar.addEventListener('scroll', onScroll, { passive: true });
    // pagehide 比 beforeunload 更可靠（移动端 Safari 常常不触发 beforeunload）
    window.addEventListener('pagehide', saveScroll);
    // 标签页/窗口切到后台也存一次：读者很可能是直接切走再回来
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') saveScroll();
    });

    /* ---------------- 初始化 ---------------- */

    readUrl();
    if (input) input.value = state.query;
    if (scopeSelect) scopeSelect.value = state.scope;
    syncPlaceholder();
    restoreExpanded();
    if (state.cat) revealAncestors(state.cat);
    apply(false);
    // 恢复品读位置：放在 apply 之后，此时筛选已应用、列表高度基本确定
    restoreOnFirstLoad();
})();
