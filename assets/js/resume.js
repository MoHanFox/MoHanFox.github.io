/**
 * resume.js — 简历树渲染（第 3 屏）
 *
 * 数据来源：assets/data/resume.json（可用 JSON 自由定制，支持任意层级子级）
 * 渲染约定：
 *   - 主干在板块左端，由 .resume-tree::before 画出；
 *   - 子级用嵌套 <ul class="resume-children">，相对父级缩进并带分支线；
 *   - 节点圆点 .resume-dot 绝对定位到主干/分支线上。
 * 容错：数据下载失败时只在该区块显示提示，不影响页面其它部分。
 */
(function () {
    'use strict';

    var DATA_URL = 'assets/data/resume.json';

    var tree = document.querySelector('[data-resume-tree]');
    var profileBox = document.querySelector('[data-resume-profile]');
    var statusEl = document.querySelector('[data-resume-status]');
    var jump = document.querySelector('.resume-jump');

    /** 设置区块状态文案；kind 为 'error' 时高亮样式 */
    function setStatus(message, kind) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.classList.toggle('resume-status--error', kind === 'error');
    }

    function createEl(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (typeof text === 'string' && text) el.textContent = text;
        return el;
    }

    /** 渲染树节点（递归） */
    function renderNode(item) {
        if (!item || typeof item !== 'object') return null;

        var li = createEl('li', 'resume-node');
        var row = createEl('div', 'resume-item');

        row.appendChild(createEl('span', 'resume-dot'));

        var head = createEl('div', 'resume-item-head');
        var title = item.title || item.name || '';
        if (title) head.appendChild(createEl('h3', 'resume-item-title', String(title)));
        if (item.time) head.appendChild(createEl('span', 'resume-item-time', String(item.time)));

        if (head.childNodes.length) row.appendChild(head);

        if (item.desc) {
            var desc = createEl('p', 'resume-item-desc', String(item.desc));
            // 允许数据里用 \n 表示换行
            desc.style.whiteSpace = 'pre-line';
            row.appendChild(desc);
        }

        var tags = Array.isArray(item.tags) ? item.tags : [];
        if (tags.length) {
            var tagBox = createEl('div', 'resume-tags');
            tags.forEach(function (tag) {
                if (tag === null || tag === undefined || tag === '') return;
                tagBox.appendChild(createEl('span', 'resume-tag', String(tag)));
            });
            if (tagBox.childNodes.length) row.appendChild(tagBox);
        }

        li.appendChild(row);

        var children = Array.isArray(item.children) ? item.children : [];
        if (children.length) {
            var sub = createEl('ul', 'resume-list resume-children');
            children.forEach(function (child) {
                var childNode = renderNode(child);
                if (childNode) sub.appendChild(childNode);
            });
            if (sub.childNodes.length) li.appendChild(sub);
        }

        return li;
    }

    /** 渲染概览卡 */
    function renderProfile(profile) {
        if (!profileBox || !profile || typeof profile !== 'object') return;
        profileBox.textContent = '';

        var left = createEl('div', 'resume-profile-main');
        if (profile.name) left.appendChild(createEl('h3', 'resume-profile-name', String(profile.name)));
        if (profile.title) left.appendChild(createEl('p', 'resume-profile-title', String(profile.title)));
        if (left.childNodes.length) profileBox.appendChild(left);

        var links = Array.isArray(profile.links) ? profile.links : [];
        var linkBox = createEl('div', 'resume-profile-links');
        links.forEach(function (link) {
            if (!link || !link.label || !link.url) return;
            var a = createEl('a', 'resume-profile-link', String(link.label));
            a.href = String(link.url);
            if (/^https?:/i.test(a.href)) {
                a.target = '_blank';
                a.rel = 'noopener';
            }
            linkBox.appendChild(a);
        });
        if (linkBox.childNodes.length) profileBox.appendChild(linkBox);

        // 数据里没有概览内容时，不要留一个空壳卡片
        if (!profileBox.childNodes.length) profileBox.remove();
    }

    function render(data) {
        if (!tree) return;
        if (!data || !Array.isArray(data.timeline)) {
            throw new Error('简历数据缺少 timeline 数组');
        }

        renderProfile(data.profile);

        var list = createEl('ul', 'resume-list');
        var count = 0;

        data.timeline.forEach(function (section) {
            var node = renderNode(section);
            if (!node) return;
            list.appendChild(node);
            count += 1;
        });

        if (!count) throw new Error('简历数据 timeline 为空');

        tree.textContent = '';
        tree.appendChild(list);

        // 「跳至最下」交给 CSS 平滑滚动即可；这里只兜底保证锚点存在
        if (jump && !jump.getAttribute('href')) {
            jump.setAttribute('href', '#bottom');
        }
    }

    function init() {
        // 页面上没有简历区块时静默退出（便于本脚本被其它页面复用）
        if (!tree) return;

        if (typeof fetch !== 'function') {
            setStatus('当前浏览器不支持自动载入简历数据，请升级浏览器后重试。', 'error');
            return;
        }

        fetch(DATA_URL, { cache: 'no-cache' })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            })
            .then(function (data) {
                render(data);
            })
            .catch(function (error) {
                // 只降级这一个区块：正文仍可阅读，页脚与其它区块不受影响
                setStatus('简历数据载入失败（' + (error && error.message ? error.message : '未知错误') +
                    '）。请确认 ' + DATA_URL + ' 存在且为合法 JSON。', 'error');
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
