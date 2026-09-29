# MoHanFox.github.io

个人主页 + 博客站。纯静态、无打包步骤：直接改源码，由 GitHub Pages 发布。

- **主页**：首屏打字机 Welcome → GitHub 数据面板 → JSON 驱动的简历树 → 页脚小猫
- **博客**：文章来自本仓库的 **GitHub Issues**，由 GitHub Actions 自动构建成静态页面并发布

---

## 一、目录结构

```
MoHanFox.github.io/
├── index.html                          主页入口
├── 404.html                            ★ 自定义 404（Pages 用它替换默认报错页）
├── .nojekyll                           关闭 Jekyll，确保 _ 开头的文件能发布
├── .gitattributes                      统一行尾为 LF，并标记二进制资源
├── .gitignore                          忽略 IDE / 系统文件
├── README.md                           本文件
│
├── assets/                             ── 站点资源 ──
│   ├── css/
│   │   ├── base.css                    基础层：@font-face 字体族 + :root 设计令牌 + 全局重置
│   │   ├── components.css              组件层：.HaloInput / .HaloButton / .copyRight
│   │   ├── navbar.css                  导航栏样式（类名与 navbar.js 注入的 DOM 对应）
│   │   └── pages/
│   │       ├── home/
│   │       │   ├── base.css            区块节奏、标题组、滚动入场动画
│   │       │   ├── hero.css            首屏：满屏背景 + 打字机标题
│   │       │   ├── stats.css           第 2 屏骨架（卡片样式在 stats.js 内）
│   │       │   ├── resume.css          第 3 屏简历树
│   │       │   └── footer.css          第 4 屏页脚小猫
│   │       └── blog/
│   │           ├── blog.css            博客样式（列表页与文章页共用）
│   │           ├── sidebar.css         首页分类侧栏样式（任意层级缩进）
│   │           ├── toc.css             文章页右侧章节导航样式
│   │           └── giscus.css          评论区样式（未启用评论时不加载）
│   ├── data/
│   │   ├── resume.json                 ★ 简历树数据源，改这个文件即可更新简历
│   │   └── demo-issues.json            ★ 本地 UI 检验用的演示数据（假文章，见第五节）
│   ├── js/
│   │   ├── navbar.js                   通用导航栏（自动推导资源前缀 + 当前页高亮）
│   │   ├── hero.js                     首屏打字机 + 滚动入场
│   │   ├── resume.js                   读取 resume.json 并渲染简历树
│   │   ├── stats.js                    GitHub 统计图表（含超时/失败降级）
│   │   ├── toc.js                      文章页章节导航的滚动高亮
│   │   └── blog-sidebar.js             首页分类侧栏：展开/收起 + 筛选
│   ├── templates/
│   │   └── blog/
│   │       ├── index.html              列表页骨架模版（{{TOKEN}} 占位）
│   │       └── post.html               文章页骨架模版
│   ├── img/
│   │   ├── halo.svg                    站点 Logo
│   │   ├── welcome.png                 首屏背景图
│   │   └── cat.svg                     页脚简笔小猫（手写 SVG）
│   └── fonts/                          OPlus Sans 3 字体（5 个字重，约 45.5 MB）
│
├── package.json                        构建脚本依赖（仅 marked）；站点本身无需打包
├── giscus.json                         ★ 评论（giscus / GitHub Discussions）配置，见第四节
│
├── pages/
│   └── blog/                           ── 博客（构建产物，由 Actions 生成）──
│       ├── index.html                  文章列表（脚本生成，勿手改）
│       ├── post-{number}.html          每篇文章（脚本生成，勿手改）
│       └── data/
│           └── issues.json             issue 原始数据（脚本生成）
│
├── scripts/
│   ├── build-issues.mjs                抓取带 blog 标签的 Issue → issues.json
│   ├── markdown.mjs                    md → HTML（marked；原始 HTML 会被转义）
│   └── build-blog.mjs                  issues.json → 列表页 + 各文章页
│
└── .github/workflows/
    └── blog.yml                        issue → JSON → 页面 → gh-pages 的自动部署管线
```

---

## 二、主页四屏

### 1. 首屏 Welcome

