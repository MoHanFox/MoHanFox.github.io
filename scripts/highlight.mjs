/**
 * highlight.mjs — 构建时的极简语法高亮
 *
 * 为什么自己写而不是装 highlight.js / prismjs：
 *   · 那类库压缩后仍有 30–100 KB，而本站只用到 go / java 少数几种语言；
 *   · 本站是高亮需求很轻的场景（关键词、字符串、注释、数字、函数名），
 *     一个正则 tokenizer 就够，且零依赖、零体积、结果可复现。
 *   · 构建时产出静态 HTML，访客不需要下载任何高亮脚本。
 *
 * 设计要点：
 *   · **单次扫描**（一个组合正则从左到右推进），不是「先替换字符串、再替换关键词」——
 *     后者会把字符串/注释里的关键词也高亮掉，是这类代码最常见的 bug。
 *   · **语言无关**：词法规则通用（注释/字符串/数字/标识符/运算符），
 *     只有「哪些词算关键词」按语言查表。
 *   · **绝不改变代码内容**：输出与输入除标签外逐字符相同，格式（含缩进与空行）原样保留，
 *     这样复制粘贴代码不会坏。渲染后有测试逐字符比对来保证这一点。
 *   · 输入是 **marked 已转义过的文本**（`<` 已变 `&lt;`），所以先解码、再高亮、再统一转义。
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 转义 HTML（与 markdown.mjs 的策略一致） */
function esc(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** 把 marked 转义过的文本还原成原始代码（只解一次，再统一转义，避免 &amp;lt; 这类双重转义） */
function decodeEntities(text) {
    return String(text)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** 语言别名 -> 关键词表的键 */
const LANG_ALIAS = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    node: 'javascript',
    golang: 'go',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', python3: 'python',
    cs: 'csharp', 'c#': 'csharp', dotnet: 'csharp',
    'c++': 'cpp', cxx: 'cpp', cc: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell',
    yml: 'yaml',
    html5: 'html',
    h: 'c', header: 'c'
};

/**
 * 各语言的关键词 / 类型 / 字面量。
 * 宁可少列也不要多列：漏标只是少个颜色，误标会把普通变量名染色，更难看。
 */
const KEYWORDS = {
    go: `break case chan const continue default defer else fallthrough for func go goto
         if import interface map package range return select struct switch type var`,
    java: `abstract assert break case catch class const continue default do else enum extends
           final finally for goto if implements import instanceof interface native new package
           private protected public return static strictfp super switch synchronized this throw
           throws transient try volatile while var record sealed permits yield`,
    javascript: `async await break case catch class const continue debugger default delete do else
                 export extends finally for function if import in instanceof let new of return
                 static super switch this throw try typeof var void while with yield`,
    typescript: `abstract any as asserts async await break case catch class const continue declare
                 default delete do else enum export extends finally for from function get if
                 implements import in infer instanceof interface is keyof let module namespace
                 new of private protected public readonly return satisfies set static super switch
                 this throw try type typeof var void while yield`,
    python: `and as assert async await break class continue def del elif else except finally for
             from global if import in is lambda nonlocal not or pass raise return try while with yield`,
    csharp: `abstract as base bool break byte case catch char checked class const continue decimal
             default delegate do double else enum event explicit extern false finally fixed float for
             foreach goto if implicit in int interface internal is lock long namespace new null
             object operator out override params private protected public readonly ref return sbyte
             sealed short sizeof stackalloc static string struct switch this throw true try typeof
             uint ulong unchecked unsafe ushort using virtual void volatile while var async await
             record`,
    cpp: `alignas alignof auto bool break case catch char class const constexpr continue decltype
          default delete do double else enum explicit export extern false float for friend goto if
          inline int long mutable namespace new noexcept nullptr operator private protected public
          register return short signed sizeof static struct switch template this throw true try
          typedef typeid typename union unsigned using virtual void volatile while`,
    c: `auto break case char const continue default do double else enum extern float for goto if
        inline int long register restrict return short signed sizeof static struct switch typedef
          union unsigned void volatile while`,
    rust: `as async await break const continue crate dyn else enum extern false fn for if impl in
           let loop match mod move mut pub ref return self Self static struct super trait true type
           unsafe use where while`,
    shell: `case do done elif else esac fi for function if in local return select then time until
            while export readonly`,
    sql: `select from where insert into values update set delete create table drop alter index view
          join inner left right outer on group by having order limit offset as and or not null
          primary key foreign references distinct count sum avg min max`,
    yaml: `true false null yes no on off`,
    json: `true false null`,

    // go.mod 是**独立语法**，不能按 .go 处理：
    // 它是指令式的（module / require / replace ...），正文里根本不会出现 func/if，
    // 而 require 这些指令词也不在 Go 关键词表里。版本号（v1.7.9）另有专门规则。
    gomod: `module go toolchain require replace exclude retract use
            indirect incompatible`
};

/** Go 的内建类型不是关键字，但值得单独染色 */
const TYPES = {
    go: `bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune
         string uint uint8 uint16 uint32 uint64 uintptr any comparable`,
    java: `boolean byte char double float int long short String Integer Long Double Boolean
           Character Object List Map Set ArrayList HashMap`,
    csharp: `bool byte char decimal double float int long object sbyte short string uint ulong
             ushort void var dynamic`,
    javascript: `Array Boolean Date Error Function JSON Map Math Number Object Promise Proxy RegExp
                 Set String Symbol WeakMap WeakSet BigInt`,
    typescript: `Array Boolean Date Error Function JSON Map Math Number Object Promise RegExp Set
                 String Symbol BigInt Record Partial Readonly Pick Omit`,
    python: `bool bytes dict float frozenset int list object set str tuple type`,
    cpp: `bool char double float int long short size_t string vector map set unsigned void`,
    c: `bool char double float int long short size_t unsigned void`
};

/** 把模板字符串形式的词表拆成 Set */
function toSet(source) {
    const set = new Set();
    String(source || '')
        .split(/\s+/)
        .map((word) => word.trim())
        .filter(Boolean)
        .forEach((word) => set.add(word));
    return set;
}

const KEYWORD_SETS = {};
Object.keys(KEYWORDS).forEach((lang) => { KEYWORD_SETS[lang] = toSet(KEYWORDS[lang]); });
const TYPE_SETS = {};
Object.keys(TYPES).forEach((lang) => { TYPE_SETS[lang] = toSet(TYPES[lang]); });

/** 源码文件扩展名 → 语言标识（用于「围栏写成文件名」的兜底） */
const EXT_TO_LANG = {
    go: 'go',
    // go.mod / go.sum 是各自的格式，不要并到 go
    mod: 'gomod',
    sum: 'gomod',
    java: 'java', kt: 'java',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c', c: 'c',
    rs: 'rust',
    sh: 'shell', bash: 'shell',
    sql: 'sql',
    yml: 'yaml', yaml: 'yaml',
    json: 'json',
    html: 'html', htm: 'html',
    css: 'css'
};

/** 语言别名 → 关键词表。注意 `go.mod` / `go.sum` 要单独映射，不能落到 go */
const MODULE_FILE_LANG = {
    'go.mod': 'gomod',
    'go.sum': 'gomod',
    'go.work': 'gomod'
};

/**
 * 归一化语言名。
 *
 * 除了别名映射，还要处理**写成文件名**的情况：写 Issue 时很容易把围栏写成
 * ```main.go（本仓库的文章里真的出现过 `mian.go`），
 * 那样查表查不到，整块代码就一点颜色都没有。所以先看扩展名，再看首段。
 */
export function normalizeLang(lang) {
    const raw = String(lang || '').trim().toLowerCase();
    if (!raw) return '';

    // 1) 本身就是已知标识 / 别名（`go` / `golang` / `C#` ...）
    if (LANG_ALIAS[raw]) return LANG_ALIAS[raw];
    if (KEYWORD_SETS[raw] || TYPE_SETS[raw]) return raw;

    // 2) 模块文件优先：`go.mod` / `go.sum` / `go.work` 是**独立语法**。
    //    这一步必须排在扩展名之前，否则 `go.mod` 会因为 `.go` 前缀被当成 Go 代码。
    const base = raw.split('/').pop();
    if (MODULE_FILE_LANG[base]) return MODULE_FILE_LANG[base];

    // 3) 形态像文件名（`main.go` / `a/b/c.java`）：按扩展名认
    const fileMatch = /^[\w./+-]+\.([a-z0-9]+)$/.exec(raw);
    if (fileMatch) {
        const byExt = EXT_TO_LANG[fileMatch[1]];
        if (byExt) return byExt;
    }

    // 4) 取首段再试（`mian.go` -> `mian` 认不出来就作罢；
    //    写成 `golang` 这类无扩展名的别名已在第 1 步处理）
    const head = raw.split(/[.\s/]/)[0];
    if (head && (LANG_ALIAS[head] || KEYWORD_SETS[head] || TYPE_SETS[head])) {
        return LANG_ALIAS[head] || head;
    }

    return raw;
}

/** 支持高亮的语言（用于判断是否值得包 span，未支持的语言直接原样转义输出） */
export function isSupported(lang) {
    const key = normalizeLang(lang);
    return Boolean(KEYWORD_SETS[key] || TYPE_SETS[key]);
}

/* 单次扫描用的组合正则。顺序很重要：
   1) 注释必须在运算符之前，否则 `//` 会被当成除号；
   2) 版本号要在数字之前，否则 `v1.7.9` 会被数字规则拆成 `v1` + `.7` + `.9`；
   3) **关键词要先于「后跟括号」的函数名分支**，否则 go.mod 里的 `require (`
      会被当成函数调用而上错颜色。 */
const TOKEN_RE = new RegExp([
    '(?<comment>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*)',
    '(?<triple>"{{3}|\\\'{{3}})',
    '(?<string>"(?:\\\\.|[^"\\\\\\n])*"|\\\'(?:\\\\.|[^\\\'\\\\\\n])*\\\'|`(?:\\\\.|[^`\\\\])*`)',
    // 语义化版本：v1.7.9 / v1.2 / v2.0.0-rc.1 / 2.0.0 —— 整体着色，不拆碎
    '(?<version>v\\d+(?:\\.\\d+)+(?:-[0-9A-Za-z.+-]+)?|\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.+-]+)?)',
    // 数字：整数、小数、进制、科学计数法。小数的 `.` 后面必须是数字，
    // 且不能再跟 `.<数字>`（否则会把版本号的后半截吃掉）
    '(?<number>\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+(?!\\.\\d))?(?:[eE][+-]?\\d+)?)\\b)',
    // 语句关键词：优先判定，避免 `require (` 被当成函数名
    '(?<kw>[A-Za-z_$][A-Za-z0-9_$]*)',
    // 函数名：标识符后面紧跟 `(`。
    // 刻意**不**把 `foo.bar` 里的 `foo` 也算进来 —— 那是包名/命名空间，
    // 应保持代码块默认字色（`fmt.Printf` 的 fmt、`router.GET` 的 router）。
    '(?<fn>[A-Za-z_$][A-Za-z0-9_$]*\\s*(?=\\())',
    '(?<ident>[A-Za-z_$][A-Za-z0-9_$]*)',
    '(?<op>=>|->|::|==|!=|<=|>=|&&|\\|\\||\\+\\+|--|[-+*/%=<>!&|^~?:.]+)',
    '(?<punct>[{}()\\[\\];,])',
    '(?<space>\\s+)',
    '(?<other>[\\s\\S])'
].join('|'), 'g');

/**
 * 给一段代码加高亮，返回 HTML。
 * @param {string} code marked 转义过的代码文本
 * @param {string} lang 语言标识（可空）
 * @returns {string} HTML；未支持的语言返回原样转义的内容，不加任何 span
 */
export function highlightCode(code, lang) {
    const source = decodeEntities(code);
    const key = normalizeLang(lang);
    const keywords = KEYWORD_SETS[key] || null;
    const types = TYPE_SETS[key] || null;

    // 未知语言：不做高亮，但仍要正确转义
    if (!keywords && !types) return esc(source);

    let out = '';
    TOKEN_RE.lastIndex = 0;
    let match;

    // keywords / types 都可能为 null（例如 gomod 只配了指令词、没有类型表），
    // 所以取词时必须判空 —— 否则会抛 TypeError，整页 Markdown 渲染失败。
    const classify = (word) => {
        if (keywords && keywords.has(word)) return 'tok-keyword';
        if (types && types.has(word)) return 'tok-type';
        return '';
    };

    while ((match = TOKEN_RE.exec(source)) !== null) {
        const g = match.groups || {};
        const raw = match[0];

        if (g.comment) {
            out += `<span class="tok-comment">${esc(raw)}</span>`;
        } else if (g.triple) {
            // 三引号字符串（Python 等）：多数场景当成字符串处理即可
            out += `<span class="tok-string">${esc(raw)}</span>`;
        } else if (g.string) {
            out += `<span class="tok-string">${esc(raw)}</span>`;
        } else if (g.version) {
            // 语义化版本号整体着色，不拆成 v1 / .7 / .9
            out += `<span class="tok-version">${esc(raw)}</span>`;
        } else if (g.number) {
            out += `<span class="tok-number">${esc(raw)}</span>`;
        } else if (g.kw) {
            // kw 分支吃掉所有普通标识符，所以这里要按优先级自己分派：
            //   1) 已知关键词/类型 → 关键词色（`require (` 里的 require 就走这条）
            //   2) 后面紧跟 `(` → 函数名
            //   3) 其余 → 原样（包名、变量名都属于这类，保持默认字色）
            const kind = classify(raw);
            if (kind) {
                out += `<span class="${kind}">${esc(raw)}</span>`;
            } else if (/^\s*\(/.test(source.slice(TOKEN_RE.lastIndex))) {
                const name = raw.trimEnd();
                const tail = raw.slice(name.length);
                out += `<span class="tok-fn">${esc(name)}</span>${esc(tail)}`;
            } else {
                out += esc(raw);
            }
        } else if (g.fn) {
            // 函数名：保留原空白（`func (` 这种带空格的形态）
            const name = raw.trimEnd();
            const tail = raw.slice(name.length);
            out += `<span class="tok-fn">${esc(name)}</span>${esc(tail)}`;
        } else if (g.ident) {
            const kind = classify(raw);
            out += kind ? `<span class="${kind}">${esc(raw)}</span>` : esc(raw);
        } else {
            // 运算符、标点、空白、其它：原样输出（已转义）
            out += esc(raw);
        }
    }

    return out;
}
