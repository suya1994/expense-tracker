// ============================================================
// 应用骨架：路由 / 导航 / Toast / 弹窗 / 确认框
// ============================================================
const App = {
  pages: {},
  cache: { categories: [], items: [], subitems: [] },
  _toastTimer: null,

  async init() {
    await Store.init();

    // 连接错误：显示错误提示并停止初始化
    if (Store.connError) {
      document.getElementById("app-loading").innerHTML =
        `<div class="loading-error">
          <div class="loading-error-icon">⚠</div>
          <div class="loading-error-msg">Supabase 连接失败</div>
          <div class="loading-error-detail">${escapeHtml(Store.connError)}</div>
          <div class="loading-error-hint">请检查 <code>js/config.js</code> 中的 supabaseUrl 和 supabaseKey</div>
        </div>`;
      return;
    }

    // 隐藏全局 loading
    const overlay = document.getElementById("app-loading");
    if (overlay) overlay.remove();

    // 加载分类缓存
    await this.refreshMeta();

    // 路由
    window.addEventListener("hashchange", () => this.route());
    if (!location.hash) location.hash = "#/home";
    this.route();
  },

  async refreshMeta(includeInactive = true) {
    const [cats, items, subs] = await Promise.all([
      Store.getCategories(includeInactive),
      Store.getItems(includeInactive),
      Store.getSubitems(includeInactive).catch(() => []),
    ]);
    this.cache.categories = cats;
    this.cache.items = items;
    this.cache.subitems = subs;
  },
  catName(id) {
    const c = this.cache.categories.find(c => c.id === id);
    return c ? c.name : "（已删除分类）";
  },
  itemName(id) {
    const i = this.cache.items.find(i => i.id === id);
    return i ? i.name : "（已删除项目）";
  },
  subName(id) {
    if (!id) return "";
    const s = this.cache.subitems.find(s => s.id === id);
    return s ? s.name : "（已删除小项）";
  },

  registerPage(key, page) { this.pages[key] = page; },

  route() {
    const key = (location.hash.replace(/^#\//, "") || "home").split("?")[0];
    const page = this.pages[key] || this.pages.home;
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    const el = document.getElementById("page-" + key) || document.getElementById("page-home");
    el.classList.add("active");
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === key));
    document.title = "记账本 · " + page.title;
    Promise.resolve(page.render(el)).catch(e => {
      console.error(e);
      this.toast("加载失败：" + (e.message || e), "error");
    });
  },

  // ---------------- Toast ----------------
  toast(msg, type = "success", duration = 2600) {
    let t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast show " + type;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.className = "toast"; }, duration);
  },

  // ---------------- 弹窗 ----------------
  openModal(title, bodyHTML, footHTML = "") {
    const root = document.getElementById("modal-root");
    const wrap = document.createElement("div");
    wrap.className = "modal-mask";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn modal-close" aria-label="关闭">✕</button></div>
        <div class="modal-body">${bodyHTML}</div>
        ${footHTML ? `<div class="modal-foot">${footHTML}</div>` : ""}
      </div>`;
    root.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector(".modal-close").addEventListener("click", close);
    wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
    wrap.close = close;
    return wrap;
  },

  confirm(message, { danger = false, okText = "确认", cancelText = "取消" } = {}) {
    return new Promise(resolve => {
      const wrap = this.openModal("请确认", `
        <p class="confirm-msg">${escapeHtml(message)}</p>`,
        `<button class="btn btn-ghost confirm-cancel">${escapeHtml(cancelText)}</button>
         <button class="btn ${danger ? "btn-danger" : "btn-primary"} confirm-ok">${escapeHtml(okText)}</button>`);
      wrap.querySelector(".confirm-ok").addEventListener("click", () => { wrap.close(); resolve(true); });
      wrap.querySelector(".confirm-cancel").addEventListener("click", () => { wrap.close(); resolve(false); });
    });
  },

  prompt(title, label, value = "", placeholder = "") {
    return new Promise(resolve => {
      const wrap = this.openModal(title, `
        <div class="field-row">
          <label>${escapeHtml(label)}</label>
          <input type="text" class="prompt-input" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
        </div>`,
        `<button class="btn btn-ghost prompt-cancel">取消</button>
         <button class="btn btn-primary prompt-ok">确定</button>`);
      const input = wrap.querySelector(".prompt-input");
      input.focus(); input.select();
      const ok = () => { wrap.close(); resolve(input.value.trim()); };
      wrap.querySelector(".prompt-ok").addEventListener("click", ok);
      wrap.querySelector(".prompt-cancel").addEventListener("click", () => { wrap.close(); resolve(null); });
      input.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    });
  },

  fail(e, prefix = "操作失败") {
    console.error(e);
    this.toast(prefix + "：" + (e.message || e), "error", 4000);
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