- 背景图 `assets/img/welcome.png` 铺满首屏（`100dvh`），并叠加 `rgba(10,16,36,0.35)` 深色遮罩，即整体明度压到约 65%；
- 主标题 `丨漠寒MOHAN` 与子标题 `· Welcome To` **左对齐**；
- 打字效果：主标题逐字出现 → 子标题接着逐字出现 → 结束后子标题末尾的 `_` 光标持续闪烁（`heroBlink` 动画）；
- 系统开启「减弱动态效果」时，文字直接完整显示，不做逐字动画。

### 2. GitHub 数据面板

- **3D 语言维度**：`github-readme-stats` 的 top-langs 卡片；
- **2D 活跃维度**：`github-readme-stats` 总览卡 + `streak-stats` 连续贡献卡。

> **重要已知限制**：这些公共统计服务在中国大陆网络下经常超时或被拦截。
> `stats.js` 因此对每张图都做了降级：8 秒超时或加载失败时，换成一张中文提示卡片（附「前往 github.com/MoHanFox 查看」与「重试」按钮），**不会**出现布局塌陷或控制台报错。
> 想彻底解决，可把 `stats.js` 顶部的 `CONFIG.readmeStatsBase` / `CONFIG.streakBase` 换成自建实例（例如自己部署一份 github-readme-stats）。

### 3. 个人简历树

- 布局从上往下排，**主干线在板块左端**，子级相对父级缩进并带分支线，**支持任意层级嵌套**；
- 板块右上角有「跳至最下」，平滑滚动到页脚；
- 数据完全由 `assets/data/resume.json` 驱动，改 JSON 即改简历，不需要碰 HTML/CSS/JS。

### 4. 页脚

手写简笔小猫 SVG + 一行文字「这是哪只小猫跑到施工的工地上了」，并提供「回到顶部」。

---

## 三、简历树定制（`assets/data/resume.json`）

```json
{
  "profile": {
    "name": "显示名",
    "title": "一句话自我介绍",
    "links": [{ "label": "GitHub", "url": "https://github.com/MoHanFox" }]
  },
  "timeline": [
    {
      "title": "节点标题（必填）",
      "time": "2024 — 2026",
      "desc": "描述。支持 \\n 换行。",
      "tags": ["标签一", "标签二"],
      "children": [
        { "title": "子级节点", "time": "2024", "children": [{ "title": "孙级节点" }] }
      ]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `profile.name` | 否 | 概览卡姓名 |
| `profile.title` | 否 | 概览卡副标题 |
| `profile.links[]` | 否 | `{label, url}`，http(s) 链接自动新窗口打开 |
| `timeline[]` | **是** | 顶层节点数组，为空会显示错误提示 |
| `title` | 否 | 节点标题，缺失则跳过 |
| `time` | 否 | 右侧时间范围文字 |
| `desc` | 否 | 描述，`\n` 会渲染为换行 |
| `tags[]` | 否 | 标签胶囊 |
| `children[]` | 否 | 子级数组，可无限嵌套 |

仓库里的 `resume.json` 目前是**示例内容**（教育经历/工作经历等都标了「请替换」），请按实际经历修改。

> 建议：改完 JSON 后用 `node -e "JSON.parse(require('fs').readFileSync('assets/data/resume.json','utf8'))"` 验一下，格式错误会让第 3 屏显示「简历数据载入失败」提示（其它屏不受影响）。

---

## 四、博客：写 Issue 即发文

### 工作方式

1. 在仓库新建 Issue，用 Markdown 写正文，打上 **`blog`** 标签；
2. Issue 被创建/编辑/打标签/关闭时，GitHub Actions 触发 `scripts/build-issues.mjs`；
3. 脚本调用 GitHub REST API 抓取带 `blog` 标签的 Issue，生成 `pages/blog/data/issues.json`；
4. 整站内容发布到 **`gh-pages`** 分支，Pages 自动更新。源码分支不会出现机器人的提交。

### 发文约定

| 约定 | 说明 |
|---|---|
| 文章标识 | `blog` 标签（大小写不敏感） |
| 草稿 | 加 `draft` 标签则不发布（`blog` + `draft` 同时存在也不发布） |
| 摘要 | 正文中插入 `<!--more-->`，其之前的内容作为摘要；没有则取前 200 字符 |
| 其它标签 | 会作为文章的 `tags` 输出（`blog`、`draft` 除外） |
| 排序 | 按 Issue 的 `updatedAt` 倒序 |

### 启用步骤（首次）

1. 仓库 → **Settings → Pages** → Source 选 **Deploy from a branch**，分支选 **`gh-pages`**、目录 `/ (root)`；
2. 仓库 → **Settings → Actions → General → Workflow permissions** 选 **Read and write permissions**（部署需要写 `gh-pages`）；
3. 仓库 → **Issues → Labels** 新建两个标签：`blog`、`draft`；
4. 建一个带 `blog` 标签的 Issue，或在 **Actions → blog-pipeline → Run workflow** 手动跑一次，即可看到 `gh-pages` 分支与 `pages/blog/data/issues.json`。

> ⚠️ 工作流默认检出 **`dev`** 分支。若改用 `main` 作为发布源，请把 `.github/workflows/blog.yml` 里 checkout 的 `ref: ... : 'dev'` 与 push 触发的 `branches: [dev]` 一并改成 `main`。

### 本地验证脚本（不联网）

```powershell
# 1) 用夹具生成 issues.json（不联网）
npm install
node scripts/build-issues.mjs `
  --from-file .\fixture.json `
  --repo MoHanFox/MoHanFox.github.io `
  --out .\pages\blog\data\issues.json
# 2) 渲染成博客页面
node scripts/build-blog.mjs
```

