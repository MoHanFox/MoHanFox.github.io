/**
 * navbar.js — 通用导航栏（所有页面顶部）
 * 自动计算资源路径（页面在 /Pages/ 下时使用 ../ 前缀），
 * 注入字体/导航栏样式，读取 localStorage 中的登录用户并渲染：
 *   - 已登录：头像 + 名称 + 下拉（个人信息 / 退出登录）
 *   - 未登录：登录按钮
 *
 * 用法：在页面 <body> 末尾引用 <script src=".../navbar.js"></script>（路径按页面层级）。
 */
(function () {
    'use strict';

    // 计算资源根路径：页面位于 /Pages/ 子目录时资源需加 ../ 前缀
    var isInPages = /\/Pages\//.test(window.location.pathname);
    var base = isInPages ? '../' : '';

    // ---- 注入样式（字体 + 导航栏；重复加载无害，浏览器会缓存） ----
    ['Style/HaloStyle.css', 'Style/Nav/NavBar.css'].forEach(function (css) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = base + css;
        document.head.appendChild(link);
    });

    // ---- 读取登录用户（登录/注册成功后由 login.js / register.js 写入 localStorage） ----
    var user = null;
    try {
        user = JSON.parse(localStorage.getItem('halo_user') || 'null');
    } catch (e) {
        user = null;
    }

    // ---- 创建导航栏 DOM ----
    var nav = document.createElement('nav');
    nav.className = 'halo-navbar';
    nav.innerHTML =
        '<div class="halo-navbar-left">' +
        '    <a class="halo-nav-brand" href="' + base + 'index.html">' +
        '        <img src="' + base + 'Resources/Images/Halo.svg" alt="HALO">' +
        '        <span>MOHAN</span>' +
        '    </a>' +
        '    <a class="halo-nav-home" href="' + base + 'index.html">首页</a>' +
        '</div>' +
        '<div class="halo-navbar-right" id="haloNavRight"></div>';
    document.body.insertBefore(nav, document.body.firstChild);

    var right = document.getElementById('haloNavRight');
    if (!right) return;
})();
