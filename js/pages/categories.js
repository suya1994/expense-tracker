// ============================================================
// 分类管理页：两级结构（大类 → 具体项目）
// 新增/改名/移动/删除（删除时自动转移名下消费记录，历史数据不丢）
// ============================================================
(() => {
  const state = {
    selectedCat: null,
  };

  const page = () => document.getElementById("page-cats");

  function bindOnce() {
    const p = page();
    if (p.dataset.bound) return;
    p.dataset.bound = "1";

    p.querySelector("#cat-add").addEventListener("click", addCategory);
    p.querySelector("#cat-list").addEventListener("click", e => {
      const btn = e.target.closest("button[data-act]");
      const row = e.target.closest(".cat-row");
      if (!row) return;
      const id = row.dataset.id;
      if (btn) {
        const act = btn.dataset.act;
        if (act === "rename") renameCategory(id);
        if (act === "del") deleteCategory(id);
        return;
      }
      state.selectedCat = id;
      render();
    });
    p.querySelector("#item-add").addEventListener("click", addItem);
    p.querySelector("#cat-items").addEventListener("click", e => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "rename") renameItem(id);
      if (act === "move") moveItem(id);
      if (act === "del") deleteItem(id);
      if (act === "sub-add") addSubitem(id);
      if (act === "sub-del") deleteSubitem(id);
    });
  }

  // ---------------- 大类操作 ----------------
  async function addCategory() {
    const name = await App.prompt("新增大类", "大类名称", "", "例如：餐饮 / 宠物 / 交通");
    if (!name) return;
    if (name.length > 20) { App.toast("名称过长", "error"); return; }
    try {
      const row = await Store.addCategory(name);
      await App.refreshMeta();
      state.selectedCat = row.id;
      App.toast(`已添加大类「${name}」✓`);
      render();
    } catch (e) { App.fail(e, "添加失败"); }
  }

  async function renameCategory(id) {
    const cat = App.cache.categories.find(c => c.id === id);
    const name = await App.prompt("修改大类名称", "大类名称", cat.name);
    if (!name || name === cat.name) return;
    try {
      await Store.updateCategory(id, { name });
      await App.refreshMeta();
      App.toast("已改名 ✓（历史记录将显示新名称）");
      render();
    } catch (e) { App.fail(e, "改名失败"); }
  }

  /**
   * 删除大类：
   * - 无消费记录 → 确认后直接删除（含旗下项目）
   * - 有消费记录 → 弹窗选择转移目标大类，转移后删除
   */
  async function deleteCategory(id) {
    const cat = App.cache.categories.find(c => c.id === id);
    if (!cat) return;
    const itemCount = App.cache.items.filter(i => i.category_id === id).length;

    let exps = [];
    try {
      exps = await Store.getExpenses({ categoryId: id });
    } catch (e) { App.fail(e, "查询记录失败"); return; }

    if (!exps.length) {
      const ok = await App.confirm(
        `确定删除大类「${cat.name}」吗？\n\n该大类下没有消费记录，将同时删除其下的 ${itemCount} 个具体项目。删除后不可恢复。`,
        { danger: true, okText: "删除" });
      if (!ok) return;
      try {
        const { moved } = await Store.deleteCategoryWithTransfer(id, null);
        await App.refreshMeta();
        App.toast(`已删除「${cat.name}」✓`);
        state.selectedCat = null;
        render();
      } catch (e) { App.fail(e, "删除失败"); }
      return;
    }

    // 有数据：选择转移目标
    const targets = App.cache.categories.filter(c => c.id !== id);
    if (!targets.length) {
      App.toast("至少需要保留一个大类，无法删除", "error");
      return;
    }
    const wrap = App.openModal("删除大类并转移数据", `
      <div class="form">
        <p class="confirm-msg">「${escapeHtml(cat.name)}」下有 <b>${exps.length}</b> 笔消费记录，删除前需转移到其他大类：</p>
        <div class="field-row"><label>转移至</label>
          <select id="del-target">${targets.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>
        </div>
        <p class="tips">转移后记录将归入所选大类；原项目若有同名项目则沿用其名称，否则归入该大类的「其他」项目。</p>
      </div>`,
      `<button class="btn btn-ghost" id="del-cancel">取消</button>
       <button class="btn btn-danger" id="del-ok">转移并删除</button>`);
    wrap.querySelector("#del-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector("#del-ok").addEventListener("click", async () => {
      const target = wrap.querySelector("#del-target").value;
      try {
        await Store.deleteCategoryWithTransfer(id, target);
        await App.refreshMeta();
        wrap.close();
        App.toast(`已删除「${cat.name}」，${exps.length} 笔记录已转移 ✓`);
        state.selectedCat = null;
        render();
      } catch (e) { App.fail(e, "删除失败"); }
    });
  }

  // ---------------- 项目操作 ----------------
  async function addItem() {
    if (!state.selectedCat) { App.toast("请先在左侧选择一个大类", "error"); return; }
    const name = await App.prompt("新增具体项目", "项目名称", "", "例如：猫粮 / 猫砂 / 打车");
    if (!name) return;
    if (name.length > 30) { App.toast("名称过长", "error"); return; }
    try {
      await Store.addItem(state.selectedCat, name);
      await App.refreshMeta();
      App.toast("已添加项目 ✓");
      render();
    } catch (e) { App.fail(e, "添加失败"); }
  }

  async function renameItem(id) {
    const item = App.cache.items.find(i => i.id === id);
    const name = await App.prompt("修改项目名称", "项目名称", item.name);
    if (!name || name === item.name) return;
    try {
      await Store.updateItem(id, { name });
      await App.refreshMeta();
      App.toast("已改名 ✓（历史记录将显示新名称）");
      render();
    } catch (e) { App.fail(e, "改名失败"); }
  }

  async function moveItem(id) {
    const item = App.cache.items.find(i => i.id === id);
    const cats = App.cache.categories.filter(c => c.is_active && c.id !== item.category_id);
    if (!cats.length) { App.toast("没有其他可选大类", "error"); return; }

    const wrap = App.openModal("移动项目", `
      <div class="form">
        <p class="confirm-msg">将「${escapeHtml(item.name)}」移动到：</p>
        <div class="field-row"><label>目标大类</label>
          <select id="move-target">${cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>
        </div>
      </div>`,
      `<button class="btn btn-ghost" id="move-cancel">取消</button>
       <button class="btn btn-primary" id="move-ok">移动</button>`);
    wrap.querySelector("#move-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector("#move-ok").addEventListener("click", async () => {
      const target = wrap.querySelector("#move-target").value;
      try {
        await Store.updateItem(id, { category_id: target });
        await App.refreshMeta();
        wrap.close();
        App.toast("已移动 ✓（历史记录归属同时更新）");
        render();
      } catch (e) { App.fail(e, "移动失败"); }
    });
  }

  /**
   * 删除具体项目：
   * - 无消费记录 → 确认后直接删除
   * - 有消费记录 → 弹窗选择同大类转移目标项目，转移后删除
   */
  async function deleteItem(id) {
    const item = App.cache.items.find(i => i.id === id);
    if (!item) return;

    let exps = [];
    try {
      exps = await Store.getExpenses({ itemId: id });
    } catch (e) { App.fail(e, "查询记录失败"); return; }

    if (!exps.length) {
      const ok = await App.confirm(
        `确定删除项目「${item.name}」吗？\n\n删除后不可恢复。`,
        { danger: true, okText: "删除" });
      if (!ok) return;
      try {
        await Store.deleteItemWithTransfer(id, null);
        await App.refreshMeta();
        App.toast(`已删除「${item.name}」✓`);
        render();
      } catch (e) { App.fail(e, "删除失败"); }
      return;
    }

    // 有数据：选择同大类的转移目标
    const siblings = App.cache.items.filter(i => i.category_id === item.category_id && i.id !== id);
    const wrap = App.openModal("删除项目并转移数据", `
      <div class="form">
        <p class="confirm-msg">「${escapeHtml(item.name)}」下有 <b>${exps.length}</b> 笔消费记录，删除前需转移到其他项目：</p>
        <div class="field-row"><label>转移至</label>
          <select id="del-item-target">
            ${siblings.length ? siblings.map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join("") : `<option value="">自动归入新「其他」项目</option>`}
          </select>
        </div>
        <p class="tips">${siblings.length ? "转移后这些记录将显示为所选项目。" : "该大类下没有其他项目，删除后将自动新建「其他」项目承接这些记录。"}</p>
      </div>`,
      `<button class="btn btn-ghost" id="del-item-cancel">取消</button>
       <button class="btn btn-danger" id="del-item-ok">转移并删除</button>`);
    wrap.querySelector("#del-item-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector("#del-item-ok").addEventListener("click", async () => {
      const target = wrap.querySelector("#del-item-target").value || null;
      try {
        await Store.deleteItemWithTransfer(id, target);
        await App.refreshMeta();
        wrap.close();
        App.toast(`已删除「${item.name}」，${exps.length} 笔记录已转移 ✓`);
        render();
      } catch (e) { App.fail(e, "删除失败"); }
    });
  }

  // ---------------- 小项操作（第三级）----------------
  async function addSubitem(itemId) {
    const item = App.cache.items.find(i => i.id === itemId);
    if (!item) return;
    const name = await App.prompt(`给「${item.name}」添加小项`, "小项名称", "", "例如：早餐 / 加班餐（选填层级，可不加）");
    if (!name) return;
    if (name.length > 30) { App.toast("名称过长", "error"); return; }
    try {
      await Store.addSubitem(itemId, name);
      await App.refreshMeta();
      App.toast(`已添加小项「${name}」✓`);
      render();
    } catch (e) { App.fail(e, "添加失败"); }
  }

  async function deleteSubitem(id) {
    const sub = App.cache.subitems.find(s => s.id === id);
    if (!sub) return;
    const item = App.cache.items.find(i => i.id === sub.item_id);
    // 查归属记录数（只查该项目下即可）
    let count = 0;
    try {
      const exps = await Store.getExpenses({ itemId: sub.item_id });
      count = exps.filter(r => r.subitem_id === id).length;
    } catch (e) { App.fail(e, "查询记录失败"); return; }

    const ok = await App.confirm(
      `确定删除小项「${sub.name}」吗？\n\n${count ? `有 ${count} 笔记录归属该小项，删除后这些记录将不再归属任何小项（记录本身不删除）。` : "该小项下没有消费记录。"}删除后不可恢复。`,
      { danger: true, okText: "删除" });
    if (!ok) return;
    try {
      await Store.deleteSubitem(id);
      await App.refreshMeta();
      App.toast(`已删除小项「${sub.name}」✓${count ? `（${count} 笔记录已取消归属）` : ""}`);
      render();
    } catch (e) { App.fail(e, "删除失败"); }
  }

  // ---------------- 渲染 ----------------
  function render() {
    bindOnce();
    const p = page();
    const cats = App.cache.categories;
    const items = App.cache.items;

    if (state.selectedCat && !App.cache.categories.some(c => c.id === state.selectedCat)) {
      state.selectedCat = null;
    }
    if (!state.selectedCat && cats.length) state.selectedCat = cats[0].id;

    // 左侧大类列表
    p.querySelector("#cat-list").innerHTML = cats.length ? cats.map(c => {
      const itemCount = items.filter(i => i.category_id === c.id).length;
      return `
        <div class="cat-row ${c.id === state.selectedCat ? "cat-row-active" : ""}" data-id="${c.id}">
          <div class="cat-row-main">
            <span class="cat-row-name">${escapeHtml(c.name)}</span>
            <span class="cat-row-meta">${itemCount} 个项目</span>
          </div>
          <div class="cat-row-ops">
            <button class="link-btn" data-act="rename">改名</button>
            <button class="link-btn link-danger" data-act="del">删除</button>
          </div>
        </div>`;
    }).join("") : `<div class="empty">还没有大类，点上方「新增大类」开始</div>`;

    // 右侧项目列表
    const right = p.querySelector("#cat-items");
    const cat = App.cache.categories.find(c => c.id === state.selectedCat);
    if (!cat) {
      right.innerHTML = `<div class="empty">先在左侧选择或新增一个大类</div>`;
      p.querySelector("#item-add").disabled = true;
    } else {
      p.querySelector("#item-add").disabled = false;
      const catItems = items.filter(i => i.category_id === cat.id);
      right.innerHTML = `
        <div class="item-head">
          <b>${escapeHtml(cat.name)}</b> 下的具体项目（${catItems.length}）
        </div>
        ${catItems.length ? catItems.map(i => {
          const subs = App.cache.subitems.filter(s => s.item_id === i.id);
          return `
          <div class="item-manage-block">
            <div class="item-manage-row">
              <span class="cat-row-name">${escapeHtml(i.name)}</span>
              <div class="cat-row-ops">
                <button class="link-btn" data-act="rename" data-id="${i.id}">改名</button>
                <button class="link-btn" data-act="move" data-id="${i.id}">移动</button>
                <button class="link-btn link-danger" data-act="del" data-id="${i.id}">删除</button>
              </div>
            </div>
            <div class="sub-manage">
              ${subs.map(s => `
                <span class="sub-tag">
                  ${escapeHtml(s.name)}
                  <button class="sub-tag-del" data-act="sub-del" data-id="${s.id}" title="删除小项">✕</button>
                </span>`).join("")}
              <button class="link-btn sub-add-btn" data-act="sub-add" data-id="${i.id}">＋ 小项</button>
            </div>
          </div>`;
        }).join("") : `<div class="empty">该大类下还没有项目</div>`}`;
    }
  }

  App.registerPage("cats", { title: "分类", render });
})();