`--from-file` 需要一个 JSON 数组（或 `{ "issues": [...] }`）作为夹具，可直接用 API 返回的 issue 数组。
`build-blog.mjs` 还支持 `--data <path>` / `--out-dir <dir>` / `--check`（只校验不写盘，发现过期文章页即失败）。

### 博客前端如何生成

Markdown 在 **构建时**渲染成 HTML（不是浏览器里渲染），因此有 SEO、首屏也更快：

```
issues.json ──> scripts/build-blog.mjs ──> pages/blog/index.html          文章列表
                      │                   pages/blog/post-{number}.html  每篇文章
                      └── scripts/markdown.mjs（marked，md→HTML）
```

- 两个页面的骨架来自 `assets/templates/blog/index.html` 与 `post.html`，脚本只做 `{{TOKEN}}` 替换 —— **改版式改模板，不用改脚本**。
- `scripts/markdown.mjs` 会把 md 里的原始 HTML **转义**而非原样输出，因此 Issue 正文里写 `<script>` 不会被执行。
- 链接与图片的地址走**协议白名单**：只放行 `http` / `https` / `mailto` / `tel` / 相对路径 / 锚点 / 协议相对（`//host`）。
  `javascript:`、`data:`、`vbscript:`、`file:` 等一律拒绝 —— 被拒时**只去掉 href/src、保留链接文字与 alt**，内容不会丢。
  实体与空白绕过（`&#106;avascript:`、`java\nscript:`）也一并拦截；外链会自动补 `rel="noopener noreferrer"`。
- 模板里若用了脚本未提供的 token，`build-blog.mjs` 会**直接报错**，不会静默替换成空内容。
- 文章下线（摘掉 `blog` 标签或删除 Issue）后，对应的 `post-*.html` 会被自动清理，不留死链。
- 样式在 `assets/css/pages/blog/blog.css`，列表页与文章页共用同一份，并与主页共享 `base.css` 的设计令牌。

### 文章为空 / 页面不存在时

- **博客没有文章**（或某个分类下没有文章）时，列表页显示「**暂无内容**」的提示卡片，页面照常可访问，**不会变成 404**；
- 仓库根目录有自定义 [404.html](404.html)，GitHub Pages 用它替换默认的英文报错页：
  访问任何不存在的地址都会看到同样风格的「这里暂无内容」，并给出去首页 / 去博客的入口；
- 若失效链接指向 `/pages/blog/...`，404 页会额外补一句说明
  —— 因为文章来自 Issue，Issue 被取消 `blog` 标签或删除后，对应文章页会一并下线；
