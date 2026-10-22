/*
 * ticktodo.cc 交互脚本（无依赖）
 *
 * 模块：
 *   1. 基础：版本配置 / 中英切换 / 发布状态徽标 / 下载链接 / 复制 / 导航 / 进场动画
 *   2. 工具墙 + 跑马灯（数据只在 TOOLS 一处维护）
 *   3. 「以前 / 现在」FLIP 动画、功能卡片里的迷你交互（滑块 / MCP / 更新）
 *   4. 首屏演示：迷你 macOS 桌面里可操作的 Ticktodo 面板 + 自动播放脚本
 *
 * 版本号与「下一版」状态来自 index.html 里的 window.TICK_SITE（发版时只改那一处）。
 * 中文写在 DOM 里，英文写在元素的 data-en 上；动态内容（演示、工具墙）各自按 lang 渲染。
 */
(() => {
  'use strict';

  // ======================================================================
  // 1. 基础
  // ======================================================================
  const CFG = Object.assign({ version: '0.2.1', date: '2026-10-19', nextShippedIn: null, nextDate: '' }, window.TICK_SITE || {});
  /** nextShippedIn 一填，页面上「下一版」的东西就整体算已发布 */
  const SHIPPED = Boolean(CFG.nextShippedIn);
  const REL_VERSION = SHIPPED ? CFG.nextShippedIn : CFG.version;
  const REL_DATE = SHIPPED ? CFG.nextDate : CFG.date;
  const REPO = 'https://github.com/Jacky-li-li-li/ticktodo';
  const INSTALL_CMD = 'curl -fsSL https://ticktodo.cc/install.sh | sh';
  const reduced = Boolean(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let lang = 'zh';
  /** 按当前语言取值：L('中文', 'English')，或 L(['中文', 'English']) */
  const L = (zh, en) => (Array.isArray(zh) ? zh[lang === 'en' ? 1 : 0] : lang === 'en' ? en : zh);

  const TITLE = { zh: document.title, en: 'Ticktodo — Every AI session for a todo, at a glance' };
  const ZH_HTML = new WeakMap();
  const ZH_ATTR = new WeakMap();

  function applyLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    $$('[data-en]').forEach((el) => {
      if (!ZH_HTML.has(el)) ZH_HTML.set(el, el.innerHTML);
      el.innerHTML = lang === 'en' ? el.dataset.en : ZH_HTML.get(el);
    });
    $$('[data-en-label],[data-en-alt],[data-en-title]').forEach((el) => {
      if (!ZH_ATTR.has(el)) {
        ZH_ATTR.set(el, { label: el.getAttribute('aria-label'), alt: el.getAttribute('alt'), title: el.getAttribute('title') });
      }
      const zh = ZH_ATTR.get(el);
      if (el.dataset.enLabel != null) el.setAttribute('aria-label', lang === 'en' ? el.dataset.enLabel : zh.label);
      if (el.dataset.enAlt != null) el.setAttribute('alt', lang === 'en' ? el.dataset.enAlt : zh.alt);
      if (el.dataset.enTitle != null) el.setAttribute('title', lang === 'en' ? el.dataset.enTitle : zh.title);
    });
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.title = TITLE[lang];
    const btn = $('#lang');
    if (btn) {
      btn.textContent = lang === 'en' ? '中' : 'EN';
      btn.setAttribute('aria-label', lang === 'en' ? '切换到中文' : 'Switch to English');
    }
    syncRelease();
    document.dispatchEvent(new CustomEvent('tick:lang', { detail: lang }));
  }

  function initLang() {
    let initial = 'zh';
    const q = /[?&]lang=(en|zh)\b/.exec(location.search);
    try {
      if (localStorage.getItem('tick-lang') === 'en') initial = 'en';
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用：保持默认中文 */
    }
    if (q) initial = q[1];
    const btn = $('#lang');
    if (btn) {
      btn.addEventListener('click', () => {
        applyLang(lang === 'zh' ? 'en' : 'zh');
        try {
          localStorage.setItem('tick-lang', lang);
        } catch (e) {
          /* 同上 */
        }
      });
    }
    if (initial === 'en') applyLang('en');
    else syncRelease();
  }

  /**
   * 发布状态：data-since="0.2.1" = 已随该版本发布；"next" = 已合入 main、随下一版发布；
   * "planned" = 规划中。TICK_SITE.nextShippedIn 设值后，所有 next 自动显示为已发布。
   */
  function badgeInfo(since) {
    if (since === 'planned') return { cls: 'is-planned', text: L('规划中', 'Planned') };
    if (since === 'next') {
      return SHIPPED ? { cls: 'is-shipped', text: `v${CFG.nextShippedIn}` } : { cls: 'is-next', text: L('下一版', 'Next release') };
    }
    return { cls: 'is-shipped', text: `v${since}` };
  }

  function syncRelease() {
    $$('[data-since]').forEach((el) => {
      const b = badgeInfo(el.dataset.since);
      el.classList.remove('is-shipped', 'is-next', 'is-planned');
      el.classList.add('badge', b.cls);
      el.textContent = b.text;
    });
    const tag = $('#pillTag');
    const txt = $('#pillText');
    if (tag) tag.textContent = `v${SHIPPED ? CFG.nextShippedIn : CFG.version}`;
    if (txt) {
      txt.textContent = SHIPPED
        ? L('已发布：支持 15 个 AI 工具与应用内更新', 'is out: 15 AI tools and in-app updates')
        : L('已发布 · 下一版接入 15 个 AI 工具', 'is out · Next: 15 AI tools');
    }
    const rel = $('#relLine');
    if (rel) rel.textContent = `v${REL_VERSION}`;
    const strip = $('#stripTitle');
    if (strip) {
      strip.innerHTML = SHIPPED
        ? L('已接入 <b>15</b> 个 AI 工具', 'Works with <b>15</b> AI tools')
        : L(
            `已接入 <b>15</b> 个 AI 工具：v${CFG.version} 含其中 3 个，其余 12 个随下一版发布`,
            `Works with <b>15</b> AI tools — 3 in v${CFG.version}, 12 more in the next release`,
          );
    }
    $$('[data-next-hide]').forEach((el) => {
      el.hidden = SHIPPED;
    });
    const col = $('#nextCol');
    if (col) {
      col.classList.toggle('is-next', !SHIPPED);
      col.classList.toggle('is-shipped', SHIPPED);
      $('#nextTitle', col).textContent = SHIPPED ? L('已发布', 'Shipped') : L('即将发布', 'Landing next');
      $('#nextMeta', col).textContent = SHIPPED
        ? L(`随 v${CFG.nextShippedIn} 发布`, `Shipped in v${CFG.nextShippedIn}`)
        : L('已合入 main 分支，随下一个版本发布', 'Merged into main; ships with the next release');
    }
  }

  function setupDownload() {
    const base = `${REPO}/releases/download/v${REL_VERSION}/`;
    const dmg = { arm64: `${base}Tick-${REL_VERSION}-arm64.dmg`, x64: `${base}Tick-${REL_VERSION}-x64.dmg` };
    // userAgent 无法可靠识别 Apple Silicon（M 系列 Mac 也报 Intel）：默认 arm64，只有明确的非 Mac Intel 线索才给 x64
    const arch = /x86_64|x64|Win64|\bIntel\b(?!.*Mac OS X)/i.test(navigator.userAgent) ? 'x64' : 'arm64';
    const alt = arch === 'arm64' ? 'x64' : 'arm64';
    $$('[data-download]').forEach((a) => {
      a.href = dmg[arch];
      a.setAttribute('download', '');
    });
    $$('[data-dl-alt]').forEach((a) => {
      a.href = dmg[alt];
      a.textContent = alt === 'x64' ? 'Intel (x64)' : 'Apple Silicon (arm64)';
      a.setAttribute('download', '');
    });
    $$('[data-install]').forEach((el) => {
      el.textContent = INSTALL_CMD;
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      /* file:// 或旧浏览器没有 Clipboard API：退回 execCommand */
    }
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* 无能为力：按钮仍给出反馈，用户可以手动选中 */
    }
    t.remove();
  }

  function setupCopy() {
    $$('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await copyText(INSTALL_CMD);
        btn.textContent = L('已复制', 'Copied');
        btn.classList.add('ok');
        clearTimeout(btn._t);
        btn._t = setTimeout(() => {
          btn.textContent = L('复制', 'Copy');
          btn.classList.remove('ok');
        }, 1600);
      });
    });
  }

  function setupNav() {
    const top = $('.site-top');
    if (top) {
      // 滚过首屏顶部才显示分隔线，避免初始状态多一条横线
      const sync = () => top.classList.toggle('scrolled', window.scrollY > 6);
      sync();
      window.addEventListener('scroll', sync, { passive: true });
    }
    const links = $$('.nav-links a[href^="#"]');
    if (!links.length || !('IntersectionObserver' in window)) return;
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          links.forEach((a) => a.classList.toggle('active', a === byId.get(e.target.id)));
        });
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    byId.forEach((_, id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }

  function setupReveal() {
    const els = $$('.reveal');
    if (reduced || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    // 同一容器里的多个元素错开 60ms 进场（最多 300ms），避免一整块同时跳出来
    const groups = new Map();
    els.forEach((el) => {
      const list = groups.get(el.parentElement) || [];
      list.push(el);
      groups.set(el.parentElement, list);
    });
    groups.forEach((list) => {
      list.forEach((el, i) => {
        el.style.transitionDelay = `${Math.min(i, 5) * 60}ms`;
      });
    });
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          io.unobserve(e.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    els.forEach((el) => io.observe(el));
  }

  /** 进入视口时调用 onEnter，离开时调用 onLeave（用来启停循环动画，省电） */
  function whenVisible(el, onEnter, onLeave, threshold = 0.25) {
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      onEnter();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => (e.isIntersecting ? onEnter() : onLeave && onLeave()));
      },
      { threshold },
    );
    io.observe(el);
  }

  // ======================================================================
  // 2. 工具墙 + 跑马灯
  // ======================================================================
  /*
   * 15 个适配器的能力与发布状态（来源：CLAUDE.md「当前状态」与各 adapter 的 capabilities）。
   * resume：term = 终端里恢复；deeplink = 深链接打开；none = 只读索引，没有回到会话的通道。
   * create：launch = 预生成会话 id + 预填输入框；page = 打开预填好的新建页；
   *         copy = 打开工具 + 文案进剪贴板（⌘V 回车）；none = 不支持从 Tick 新建（可倒入）。
   * since：首次随哪个版本发布；next = 已合入 main、随下一版发布。
   */
  const TOOLS = [
    { id: 'pi', name: 'pi', since: '0.2.1', resume: 'term', create: 'launch', kind: 'cli' },
    { id: 'workbuddy', name: 'WorkBuddy', tag: ['国内版', 'China'], since: '0.2.1', resume: 'deeplink', create: 'page', kind: 'app' },
    { id: 'workbuddy-ai', name: 'WorkBuddy AI', tag: ['国际版', 'Global'], since: '0.2.1', resume: 'deeplink', create: 'page', kind: 'app' },
    { id: 'claude', name: 'Claude Code', since: 'next', resume: 'term', create: 'launch', kind: 'cli' },
    { id: 'claude-desktop', name: 'Claude Desktop', since: 'next', resume: 'deeplink', create: 'page', kind: 'app' },
    { id: 'codex', name: 'Codex', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    { id: 'cline', name: 'Cline', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    { id: 'grok', name: 'Grok', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    { id: 'omp', name: 'omp', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    { id: 'kimi', name: 'Kimi Code', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    {
      id: 'opencode',
      name: 'OpenCode',
      since: 'next',
      resume: 'term',
      create: 'copy',
      kind: 'both',
      note: ['桌面版入口只激活 App；CLI 能精确回到会话', 'Desktop entry only activates the app; the CLI resumes precisely'],
    },
    { id: 'qoder', name: 'Qoder', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    { id: 'qoder-cn', name: 'Qoder CN', since: 'next', resume: 'term', create: 'copy', kind: 'cli' },
    { id: 'zcode', name: 'ZCode', since: 'next', resume: 'none', create: 'none', kind: 'app' },
    { id: 'dsh', name: 'DeepSeek Harness', since: 'next', resume: 'none', create: 'none', kind: 'app' },
  ];

  const RESUME_TXT = {
    term: ['在终端里恢复会话', 'Resumes in the terminal'],
    deeplink: ['用深链接在应用里打开', 'Reopens in the app via deep link'],
    none: ['只读索引，不能回到会话', 'Indexed read-only; no way back in'],
  };
  const RESUME_ICON = { term: 'i-term', deeplink: 'i-link', none: 'i-list' };
  const CREATE_TXT = {
    launch: ['新建：预生成会话 id，文案预填进输入框', 'New: pre-generated id, prompt prefilled'],
    page: ['新建：打开预填好的新建页', 'New: opens a prefilled new-task page'],
    copy: ['新建：打开工具 + 文案进剪贴板', 'New: opens the tool, prompt on the clipboard'],
    none: ['新建：不支持，可倒入历史会话', 'New: not supported; import past sessions'],
  };
  const KIND_TXT = { cli: ['CLI', 'CLI'], app: ['桌面应用', 'Desktop app'], both: ['桌面版 + CLI', 'Desktop + CLI'] };

  // 官方矢量 mark 内联在 index.html 的 sprite 里；其余是官方位图（site/assets/tools/，来源见
  // apps/desktop/src/renderer/features/icons/assets/README.md）。WorkBuddy 两个发行版官方 mark 相同，
  // App 里国际版加的地球徽标是 Tick 自己的区分手段、不对外当作官方 logo，所以官网两版都用官方 mark。
  const MARK = { pi: 'pi', workbuddy: 'workbuddy', 'workbuddy-ai': 'workbuddy', claude: 'claude', 'claude-desktop': 'claude' };
  const IMG = { 'qoder-cn': 'qoder' };

  function iconFor(id) {
    if (MARK[id]) return `<svg class="ti" aria-hidden="true" focusable="false"><use href="#mark-${MARK[id]}"/></svg>`;
    return `<img class="ti" src="assets/tools/${IMG[id] || id}.png" width="20" height="20" alt="" draggable="false" decoding="async">`;
  }

  let toolFilter = 'all';

  function renderTools() {
    const grid = $('#toolsGrid');
    if (!grid) return;
    const tiles = TOOLS.map(
      (t) => `<li class="tool" data-resume="${t.resume}">
        <div class="tool-top"><span class="ti-tile">${iconFor(t.id)}</span><div class="tool-name">${esc(t.name)}${
          t.tag ? `<span class="tool-tag">${L(t.tag)}</span>` : ''
        }</div></div>
        <div class="tool-caps">
          <span><svg aria-hidden="true"><use href="#${RESUME_ICON[t.resume]}"/></svg>${L(RESUME_TXT[t.resume])}</span>
          <span><svg aria-hidden="true"><use href="#i-new"/></svg>${L(CREATE_TXT[t.create])}</span>
          ${t.note ? `<span><svg aria-hidden="true"><use href="#i-info"/></svg>${L(t.note)}</span>` : ''}
        </div>
        <div class="tool-foot"><span class="badge" data-since="${t.since}"></span><span class="tool-kind">${L(KIND_TXT[t.kind])}</span></div>
      </li>`,
    );
    tiles.push(`<li class="tool ask" data-resume="planned">
        <div class="tool-top"><span class="ti-tile"><svg class="ti" aria-hidden="true"><use href="#i-new"/></svg></span><div class="tool-name">Cursor</div></div>
        <p>${L('存储格式待查，暂未接入。还想接哪个工具？欢迎在 GitHub 提 issue。', 'Storage format still being investigated. Want another tool? Open an issue on GitHub.')}</p>
        <div class="tool-foot"><span class="badge" data-since="planned"></span><a class="text-link" href="${REPO}/issues/new" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-github"/></svg>${L('提 issue', 'Open an issue')}</a></div>
      </li>`);
    grid.innerHTML = tiles.join('');
    syncRelease();
    applyToolFilter(toolFilter, false);
  }

  function applyToolFilter(f, animate = true) {
    toolFilter = f;
    $$('#toolFilter [data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
    $$('#toolsGrid .tool').forEach((li) => {
      const show = f === 'all' || li.dataset.resume === f;
      const was = !li.hidden;
      li.hidden = !show;
      if (show && animate && !reduced && !was) {
        li.classList.remove('pop');
        void li.offsetWidth;
        li.classList.add('pop');
      }
    });
  }

  function renderMarquee() {
    const track = $('#marqueeTrack');
    if (!track) return;
    const item = (t, dup) =>
      `<span class="marquee-item"${dup ? ' aria-hidden="true"' : ''}><span class="ti-tile sm">${iconFor(t.id)}</span>${esc(t.name)}${
        t.tag ? `<small>${L(t.tag)}</small>` : ''
      }</span>`;
    // 两份相同列表首尾相接，translateX(-50%) 时无缝循环；第二份对读屏隐藏
    track.innerHTML = TOOLS.map((t) => item(t, false)).join('') + TOOLS.map((t) => item(t, true)).join('');
  }

  function setupTools() {
    renderTools();
    renderMarquee();
    $$('#toolFilter [data-f]').forEach((b) => b.addEventListener('click', () => applyToolFilter(b.dataset.f)));
    document.addEventListener('tick:lang', () => {
      renderTools();
      renderMarquee();
    });
  }

  // ======================================================================
  // 3. 共享：会话卡片右侧 1/8 方块滑块
  //    与 App 的 SessionCard 同一套语义：单击 = 接着做；按住向左拖到卡片最左 1/8
  //    （与终点虚线框基本贴合）才 armed，松手 → 解绑请求。竖向意图不接管。
  // ======================================================================
  function dragStart(card, block, lb) {
    card.classList.add('is-dragging');
    block.classList.add('is-dragging');
    card.insertAdjacentHTML(
      'beforeend',
      `<div class="tk-guide" aria-hidden="true"></div><div class="tk-target" aria-hidden="true"><svg><use href="#i-trash"/></svg><span>${esc(lb.unbind)}</span></div>`,
    );
    block.innerHTML = `<svg aria-hidden="true"><use href="#i-trash"/></svg><span class="tk-blk-label">${esc(lb.unbind)}</span>`;
  }

  function dragPaint(card, block, x, armed, lb) {
    block.style.transform = `translateX(${x}px)`;
    block.classList.toggle('is-armed', armed);
    const target = $('.tk-target', card);
    if (target) target.classList.toggle('is-armed', armed);
    const label = $('.tk-blk-label', block);
    if (label) label.textContent = armed ? lb.release : lb.unbind;
  }

  function dragEnd(card, block) {
    card.classList.remove('is-dragging');
    block.classList.remove('is-dragging', 'is-armed');
    block.style.transform = '';
    $$('.tk-guide, .tk-target', card).forEach((n) => n.remove());
    block.innerHTML = '<span class="tk-grip"></span>';
  }

  /** 方块在卡片里能左移的最大距离（本地坐标，负数）：终点 = 卡片最左 1/8 区的中心 */
  function slideRange(card, block, scale) {
    const rect = card.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    return (rect.left + rect.width / 16 - (rect.right - br.width / 2)) / scale;
  }

  function nudge(card) {
    card.classList.remove('is-resuming');
    void card.offsetWidth;
    card.classList.add('is-resuming');
    setTimeout(() => card.classList.remove('is-resuming'), 260);
  }

  function sliderController(root, opts) {
    root.addEventListener('pointerdown', (e) => {
      const block = e.target.closest('button.tk-blk');
      if (!block || !root.contains(block) || e.button !== 0) return;
      const card = block.closest('.tk-sess');
      if (!card) return;
      e.preventDefault();
      const scale = opts.scale ? opts.scale() : 1;
      const maxLeft = slideRange(card, block, scale);
      const st = { x: e.clientX, y: e.clientY, id: e.pointerId, locked: false, armed: false };
      try {
        block.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 合成事件没有真实指针：忽略 */
      }
      const move = (ev) => {
        if (ev.pointerId !== st.id) return;
        const dx = (ev.clientX - st.x) / scale;
        const dy = (ev.clientY - st.y) / scale;
        if (!st.locked) {
          if (Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy)) {
            st.locked = true;
            dragStart(card, block, opts.labels());
          } else return;
        }
        const x = Math.max(maxLeft, Math.min(0, dx)); // 只允许向左拖
        st.armed = x <= maxLeft + 6;
        dragPaint(card, block, x, st.armed, opts.labels());
      };
      const finish = (ev, cancelled) => {
        if (ev.pointerId !== st.id) return;
        block.removeEventListener('pointermove', move);
        block.removeEventListener('pointerup', up);
        block.removeEventListener('pointercancel', cancel);
        try {
          block.releasePointerCapture(st.id);
        } catch (err) {
          /* 已释放 */
        }
        if (!st.locked) {
          if (!cancelled) opts.onTap(card, block);
          return;
        }
        dragEnd(card, block);
        if (!cancelled && st.armed) opts.onUnbind(card, block);
      };
      const up = (ev) => finish(ev, false);
      const cancel = (ev) => finish(ev, true);
      block.addEventListener('pointermove', move);
      block.addEventListener('pointerup', up);
      block.addEventListener('pointercancel', cancel);
    });
    // 键盘（Enter / Space 触发的 click，detail === 0）= 接着做；鼠标点击已在 pointerup 里处理
    root.addEventListener('click', (e) => {
      const block = e.target.closest('button.tk-blk');
      if (block && root.contains(block) && e.detail === 0) opts.onTap(block.closest('.tk-sess'), block);
    });
  }

  // ======================================================================
  // 4. 「以前 / 现在」：相关会话从各工具的存储里飞进同一个 todo（FLIP）
  // ======================================================================
  function setupBeforeAfter() {
    const ba = $('#ba');
    if (!ba) return;
    const rel = $$('.bchip.rel', ba);
    rel.forEach((c) => {
      c._home = c.parentElement;
      c._next = c.nextElementSibling;
    });
    const tabs = $$('[data-ba]', ba);
    let state = ba.dataset.state || 'before';
    let auto = 0;

    function set(next, animate = true) {
      if (next === state) return;
      const chips = $$('.bchip', ba);
      const first = new Map(chips.map((c) => [c, c.getBoundingClientRect()]));
      state = next;
      ba.dataset.state = next;
      tabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ba === next)));
      $$('[data-cap]', ba).forEach((p) => {
        p.hidden = p.dataset.cap !== next;
      });
      const ordered = rel.slice().sort((a, b) => Number(a.dataset.o) - Number(b.dataset.o));
      if (next === 'after') {
        ordered.forEach((c) => {
          const box = $(`.ba-gbody[data-group="${c.dataset.to}"]`, ba);
          if (box) box.appendChild(c);
        });
      } else {
        rel.forEach((c) => c._home.insertBefore(c, c._next));
      }
      if (!animate || reduced || !Element.prototype.animate) return;
      chips.forEach((c) => {
        const a = first.get(c);
        const b = c.getBoundingClientRect();
        const dx = a.left - b.left;
        const dy = a.top - b.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(a.width - b.width) < 1) return;
        const k = ordered.indexOf(c);
        c.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)`, width: `${a.width}px` },
            { transform: 'translate(0, 0)', width: `${b.width}px` },
          ],
          {
            duration: k >= 0 ? 760 : 420,
            delay: k >= 0 ? k * 110 : 0,
            easing: 'cubic-bezier(.2,.75,.2,1)',
            fill: 'backwards',
          },
        );
      });
    }

    tabs.forEach((b) =>
      b.addEventListener('click', () => {
        clearTimeout(auto);
        set(b.dataset.ba);
      }),
    );
    if (reduced) {
      set('after', false);
      return;
    }
    // 宽屏才自动演示一次「以前 → 现在」：手机上切换会收起整列工具，自动触发太唐突
    let played = false;
    if (window.innerWidth < 641) return;
    whenVisible(
      ba,
      () => {
        if (played) return;
        played = true;
        auto = setTimeout(() => set('after'), 1100);
      },
      null,
      0.45,
    );
  }

  // ======================================================================
  // 5. 功能卡片里的迷你交互
  // ======================================================================
  /** 「一键接着做」卡片：真实可点、可拖的会话卡片 */
  function setupMiniResume() {
    const root = $('#miniResume');
    if (!root) return;
    const hint = $('.mg-hint', root);
    let toastTimer = 0;

    const toast = (text) => {
      let el = $('.tk-toast', root);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tk-toast';
        el.setAttribute('role', 'status');
        root.appendChild(el);
      }
      el.innerHTML = `<svg aria-hidden="true"><use href="#i-toast"/></svg><span class="tk-toast-text">${esc(text)}</span>`;
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.remove(), 2600);
    };

    const closeConfirm = () => {
      const c = $('.mg-confirm', root);
      if (c) c.remove();
      if (hint) hint.hidden = false;
    };

    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-mini]');
      if (!act) return;
      const card = $('.tk-sess', root);
      if (act.dataset.mini === 'cancel') closeConfirm();
      if (act.dataset.mini === 'unbind') {
        closeConfirm();
        card.style.transition = 'opacity .25s ease';
        card.style.opacity = '0.25';
        toast(L('已解绑（会话文件未动）· 演示里 2 秒后复原', 'Unbound (session file untouched) · restores in 2s here'));
        setTimeout(() => {
          card.style.opacity = '';
          card.classList.add('is-new');
          setTimeout(() => card.classList.remove('is-new'), 1700);
        }, 2000);
      }
    });

    sliderController(root, {
      labels: () => ({ unbind: L('解绑', 'Unbind'), release: L('松手', 'Release') }),
      onTap: (card) => {
        closeConfirm();
        nudge(card);
        toast(L('已在 Claude Code 里打开这个会话', 'Opened this session in Claude Code'));
      },
      onUnbind: () => {
        // App 里松手后会先弹二次确认；这里用一行内联确认表达同一步
        closeConfirm();
        if (hint) hint.hidden = true;
        root.insertAdjacentHTML(
          'beforeend',
          `<div class="mg-confirm"><span>${L('解绑这个会话？', 'Unbind this session?')}</span><button type="button" class="tk-mini" data-mini="cancel">${L('取消', 'Cancel')}</button><button type="button" class="tk-mini danger" data-mini="unbind">${L('解绑', 'Unbind')}</button></div>`,
        );
      },
    });
    document.addEventListener('tick:lang', closeConfirm);
  }

  /** MCP 卡片：切换 pi / Claude Code / 通用 JSON 三种配置（与设置页给出的格式一致） */
  function setupMcp() {
    const code = $('#mcpCode');
    if (!code) return;
    const shim = '/Applications/Tick.app/Contents/Resources/mcp/tick-mcp.sh';
    const note = () =>
      `<span class="c-dim">${esc(
        L('# 设置 → Agent 连接（MCP）会给出本机的实际路径', '# Settings → Agent connection (MCP) shows the exact path on your Mac'),
      )}</span>\n`;
    const SNIP = {
      pi: () => `${note()}$ pi mcp add tick --exposure direct -- ${shim}`,
      claude: () => `${note()}$ claude mcp add --scope user tick -- ${shim}`,
      json: () => `${note()}${esc(JSON.stringify({ mcpServers: { tick: { command: shim, args: [] } } }, null, 2))}`,
    };
    const tabs = $$('[data-mcp]');
    let cur = 'pi';
    const paint = () => {
      code.innerHTML = SNIP[cur]();
      tabs.forEach((t) => {
        const on = t.dataset.mcp === cur;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => {
        cur = t.dataset.mcp;
        paint();
      });
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        cur = n.dataset.mcp;
        paint();
        n.focus();
      });
    });
    paint();
    document.addEventListener('tick:lang', paint);
  }

  /** 应用内更新卡片：按 App 的状态机轮播（检查 → 发现 → 下载 → 重启安装） */
  function setupUpdate() {
    const root = $('#miniUpdate');
    if (!root) return;
    const text = $('#updText', root);
    const btn = $('#updBtn', root);
    const bar = $('#updBar', root);
    const dots = $$('.upd-steps span', root);
    const STATES = [
      { t: ['当前版本', 'Current version'], s: ['自动检查已开启', 'Automatic checks are on'], b: ['检查更新', 'Check for updates'], stage: 0 },
      { t: ['正在检查更新…', 'Checking for updates…'], s: ['', ''], b: ['检查中…', 'Checking…'], dis: true, stage: 1 },
      { t: ['发现新版本', 'A new version is available'], s: ['确认后才下载', 'Downloads only after you confirm'], b: ['下载新版本', 'Download'], stage: 2 },
      { t: ['正在下载新版本', 'Downloading the new version'], s: null, b: null, dis: true, stage: 3, progress: true },
      { t: ['新版本已下载，重启后完成安装', 'Downloaded — restart to finish installing'], s: ['直接退出 Tick 也会安装', 'Quitting Tick also installs it'], b: ['重启并更新', 'Restart to update'], stage: 4 },
    ];
    let i = 0;
    let pct = 0;
    let timer = 0;
    let running = false;

    const paint = () => {
      const st = STATES[i];
      const sub = st.progress ? `${pct}%` : L(st.s);
      text.innerHTML = `${esc(L(st.t))}${sub ? `<small>${esc(sub)}</small>` : ''}`;
      btn.textContent = st.progress ? L(`下载中 ${pct}%`, `Downloading ${pct}%`) : L(st.b);
      btn.toggleAttribute('disabled', Boolean(st.dis));
      bar.style.width = `${st.stage >= 4 ? 100 : st.progress ? pct : 0}%`;
      dots.forEach((d, k) => d.classList.toggle('on', k < st.stage));
    };

    const tick = () => {
      if (!running) return;
      const st = STATES[i];
      if (st.progress && pct < 100) {
        pct = Math.min(100, pct + 9);
        paint();
        timer = setTimeout(tick, 170);
        return;
      }
      i = (i + 1) % STATES.length;
      pct = 0;
      paint();
      timer = setTimeout(tick, i === 0 ? 1500 : 1700);
    };

    i = reduced ? 2 : 0;
    paint();
    document.addEventListener('tick:lang', paint);
    if (reduced) return;
    whenVisible(
      root,
      () => {
        if (running) return;
        running = true;
        timer = setTimeout(tick, 1200);
      },
      () => {
        running = false;
        clearTimeout(timer);
      },
      0.4,
    );
  }

  // ======================================================================
  // 6. 首屏演示：迷你 macOS 桌面里的 Ticktodo 面板
  //    面板结构与交互按 App 还原：捕获行 → 线索列表 → 详情（会话卡片 + 右侧 1/8 方块滑块）
  //    → 新建会话（选工具 + 预填文案）。四步自动播放，用户一旦操作就停下让位。
  // ======================================================================
  function setupDemo() {
    const frame = $('#deskFrame');
    const desk = $('#desk');
    if (!frame || !desk) return;

    const panel = $('#demoPanel', desk);
    const view = $('#tkView', desk);
    const layer = $('#tkLayer', desk);
    const winTerm = $('#winTerm', desk);
    const cursor = $('#demoCursor', desk);
    const demo = $('#demo');

    let scale = 1;
    let wide = true;
    let step = 0;
    let playing = false;
    let token = 0;

    const ICON = {
      plus: '<svg aria-hidden="true"><use href="#i-plus"/></svg>',
      enter: '<svg aria-hidden="true"><use href="#i-enter"/></svg>',
      import: '<svg aria-hidden="true"><use href="#i-import"/></svg>',
      pin: '<svg aria-hidden="true"><use href="#i-pin"/></svg>',
      chat: '<svg aria-hidden="true"><use href="#i-chat"/></svg>',
      toast: '<svg aria-hidden="true" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="6.5" fill="#34C759"/><path d="M4 6.7L5.8 8.5L9 4.6" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      trash: '<svg aria-hidden="true"><use href="#i-trash"/></svg>',
    };
    const MARK = { pi: 'pi', claude: 'claude', workbuddy: 'workbuddy' };
    const toolIcon = (id) => `<svg class="ti" aria-hidden="true"><use href="#mark-${MARK[id] || 'pi'}"/></svg>`;
    const TOOL_NAME = { pi: 'pi', claude: 'Claude Code', workbuddy: 'WorkBuddy' };

    // ---- 数据（演示用） ----
    // 每条文案都是 [中文, English]：切换语言时重绘这块面板，而不是让示例内容保持中文
    const tr = (v) => (Array.isArray(v) ? v[lang === 'en' ? 1 : 0] : v);
    const state = {
      view: 'list',
      todos: [
        { id: 't1', title: ['给官网加一个可交互的功能演示', 'Make the site demo interactive'], time: ['昨天 22:14', 'Yest. 22:14'] },
        { id: 't2', title: ['把周报模板整理成脚本', 'Turn the weekly template into a script'], time: ['10月21日', 'Oct 21'] },
        { id: 't3', title: ['整理 pi 适配器里 cwd 解析的边界', 'Map the cwd edge cases in the pi adapter'], time: ['10月20日', 'Oct 20'] },
        { id: 't4', title: ['对比 Qoder 国内版与国际版会话格式', 'Compare Qoder CN and global session formats'], time: ['10月18日', 'Oct 18'] },
        { id: 't5', title: ['面板里的对话要不要支持多轮引用', 'Should panel chat support multi-turn quotes'], time: ['10月17日', 'Oct 17'] },
      ],
      active: 't1',
      body: [
        '下一步：把演示里的四步走通，再让首页和详情页共用同一套会话卡片。',
        'Next: walk the four steps, then share one session card between the list and the detail page.',
      ],
      sessions: [
        {
          id: 's1',
          tool: 'pi',
          title: ['官网要加一个可交互的演示：在面板里点一下就能接着做', 'Add an interactive demo to the site: continue in one click'],
          last: ['先做列表页，再补详情页的滑块', 'Start with the list, then the slider in the detail page'],
          time: ['昨天', 'Yest.'],
          cwd: '~/ticktodo',
          group: 'ticktodo',
        },
        {
          id: 's2',
          tool: 'claude',
          title: ['把滑块拖拽的命中判定再收紧一点，竖向手势不要接管', 'Tighten the drag threshold; do not capture vertical gestures'],
          time: ['2 天前', '2d'],
          cwd: '~/ticktodo',
          group: 'ticktodo',
        },
      ],
      newTool: 'pi',
      prompt: [
        '把官网首页演示里的滑块交互做出来：单击接着做，左拖到底解绑。',
        'Build the slider interaction for the site demo: click to continue, drag left to unbind.',
      ],
      direct: false,
    };

    // ---- 渲染 ----
    const brand = `<span class="tk-brand"><svg aria-hidden="true"><use href="#mark-tick"/></svg>Ticktodo</span>`;
    const rightIcons = `<div class="tk-top-r">
        <button type="button" class="tk-ico on" data-act="pin" aria-pressed="true" title="${esc(L('已置顶（演示）', 'Pinned (demo)'))}">${ICON.pin}</button>
        <button type="button" class="tk-ico" data-act="chat" title="${esc(L('对话（面板 Chat）', 'Chat in the panel'))}">${ICON.chat}</button>
        <button type="button" class="tk-menu" data-act="menu" title="${esc(L('菜单', 'Menu'))}">⋯</button>
      </div>`;

    const rowHTML = (t, extra = '') =>
      `<div class="tk-row${extra}" data-todo="${t.id}" tabindex="0" role="button" aria-label="${esc(tr(t.title))}">
        <span class="tk-check" data-act="archive" aria-hidden="true"><svg viewBox="0 0 9 9" fill="none"><path d="M1.5 4.8L3.6 7L7.5 2.2" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="tk-title">${esc(tr(t.title))}</span>
        <span class="tk-time">${esc(tr(t.time))}</span>
        <span class="tk-enter">${ICON.enter}</span>
      </div>`;

    function renderList(focus = false) {
      view.innerHTML = `<div class="tk-top">${brand}${rightIcons}</div>
        <div class="tk-capture" data-act="capture">
          <span class="tk-plus">＋</span>
          <input class="tk-cap-input" id="tkCap" type="text" maxlength="40" autocomplete="off" spellcheck="false" placeholder="${esc(L('想到什么，先丢下', 'Drop it before you forget'))}" ${focus ? '' : 'readonly'}>
        </div>
        <div class="tk-list">${state.todos.map((t) => rowHTML(t)).join('')}</div>`;
    }

    function renderDetail() {
      const todo = state.todos.find((t) => t.id === state.active) || state.todos[0];
      const groups = state.sessions.reduce((acc, s) => {
        (acc[s.group] = acc[s.group] || { name: s.group, cwd: s.cwd, list: [] }).list.push(s);
        return acc;
      }, {});
      view.innerHTML = `<div class="tk-top">
          <button type="button" class="tk-back" data-act="back" aria-label="${esc(L('返回线索', 'Back'))}">‹</button>
          <div class="tk-dmain"><span class="tk-dot" aria-hidden="true"></span><h3 class="tk-dtitle">${esc(tr(todo.title))}</h3></div>
        </div>
        <div class="tk-dcontent">
          <div class="tk-body">${esc(tr(state.body))}</div>
          <div class="tk-sec">
            <div class="tk-sec-head">
              <span class="tk-sec-title">${esc(L('会话', 'Sessions'))}<span class="tk-count">${state.sessions.length}</span></span>
              <div class="tk-sec-actions">
                <button type="button" class="tk-round" data-act="new" title="${esc(L('新建会话', 'New session'))}" aria-label="${esc(L('新建会话', 'New session'))}">${ICON.plus}</button>
                <button type="button" class="tk-round" data-act="import" title="${esc(L('倒入历史会话', 'Import past sessions'))}" aria-label="${esc(L('倒入历史会话', 'Import past sessions'))}">${ICON.import}</button>
              </div>
            </div>
            <div class="tk-groups">${Object.values(groups)
              .map(
                (g) => `<div class="tk-group">
                <div class="tk-ghead"><span class="n">${esc(g.name)}</span><span class="p">${esc(g.cwd)}</span></div>
                <div class="tk-sessions">${g.list
                  .map(
                    (s) => `<div class="tk-sess" data-session="${s.id}">
                    <div class="tk-sbody">
                      <div class="tk-stool" data-tool="${esc(TOOL_NAME[s.tool])}">${toolIcon(s.tool)}</div>
                      <div class="tk-smain">
                        <div class="tk-shead"><div class="tk-stitle">${esc(tr(s.title))}</div><span class="tk-stime">${esc(tr(s.time))}</span></div>
                        ${s.last ? `<div class="tk-slast"><i>${esc(L('上次', 'Last'))}</i>${esc(tr(s.last))}</div>` : ''}
                      </div>
                    </div>
                    <button type="button" class="tk-blk" data-act="resume" title="${esc(L('点击接着做 · 按住向左拖到底解绑', 'Click to continue · hold and drag left to unbind'))}" aria-label="${esc(L('接着做', 'Continue'))}"><span class="tk-grip"></span></button>
                  </div>`,
                  )
                  .join('')}</div>
              </div>`,
              )
              .join('')}</div>
          </div>
        </div>`;
    }

    function renderNew() {
      const tools = [
        { id: 'pi', hint: ['预填', 'Prefill'] },
        { id: 'claude', hint: ['预填', 'Prefill'] },
        { id: 'workbuddy', hint: ['新建页', 'New task page'] },
      ];
      const name = TOOL_NAME[state.newTool];
      view.innerHTML = `<div class="tk-top">
          <button type="button" class="tk-back" data-act="back" aria-label="${esc(L('返回', 'Back'))}">‹</button>
          <div class="tk-lhs"><span class="tk-ptitle">${esc(L('新建会话', 'New session'))}</span></div>
        </div>
        <div class="tk-ncontent">
          <div class="tk-field"><span class="tk-label">${esc(L('线索名', 'Todo'))}</span><span class="tk-ntitle">${esc(
            tr((state.todos.find((t) => t.id === state.active) || state.todos[0]).title),
          )}</span></div>
          <div class="tk-field"><span class="tk-label">${esc(L('发送给 AI 的内容（可直接改）', 'What to send (editable)'))}</span>
            <textarea class="tk-prompt" rows="3" spellcheck="false">${esc(tr(state.prompt))}</textarea>
          </div>
          <div class="tk-field"><span class="tk-label">${esc(L('项目', 'Project'))}</span>
            <div class="tk-proj"><span class="n">ticktodo</span><span class="p">~/ticktodo</span><span class="c">${esc(L('改', 'Change'))}</span></div>
          </div>
          <div class="tk-field"><span class="tk-label">${esc(L('用哪个工具', 'Which tool'))}</span>
            <div class="tk-tools">${tools
              .map(
                (t) => `<div class="tk-tool${t.id === state.newTool ? ' on' : ''}" data-tool="${t.id}" role="radio" aria-checked="${
                  t.id === state.newTool
                }" tabindex="0"><span class="ti">${toolIcon(t.id)}</span><span class="nm">${esc(TOOL_NAME[t.id])}</span><span class="tg">${esc(
                  L(t.hint),
                )}</span></div>`,
              )
              .join('')}</div>
          </div>
        </div>
        <div class="tk-nfoot">
          <div class="tk-frow">
            <button type="button" class="tk-go" data-act="go">${esc(L(`预填文案并打开 ${name}`, `Prefill and open ${name}`))}</button>
            <label class="tk-direct"><input type="checkbox" ${state.direct ? 'checked' : ''} data-act="direct"><span>${esc(
              L('直接发送', 'Send directly'),
            )}</span></label>
          </div>
          <div class="tk-nnote" id="tkNote">${esc(
            L('文案会预填到工具输入框，你确认后回车发送 —— 不自动发送', 'The prompt is prefilled; you press Enter to send — never auto-sent'),
          )}</div>
        </div>`;
    }

    function paint() {
      if (state.view === 'detail') renderDetail();
      else if (state.view === 'new') renderNew();
      else renderList(false);
    }

    // ---- Toast ----
    let toastTimer = 0;
    function toast(msg, undo) {
      let el = $('.tk-toast', panel);
      if (!el) {
        el = document.createElement('div');
        el.className = `tk-toast${state.view === 'list' ? '' : ' at-bottom'}`;
        el.setAttribute('role', 'status');
        panel.appendChild(el);
      }
      el.className = `tk-toast${state.view === 'list' ? '' : ' at-bottom'}`;
      el.innerHTML = `${ICON.toast}<span class="tk-toast-text">${esc(msg)}</span>${
        undo ? `<button type="button" class="tk-undo" data-act="undo">${esc(L('撤销', 'Undo'))}</button>` : ''
      }`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.remove(), 3200);
    }
    const clearToast = () => {
      clearTimeout(toastTimer);
      $$('.tk-toast', panel).forEach((n) => n.remove());
    };

    // ---- 终端窗口 ----
    function termResume() {
      if (!winTerm) return;
      desk.classList.add('has-win');
      winTerm.hidden = false;
      winTerm.classList.add('is-open');
      $('.win-title', winTerm).textContent = 'pi — ticktodo';
      $('.term-body', winTerm).innerHTML =
        `<span class="c-dim">$</span> pi <span class="c-dim">--session</span> ~/.pi/agent/sessions/-ticktodo/20261022_0931.jsonl\n` +
        `<span class="c-dim">▸</span> ${esc(L('已恢复会话', 'Session resumed'))}\n` +
        `<span class="c-dim">  cwd</span> <span class="c-path">~/ticktodo</span>\n` +
        `<span class="c-ok">✓</span> ${esc(L('上下文原样接上，接着上次的地方继续', 'Context intact — pick up where you left off'))}\n\n` +
        `<span class="c-hi">${esc(L('你', 'You'))}</span> <span class="c-dim">›</span> ${esc(
          tr(['先做列表页，再补详情页的滑块', 'Start with the list, then the slider']),
        )}<span class="caret"></span>`;
    }

    function termPrefill() {
      if (!winTerm) return;
      desk.classList.add('has-win');
      winTerm.hidden = false;
      winTerm.classList.add('is-open');
      $('.win-title', winTerm).textContent = 'pi — ticktodo';
      $('.term-body', winTerm).innerHTML =
        `<span class="c-dim">$</span> pi <span class="c-dim">--session-id</span> 4f1c…9a2\n` +
        `<span class="c-dim">▸</span> ${esc(L('新会话已开在', 'New session opened in'))} <span class="c-path">~/ticktodo</span>\n\n` +
        `<span class="term-input">${esc(tr(state.prompt))}<span class="caret"></span></span>\n` +
        `<span class="c-dim">${esc(L('文案已预填到输入框 · 按 Enter 发送（不会自动发送）', 'Prefilled — press Enter to send (never auto-sent)'))}</span>`;
    }

    // ---- 演示窗口（WorkBuddy 深链接） ----
    function appDeepLink() {
      if (!winTerm) return;
      desk.classList.add('has-win');
      winTerm.hidden = false;
      winTerm.classList.add('is-open');
      $('.win-title', winTerm).textContent = 'WorkBuddy';
      $('.term-body', winTerm).innerHTML =
        `<span class="c-dim">↗</span> workbuddy://task/new?prompt=…\n<span class="c-dim">${esc(
          L('已在 WorkBuddy 里打开新建任务页，文案已预填。', 'Opened the new-task page in WorkBuddy with the prompt prefilled.'),
        )}</span>\n<span class="c-dim">${esc(L('发送与绑定仍在应用里完成。', 'Sending and binding still happen in the app.'))}</span>`;
    }

    function closeWin() {
      if (winTerm) winTerm.classList.remove('is-open');
      desk.classList.remove('has-win');
    }

    // ---- 尺寸 ----
    function fit() {
      const w = frame.clientWidth;
      wide = w >= 600;
      const W = wide ? 700 : 392;
      const H = wide ? 580 : 600;
      desk.dataset.mode = wide ? 'wide' : 'compact';
      desk.style.width = `${W}px`;
      desk.style.height = `${H}px`;
      // 只缩不放：放大会让面板里的字号比页面正文还大，反而像放大镜
      scale = Math.min(1, w / W);
      desk.style.left = `${Math.max(0, (w - W * scale) / 2)}px`;
      desk.style.transform = `scale(${scale})`;
      frame.style.height = `${Math.round(H * scale)}px`;
      if (wide && winTerm) winTerm.style.left = '18px';
    }
    fit();
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(frame);
    else window.addEventListener('resize', fit);

    // ---- 光标 ----
    function moveCursorTo(el, offset) {
      if (!cursor || !el) return;
      const r = el.getBoundingClientRect();
      const d = desk.getBoundingClientRect();
      const x = (r.left - d.left) / scale + r.width / scale / 2 + (offset ? offset[0] : 0);
      const y = (r.top - d.top) / scale + r.height / scale / 2 + (offset ? offset[1] : 0);
      cursor.style.transition = reduced ? 'none' : '';
      cursor.style.transform = `translate(${x - 2}px, ${y - 1}px)`;
      cursor.classList.add('show');
    }
    const hideCursor = () => cursor && cursor.classList.remove('show');
    const cursorDown = () => cursor && cursor.classList.add('down');
    const cursorUp = () => {
      if (!cursor) return;
      cursor.classList.remove('down');
      const r = document.createElement('span');
      r.className = 'rip';
      cursor.appendChild(r);
      setTimeout(() => r.remove(), 520);
    };

    // ---- 交互（用户手动操作） ----
    // 用户自己操作面板：停下自动播放，但保留当前画面（不要当着他的面重置）
    panel.addEventListener('pointerdown', () => {
      if (playing) pause(false);
    });

    panel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      const row = e.target.closest('.tk-row');
      if (act && act.dataset.act === 'archive') {
        const tr = act.closest('.tk-row');
        if (tr && !tr.classList.contains('done')) {
          tr.classList.add('done');
          toast(L(`已归档「${tr.querySelector('.tk-title').textContent}」`, 'Archived'));
        }
        return;
      }
      if (act && act.dataset.act === 'undo') {
        $$('.tk-row.done', panel).forEach((r) => r.classList.remove('done'));
        clearToast();
        return;
      }
      if (act && act.dataset.act === 'pin') {
        act.classList.toggle('on');
        act.setAttribute('aria-pressed', String(act.classList.contains('on')));
        return;
      }
      if (act && act.dataset.act === 'back') {
        state.view = 'list';
        clearToast();
        closeWin();
        paint();
        return;
      }
      if (act && act.dataset.act === 'new') {
        state.view = 'new';
        clearToast();
        paint();
        return;
      }
      if (act && act.dataset.act === 'capture') {
        const input = $('#tkCap', panel);
        if (input) {
          input.readOnly = false;
          input.focus();
        }
        return;
      }
      if (act && act.dataset.act === 'resume') {
        // 单击由滑块控制器处理（它区分点击 / 拖拽）
        return;
      }
      if (act && act.dataset.act === 'go') {
        termPrefill();
        toast(L('文案已预填到 pi —— 确认后回车发送', 'Prefilled in pi — press Enter to send'));
        return;
      }
      const tool = e.target.closest('.tk-tool');
      if (tool && state.view === 'new') {
        state.newTool = tool.dataset.tool;
        paint();
        return;
      }
      if (act && act.dataset.act === 'direct') {
        state.direct = act.checked;
        const note = $('#tkNote', panel);
        if (note) {
          note.textContent = state.direct
            ? L('勾选后文案会作为启动消息直接发送 —— 本次生效', 'Checked: the prompt is sent right away — this launch only')
            : L('文案会预填到工具输入框，你确认后回车发送 —— 不自动发送', 'The prompt is prefilled; you press Enter — never auto-sent');
        }
        return;
      }
      if (row && state.view === 'list') {
        state.active = row.dataset.todo;
        state.view = 'detail';
        clearToast();
        paint();
      }
    });

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'tkCap') {
        const v = e.target.value.trim();
        if (v) {
          state.todos.unshift({ id: `n${Date.now()}`, title: v, time: ['刚刚', 'Just now'] });
          state.active = state.todos[0].id;
          clearToast();
          paint();
          const first = $('.tk-row', panel);
          if (first) first.classList.add('is-new');
          toast(L('已收下这条线索', 'Todo captured'));
        } else {
          e.target.readOnly = true;
        }
      }
    });

    // 线索行的键盘打开
    panel.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('tk-row')) {
        e.preventDefault();
        state.active = e.target.dataset.todo;
        state.view = 'detail';
        paint();
      }
    });

    // 滑块：单击接着做 / 左拖到底解绑
    sliderController(panel, {
      scale: () => scale,
      labels: () => ({ unbind: L('解绑', 'Unbind'), release: L('松手', 'Release') }),
      onTap: (card, block) => {
        if (!card) return;
        const s = state.sessions.find((x) => x.id === card.dataset.session);
        nudge(card);
        if (s && s.tool === 'workbuddy') appDeepLink();
        else termResume();
        toast(
          s && s.tool === 'workbuddy'
            ? L('已在 WorkBuddy 里打开这个会话', 'Opened this session in WorkBuddy')
            : L(`已在 ${s ? TOOL_NAME[s.tool] : 'pi'} 里打开这个会话`, `Opened this session in ${s ? TOOL_NAME[s.tool] : 'pi'}`),
        );
        if (block) block.blur();
      },
      onUnbind: (card) => {
        const s = state.sessions.find((x) => x.id === card.dataset.session);
        layer.innerHTML = `<div class="tk-backdrop"><div class="tk-sheet" role="dialog" aria-label="${esc(L('解绑这个会话？', 'Unbind this session?'))}">
          <div class="tk-sheet-head"><span class="tk-sheet-title">${esc(L('解绑这个会话？', 'Unbind this session?'))}</span>
            <button type="button" class="tk-x" data-sheet="close" aria-label="${esc(L('取消', 'Cancel'))}">✕</button></div>
          <div class="tk-note">${esc(L('只解除这条线索与该会话的绑定，不会删除 AI 工具里的会话文件。', 'Only removes the link to this todo; the session file in your AI tool is never deleted.'))}</div>
          <div class="tk-actions"><button type="button" class="secondary" data-sheet="close">${esc(L('取消', 'Cancel'))}</button>
          <button type="button" class="danger" data-sheet="unbind">${esc(L('解绑', 'Unbind'))}</button></div>
        </div></div>`;
        layer.dataset.target = card.dataset.session;
        const btn = $('[data-sheet="unbind"]', layer);
        if (btn) btn.dataset.session = card.dataset.session;
      },
    });

    layer.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sheet]');
      if (!b) {
        if (e.target === layer || e.target.classList.contains('tk-backdrop')) layer.innerHTML = '';
        return;
      }
      if (b.dataset.sheet === 'close') {
        layer.innerHTML = '';
        return;
      }
      const id = b.dataset.session;
      state.sessions = state.sessions.filter((s) => s.id !== id);
      layer.innerHTML = '';
      state.view = 'detail';
      paint();
      toast(L('已解绑（会话文件未动）', 'Unbound (session file untouched)'));
    });

    // ---- 自动播放 ----
    const sleep = (ms, id) => new Promise((res) => setTimeout(() => res(id === token), ms));
    const alive = (id) => id === token;

    async function runStep(n) {
      const id = ++token;
      step = n;
      playing = true;
      demo.classList.add('is-playing');
      $$('.demo-cap', demo).forEach((p) => {
        p.hidden = p.dataset.cap !== String(n);
      });
      $$('.demo-step', demo).forEach((b, i) => {
        b.setAttribute('aria-current', i === n ? 'step' : 'false');
        b.style.setProperty('--dur', `${DUR[n]}ms`);
      });
      setPlayIcon(true);
      hideCursor();
      closeWin();
      clearToast();
      layer.innerHTML = '';
      state.view = 'list';
      state.todos = state.todos.filter((t) => !t.id.startsWith('n'));
      paint();
      await sleep(420, id);
      if (!alive(id)) return;

      if (n === 0) {
        // 写下线索：点捕获行 → 逐字输入 → 回车
        const cap = $('.tk-capture', panel);
        moveCursorTo(cap, [-120, 0]);
        await sleep(700, id);
        if (!alive(id)) return;
        cursorDown();
        await sleep(140, id);
        cursorUp();
        if (!alive(id)) return;
        const input = $('#tkCap', panel);
        if (input) {
          input.readOnly = false;
          input.focus();
        }
        hideCursor();
        const text = L('把官网首页的演示做成可交互的', 'Make the site demo interactive');
        for (let i = 1; i <= text.length; i++) {
          if (!alive(id)) return;
          if (input) input.value = text.slice(0, i);
          await sleep(52, id);
        }
        await sleep(620, id);
        if (!alive(id)) return;
        state.todos.unshift({ id: `n${Date.now()}`, title: [L('把官网首页的演示做成可交互的', 'Make the site demo interactive'), 'Make the site demo interactive'], time: ['刚刚', 'Just now'] });
        state.active = state.todos[0].id;
        paint();
        const first = $('.tk-row', panel);
        if (first) first.classList.add('is-new');
        await sleep(1500, id);
      }

      if (n === 1) {
        // 打开线索：点行 → 详情页
        state.todos.unshift({ id: `n${Date.now()}`, title: ['把官网首页的演示做成可交互的', 'Make the site demo interactive'], time: ['刚刚', 'Just now'] });
        state.active = state.todos[0].id;
        paint();
        await sleep(300, id);
        if (!alive(id)) return;
        const row = $('.tk-row', panel);
        moveCursorTo(row, [30, 0]);
        await sleep(760, id);
        if (!alive(id)) return;
        cursorDown();
        await sleep(140, id);
        cursorUp();
        if (!alive(id)) return;
        hideCursor();
        state.view = 'detail';
        clearToast();
        paint();
        await sleep(DUR[1] - 1500, id);
      }

      if (n === 2) {
        // 接着做：打开详情 → 点方块滑块 → 终端恢复会话
        state.todos.unshift({ id: `n${Date.now()}`, title: ['把官网首页的演示做成可交互的', 'Make the site demo interactive'], time: ['刚刚', 'Just now'] });
        state.active = state.todos[0].id;
        state.view = 'detail';
        paint();
        await sleep(700, id);
        if (!alive(id)) return;
        const blk = $('.tk-blk', panel);
        moveCursorTo(blk, [0, 0]);
        await sleep(820, id);
        if (!alive(id)) return;
        cursorDown();
        await sleep(140, id);
        cursorUp();
        if (!alive(id)) return;
        hideCursor();
        const card = blk && blk.closest('.tk-sess');
        if (card) nudge(card);
        termResume();
        toast(L('已在 pi 里打开这个会话', 'Opened this session in pi'));
        await sleep(DUR[2] - 1700, id);
      }

      if (n === 3) {
        // 新建会话：＋ → 选工具 → 主按钮 → 终端里预填好文案
        state.todos.unshift({ id: `n${Date.now()}`, title: ['把官网首页的演示做成可交互的', 'Make the site demo interactive'], time: ['刚刚', 'Just now'] });
        state.active = state.todos[0].id;
        state.view = 'detail';
        paint();
        await sleep(600, id);
        if (!alive(id)) return;
        moveCursorTo($('[data-act="new"]', panel), [0, 0]);
        await sleep(700, id);
        if (!alive(id)) return;
        cursorDown();
        await sleep(130, id);
        cursorUp();
        if (!alive(id)) return;
        hideCursor();
        state.view = 'new';
        paint();
        await sleep(900, id);
        if (!alive(id)) return;
        moveCursorTo($('.tk-tool[data-tool="claude"]', panel), [-20, 0]);
        await sleep(700, id);
        if (!alive(id)) return;
        cursorDown();
        await sleep(130, id);
        cursorUp();
        if (!alive(id)) return;
        state.newTool = 'claude';
        paint();
        hideCursor();
        await sleep(700, id);
        if (!alive(id)) return;
        moveCursorTo($('[data-act="go"]', panel), [0, 0]);
        await sleep(760, id);
        if (!alive(id)) return;
        cursorDown();
        await sleep(130, id);
        cursorUp();
        if (!alive(id)) return;
        hideCursor();
        termPrefill();
        toast(L('文案已预填到 Claude Code —— 确认后回车发送', 'Prefilled in Claude Code — press Enter to send'));
        await sleep(DUR[3] - 2600, id);
      }

      if (!alive(id)) return;
      playing = false;
      demo.classList.remove('is-playing');
      setPlayIcon(false);
      if (!$('#demoAuto') || $('#demoAuto').checked) {
        await sleep(1400, id);
        if (alive(id)) runStep((n + 1) % 4);
      }
    }

    const DUR = [6200, 6000, 6200, 7200];

    function setPlayIcon(isPlaying) {
      const btn = $('.demo-play', demo);
      if (!btn) return;
      btn.innerHTML = isPlaying
        ? '<svg aria-hidden="true" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor"/><rect x="8.4" y="2" width="3" height="10" rx="1" fill="currentColor"/></svg>'
        : '<svg aria-hidden="true" viewBox="0 0 14 14"><path d="M4 2.4v9.2L11.6 7z" fill="currentColor"/></svg>';
      btn.setAttribute('aria-label', isPlaying ? L('暂停演示', 'Pause the demo') : L('播放演示', 'Play the demo'));
      btn.setAttribute('title', btn.getAttribute('aria-label'));
    }

    /**
     * 暂停自动播放。reset = true 时把面板恢复到干净状态（用于离开视口）：
     * 否则半截的打字、打开了一半的窗口会留在那里，用户不知道发生了什么。
     */
    function pause(reset) {
      token++;
      playing = false;
      demo.classList.remove('is-playing');
      setPlayIcon(false);
      $$('.demo-step', demo).forEach((b) => b.setAttribute('aria-current', 'false'));
      hideCursor();
      if (!reset) return;
      closeWin();
      clearToast();
      layer.innerHTML = '';
      state.view = 'list';
      state.todos = state.todos.filter((t) => !t.id.startsWith('n'));
      paint();
    }

    $$('.demo-step', demo).forEach((b, i) =>
      b.addEventListener('click', () => {
        pause(false);
        runStep(i);
      }),
    );
    const playBtn = $('.demo-play', demo);
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (playing) pause(false);
        else runStep(step);
      });
    }
    whenVisible(
      demo,
      () => {
        if (!reduced && !playing && !demo.dataset.done) {
          demo.dataset.done = '1';
          runStep(0);
        }
      },
      () => {
        if (playing) pause(true);
      },
      0.35,
    );

    // 语言切换：停在当前步的静态首帧，避免中英混排
    document.addEventListener('tick:lang', () => pause(true));

    paint();
    setPlayIcon(false);
  }

  // ======================================================================
  // 7. 启动
  // ======================================================================
  initLang();
  setupDownload();
  setupCopy();
  setupNav();
  setupTools();
  setupBeforeAfter();
  setupMiniResume();
  setupMcp();
  setupUpdate();
  setupDemo();
  setupReveal();
})();
