/**
 * blog-sidebar.js — 博客首页分类侧栏
 *
 * 两件事：
 *   1. 展开 / 收起任意层级的分类（层数不限，节点由构建脚本递归生成）；
 *   2. 点分类筛选文章列表。
 *
 * 筛选状态放在 URL 的 `?cat=` 里，因此刷新、分享链接、浏览器前进后退都能还原，
 * 不需要服务端参与，也不产生额外页面。
 *
 * 筛选规则：选中 `Go` 时，`Go/精选` 下的文章也算在内（命中「自己或后代路径」）。
 */
(function () {
    'use strict';

    var sidebar = document.querySelector('[data-sidebar]');
    var list = document.querySelector('[data-list]');
    if (!sidebar || !list) return;

    var cards = Array.prototype.slice.call(list.querySelectorAll('.blog-card'));
    var statusEl = document.querySelector('[data-filter-status]');
    var emptyEl = document.querySelector('[data-filter-empty]');
    var filterButtons = Array.prototype.slice.call(sidebar.querySelectorAll('[data-filter]'));

    /* ---------------- 点击委托：箭头展开 / 分类筛选 ---------------- */

    sidebar.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;

        // 箭头位于筛选按钮内部，所以必须先判断它，否则点箭头会连带触发筛选
        var toggle = target.closest('[data-toggle]');
        if (toggle && sidebar.contains(toggle)) {
            event.preventDefault();
            // 阻止冒泡，避免同一次点击又被下面的筛选逻辑处理
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
        var selected = button.getAttribute('data-filter') || '';
        // 选中深层分类时，把它的祖先一并展开，否则看不到自己选中的是哪一项
        revealAncestors(selected);
        apply(selected, true);
    });

    /* ---------------- 筛选 ---------------- */

    /** 卡片所属分类路径（构建时写进 data-cats） */
    function cardPaths(card) {
        var raw = card.getAttribute('data-cats') || '';
        return raw ? raw.split(/\s+/).filter(Boolean) : [];
    }

    /** 命中判定：完全相等，或所选分类是该文章分类的祖先路径 */
    function matches(card, selected) {
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

    function apply(selected, updateUrl) {
        var shown = 0;
        cards.forEach(function (card) {
            var visible = !selected || matches(card, selected);
            card.hidden = !visible;
            if (visible) shown += 1;
        });

        setActiveButton(selected);

        if (statusEl) {
            if (selected) {
                statusEl.textContent = '分类：' + selected + '（' + shown + ' 篇）';
                statusEl.removeAttribute('hidden');
            } else {
                statusEl.textContent = '';
                statusEl.setAttribute('hidden', '');
            }
        }
        if (emptyEl) {
            if (selected && shown === 0) emptyEl.removeAttribute('hidden');
            else emptyEl.setAttribute('hidden', '');
        }

        if (updateUrl !== false) {
            try {
                var url = new URL(window.location.href);
                if (selected) url.searchParams.set('cat', selected);
                else url.searchParams.delete('cat');
                window.history.replaceState(null, '', url.pathname + url.search + url.hash);
            } catch (error) {
                // 例如 file:// 下的异常：筛选照常工作，只是不同步到地址栏
            }
        }
    }

    // 浏览器前进 / 后退
    window.addEventListener('popstate', function () {
        apply(readSelected(), false);
    });

    function readSelected() {
        try {
            return new URL(window.location.href).searchParams.get('cat') || '';
        } catch (error) {
            return '';
        }
    }

    // 初始化：URL 里带 ?cat= 就还原，并展开到该项
    var initial = readSelected();
    if (initial) {
        var exists = filterButtons.some(function (button) {
            return (button.getAttribute('data-filter') || '') === initial;
        });
        if (exists) {
            revealAncestors(initial);
            apply(initial, false);
        } else {
            apply('', false);
        }
    } else {
        apply('', false);
    }
})();