- 工作流的 `_site` 组装与健全性检查都已包含 `404.html`，漏了会导致线上退回 GitHub 默认 404。

### 首页搜索

搜索框在**第一篇文章上方**，下面有一个**搜索范围**选择框。

| 范围 | 说明 |
|---|---|
| `标题、摘要、标签`（默认） | 匹配 `data-text`，构建时由标题 + 摘要 + 标签拼成 |
| `文章内关键字` | 匹配 `data-content`，构建时由正文 Markdown 转成纯文本（去代码块/表格分隔行/标记） |

- 切换范围会**清空关键字**并更新输入框提示语 —— 否则旧关键字在新范围下可能一篇都搜不到，容易让人以为坏了；
- 检索全在**前端**完成（构建时就把可搜文本写进卡片属性），不发请求、不产生额外页面；
- 大小写不敏感；多个关键字按「**都要命中**」处理（`go 并发` 只留同时含两者的文章）；
- 输入有 120ms 防抖，回车立即生效；
- 与分类筛选是**与**关系：先按分类缩小，再在结果里搜关键字；清掉关键字就回到该分类的全部；
- 状态写进 URL 的 `?q=` 与 `?scope=`（默认范围不写，避免冗余参数），刷新、分享链接、前进后退都能还原；
- 无结果时列表位置显示「未找到相关文章」，并提供「清空」按钮。

> ⚠️ **正文搜索的长度上限**：每篇文章只有**前 3000 个字符**会进入 `data-content`（见 `build-blog.mjs` 的 `SEARCH_CONTENT_LIMIT`）。
> 这是为了控制列表页体积 —— 否则文章一多，首页会变成几百 KB。
> 代价是**很长的文章，靠后的内容搜不到**。要完整可搜就得改成按需 fetch 正文，那样首屏更快但首次搜索会慢一拍。

### 首页分类侧栏

博客首页左侧有分类侧栏：**「全部」+ 可展开的分类树**。

**分类来自 Issue 的标签**，标签里的 `/` 表示层级，**层数不限**：

| Issue 标签 | 侧栏效果 |
|---|---|
| `Go` | 顶层分类「Go」 |
| `Go/精选` | 「Go」下的子栏目「精选」，可展开/收起 |
| `Go/精选/并发` | 再下一层，想加多少层都行 |
| `Java`、`日常学习` | 各自成为顶层分类 |

- **计数含后代**：`Go` 显示的文章数 = 标了 `Go` 的 + `Go/精选` 的 + 更深层的总和；
- **点父级能看到全部**：选中 `Go` 时，`Go/精选/并发` 下的文章也会显示；
- 前缀按完整层级匹配，`Go` 不会误命中 `Gopher`；
- 筛选是纯前端行为（不产生额外页面），状态写进 URL 的 `?cat=`，因此**刷新、分享链接、浏览器前进后退都能还原**；
- 选中深层分类时会**自动展开它的所有祖先**，不会出现"选了却看不见选中项"；
- 没有 `blog` 以外标签的文章只在「全部」里出现。

维护提示：侧栏的缩进由构建时写入的 `--depth` 驱动（每级 14px），所以增加层级不需要改 CSS。
展开箭头是筛选按钮的**子元素**，点击时先判断箭头再判断按钮，否则点箭头会连带触发筛选（已处理）。

### 文章页右侧章节导航

文章页会根据正文里的标题自动生成一栏目录（`-` 刻度 + 标题），**点击定位、滚动高亮当前章节**，
交互参考 DeepSeek 对话界面右侧的对话导航。

- **永远固定在屏幕右中**（`position: fixed` + `top: 50%`），滚动时位置不变，实测滚动 400/900/1388px 三个位置坐标完全一致、与视口中心偏差 0px；
- 固定在右侧时会**给正文让出 240px**（`padding-right`），因此正文仍在剩余空间里水平居中、不会被压住；
- 目录比视口高时**自身滚动**（`max-height: 68vh`），不会溢出被裁掉；
- 断点 **1220px**：低于这个宽度放不下固定栏，改为贴在正文上方（随页面滚动，带竖线）；
- 标题锚点与目录 id **同源**（都由 `renderMarkdown` 的 `headingIds` 产生），不会出现跳转错位；
- 重名标题自动加后缀去重（`## 小结` 出现两次 → `小结` / `小结-1`）；
- 中英文标题都保留原文作锚点（`丨漠寒MOHAN` 不会被折成小写或丢失）；
- **标题少于 2 个时整栏不渲染**，也不加载对应的 CSS/JS；手机端同样不显示。

