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
    var filterButtons = sidebar ? Array.prototype.slice.call(sidebar.querySelectorAll('[data-filter]')) : [];

    var state = { cat: '', query: '' };

    /* ---------------- 卡片数据 ---------------- */

    function cardPaths(card) {
        var raw = card.getAttribute('data-cats') || '';
        return raw ? raw.split(/\s+/).filter(Boolean) : [];
    }

    /** 关键词检索用的纯文本：标题 + 摘要 + 标签，构建时已写好 */
    function cardText(card) {
        return (card.getAttribute('data-text') || '').toLowerCase();
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
                var parentToggle = parentGroup ? parentGroup.querySelector(':scope > .blog-side-row > [data-toggle]') : null;
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
        if (state.query) parts.push('搜索：' + state.query);

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
                return;
            }

            var button = target.closest('[data-filter]');
            if (!button || !sidebar.contains(button)) return;
            event.preventDefault();
            state.cat = button.getAttribute('data-filter') || '';
            // 选中深层分类时把祖先展开，否则看不到自己选中的是哪一项
            revealAncestors(state.cat);
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

    // 浏览器前进 / 后退
    window.addEventListener('popstate', function () {
        readUrl();
        if (input) input.value = state.query;
        apply(false);
    });

    function readUrl() {
        try {
            var params = new URL(window.location.href).searchParams;
            state.cat = params.get('cat') || '';
            state.query = normalize(params.get('q'));
        } catch (error) {
            state.cat = '';
            state.query = '';
        }
    }

    /* ---------------- 初始化 ---------------- */

    readUrl();
    if (input) input.value = state.query;
    if (state.cat) revealAncestors(state.cat);
    apply(false);
})();
