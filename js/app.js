// ============================================================
// 应用骨架：路由 / 导航 / Toast / 弹窗 / 确认框
// ============================================================
const App = {
  pages: {},        // { home: {title, render}, ... }
  cache: { categories: [], items: [], subitems: [] }, // 含已停用的全量缓存（用于名称显示）
  _toastTimer: null,

  async init() {
    const mode = await Store.init();

    // 模式徽标 + 连接错误提示
    const badge = document.getElementById("mode-badge");
    if (mode === "supabase") {
      badge.textContent = "☁ 云端";
      badge.className = "badge badge-cloud";
    } else {
      badge.textContent = "🔖 本地模式";
      badge.className = "badge badge-local";
      document.getElementById("local-mode-tip").style.display = "";
    }
    if (Store.connError) {
      this.toast("Supabase 连接失败：" + Store.connError + "（已临时使用本地模式，数据仅存浏览器）", "error", 6000);
    }

    // 初始分类缓存
    await this.refreshMeta();

    // 路由
    window.addEventListener("hashchange", () => this.route());
    if (!location.hash) location.hash = "#/home";
    this.route();
  },

  /** 刷新分类缓存（含已停用，用于历史记录名称显示） */
  async refreshMeta(includeInactive = true) {
    this.cache.categories = await Store.getCategories(includeInactive);
    this.cache.items = await Store.getItems(includeInactive);
    try {
      this.cache.subitems = await Store.getSubitems(includeInactive);
    } catch (e) {
      // 兼容旧库（无 sub_items 表）：小项功能静默降级
      this.cache.subitems = [];
    }
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
    // 每次进入页面重新渲染（保证数据最新）
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
  /** 打开一个弹窗，返回弹窗元素；close 时自动移除 */
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

  /** 确认框：返回 Promise<boolean> */
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

  /** 单字段输入弹窗：返回 Promise<string|null> */
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

  /** 通用错误处理 */
  fail(e, prefix = "操作失败") {
    console.error(e);
    this.toast(prefix + "：" + (e.message || e), "error", 4000);
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