维护提示：`assets/js/toc.js` 里的滚动更新**不用 `requestAnimationFrame` 节流**，
因为 rAF 一旦不回调（标签页隐藏等），「已排队」标志会永久卡住、高亮从此失效；
同时也**不只依赖 scroll 事件**（无头浏览器实测该事件可能完全不触发），而是事件 + 250ms 低频轮询兜底。
高亮项在目录面板内滚动用的是手动 `scrollTop`，**不能用 `scrollIntoView`** —— 那会连 window 一起滚，导致页面被目录拽回去。

### 评论功能（giscus）

文章页底部有评论区，基于 **GitHub Discussions** —— 无需后端、无追踪，数据都在你自己的仓库里。
配置在仓库根目录的 [giscus.json](giscus.json)，**已配齐可直接用**：

| 项 | 值 | 说明 |
|---|---|---|
| `repoId` | `R_kgDOUaoChQ` | 仓库的 node_id |
| `category` | `Blog Chat` | Discussions 里的分类名 |
| `categoryId` | `DIC_kwDOUaoChc4DGpxu` | 该分类的 node_id |
| `theme` | `light` | **固定亮色**，与站点亮色底一致 |
| `mapping` | `pathname` | 按文章页路径匹配 Discussion 标题，**改标题也不丢评论** |

**关于主题**：不要用 `preferred_color_scheme` —— 它会跟随访客的**系统**深色设置，
而本站在两种情况下都是亮色底，访客开深色模式时评论区会变黑、与页面割裂。
`light` 才能与站点保持一致（将来若做深色主题，再改成 `preferred_color_scheme`）。

**换分类时 `category` 与 `categoryId` 必须成对更新**，写错会让 giscus 直接报错。

> 取 `categoryId` 的办法（GraphQL 与 giscus.app 都要授权，匿名拿不到）：
> REST 的 `GET /repos/{owner}/{repo}/discussions` 响应里**带讨论所属分类的 node_id**，
> 所以只要目标分类下已经有任意一条讨论，就能从这里读到它。
> 注意该端点**只返回「有讨论的分类」**，空分类不会出现。

不想开评论就把 `enabled` 改成 `false`：此时既不加载 `giscus.css`，也不加载任何外部脚本。
配置齐全时加载脚本；开了评论但 id 没填全时显示「评论区即将开放」的指引卡片，而不是空白。

### 关于「能不能直接渲染 README / md」

GitHub Pages 是纯静态托管，**不认 md**：README 放在仓库里只会被当文本吐出，不会渲染成页面。
所以「直接渲染 md」只能二选一 —— 构建时转 HTML（本项目的做法），或浏览器里用 JS 渲染（需要客户端库、不利于 SEO）。
本项目的 Issue 正文本身就是 Markdown，`issues.json` 里也原样保留了 `body`，所以"能渲染 md"这件事已经具备，无需再绕一层 README。

---

## 五、本地预览

必须用 HTTP 服务打开，不要直接双击 HTML（`file://` 下字体加载与 `fetch` 行为不一致）：

```powershell
python -m http.server 8000
# 浏览器访问 http://localhost:8000/
```

> 博客的 `pages/blog/index.html` 与 `post-*.html` 是**构建产物、不入库**（见 `.gitignore`），
> 所以新克隆仓库后 `pages/blog/` 是空的 —— **在 IDE 里直接打开博客页会 404，这是正常的**，不是坏了。
> 主页（`index.html`）与简历树不需要构建，直接起服务即可。

### 本地跑起博客（四种方式）

```powershell
npm install          # 只为 marked

# 1) 只想看空状态：不需要任何数据
npm run preview:blog

# 2) 检验 UI（推荐）：用内置演示数据，覆盖各种边界
npm run preview:demo

# 3) 用真实数据：自己准备一份 issue 夹具（数组，或 { "issues": [...] }）
node scripts/build-issues.mjs --from-file .\fixture.json --repo MoHanFox/MoHanFox.github.io
node scripts/build-blog.mjs

# 4) 起服务后访问
python -m http.server 8000
# 首页 http://localhost:8000/ ，博客 http://localhost:8000/pages/blog/
```

也可以 `npm run preview:demo:serve`（生成演示站点并直接起 8000 端口）。

**演示数据**在 `assets/data/demo-issues.json`（8 篇假文章，不是真内容），刻意覆盖了这些边界，方便一眼看出样式问题：

| 覆盖点 | 对应用例 |
|---|---|
| 三层分类嵌套 | `Go` / `Go/精选` / `Go/精选/并发` |
| 多顶层分类 | Go、Java、日常学习、效率工具 |
| 无标签文章 | 只出现在「全部」，卡片不渲染标签区 |
| 标签很多 | 4 个标签的换行表现 |
| 关闭状态 | `state: closed` 显示「已关闭」 |
| 超长标题 | 卡片换行 + 章节导航省略号 |
| 空摘要 | 卡片不渲染摘要行 |
| 标题不足 2 个 | 目录整栏不渲染、不加载 toc.css |
| 正文元素 | 多级标题、代码块、表格、引用、任务列表、长段落 |

> 这份演示数据放在 `assets/` 下，而 `assets/` 会整个部署到线上，所以站点上也能访问到它（内容是假文章、无隐私）。
> 构建产物 `pages/blog/**` 在 `.gitignore` 里，**不入库** —— 所以本地怎么折腾都不会影响提交。

> 直接双击 HTML 文件（`file://`）不行：`navbar.js` 注入的样式与简历树的 `fetch` 都需要 HTTP 环境。
> 构建产物不入库，所以每次拉取最新代码后都要重新跑一次上面的构建命令。

---

## 六、样式分层约定

按「令牌 → 基础 → 组件 → 页面」组织，页面只引自己需要的层：

| 层 | 文件 | 写什么 | 不要写什么 |
|---|---|---|---|
| 令牌 | `base.css` 的 `:root` | 颜色、字体族、圆角、过渡变量 | 具体选择器规则 |
| 基础 | `base.css` | `@font-face`、`box-sizing` 重置、`body` 默认排版 | 组件样式 |
| 组件 | `components.css`、`navbar.css` | 可跨页面复用的原子件 | 页面独有布局 |
| 页面 | `pages/**/*.css` | 仅该页使用的规则 | 全局重置 |

新增规则时优先复用变量，例如 `color: var(--color-primary)`，不要直接写十六进制色值。

### 新增页面

```html
<head>
    <link rel="stylesheet" href="../assets/css/base.css">
    <link rel="stylesheet" href="../assets/css/components.css">
    <link rel="stylesheet" href="../assets/css/navbar.css">
    <link rel="stylesheet" href="../assets/css/pages/xxx.css">
</head>
<body>
    <!-- 页面内容 -->

    <script src="../assets/js/navbar.js"></script>
</body>
```

`navbar.js` 会按 `<script>` 自身的 `src` 反推站点根，所以**任意层级**都能正确解析资源路径，无需改脚本。
注意根目录的 `index.html` **不要**写 `../` 前缀（会跳出站点导致 404）。

---

## 七、已知事项与后续优化

- **字体体积**：`assets/fonts/` 约 45.5 MB，其中 `oplus-sans-3-extralight.ttf` 当前无 `@font-face` 引用（`base.css` 中已注释保留）。克隆体积偏大，后续可考虑按需子集化或 Git LFS。
- **统计图依赖第三方**：公共统计服务在大陆网络下不稳定，已做降级；根治方式是换成自建实例。
- **简历 QR/PDF**：`resume.css` 里已写 `@media print` 规则，浏览器直接打印简历不会带上页脚与跳转按钮。
- `assets/css/components.css` 中的 `.HaloInput` / `.HaloButton` 首页未全部使用，保留供表单页复用。
