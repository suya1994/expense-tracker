// ============================================================
// 首页：记一笔（第一视觉）+ 今日/本月概览
// 保存后：清空金额和备注，保留分类选择，光标回到金额框，可连续记账
// ============================================================
(() => {
  const state = {
    categories: [],   // 激活的大类
    items: [],        // 激活的项目
    subitems: [],     // 激活的小项
    selectedCat: null,
    selectedItem: null,
    selectedSub: null,
  };

  const $ = sel => document.querySelector(sel);
  const page = () => document.getElementById("page-home");

  function bindOnce() {
    const p = page();
    if (p.dataset.bound) return;
    p.dataset.bound = "1";

    p.querySelector("#entry-save").addEventListener("click", save);
    p.querySelector("#entry-amount").addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    p.querySelector("#entry-note").addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    // 右上角预算入口
    p.querySelector("#budget-entry-btn").addEventListener("click", () => { location.hash = "#/budget"; });
    // 大类选中后联动项目
    p.querySelector("#entry-categories").addEventListener("click", e => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      selectCategory(btn.dataset.id);
    });
    p.querySelector("#entry-items").addEventListener("click", e => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.selectedItem = btn.dataset.id;
      state.selectedSub = null; // 切换项目后重置小项
      renderItems();
      renderSubs();
    });
    // 小项选中/取消（再点同一个取消，允许不选）
    p.querySelector("#entry-subs").addEventListener("click", e => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.selectedSub = state.selectedSub === btn.dataset.id ? null : btn.dataset.id;
      renderSubs();
    });
  }

  function selectCategory(id) {
    state.selectedCat = id;
    state.selectedItem = null;
    state.selectedSub = null;
    renderCategories();
    renderItems();
    renderSubs();
  }

  function renderCategories() {
    const box = page().querySelector("#entry-categories");
    if (!state.categories.length) {
      box.innerHTML = `<span class="empty-hint">还没有分类，请先到「分类」页添加大类和项目</span>`;
      return;
    }
    box.innerHTML = state.categories.map(c =>
      `<button type="button" class="chip ${c.id === state.selectedCat ? "chip-active" : ""}" data-id="${c.id}">${escapeHtml(c.name)}</button>`
    ).join("");
  }

  function renderItems() {
    const box = page().querySelector("#entry-items");
    const cat = state.selectedCat;
    if (!cat) { box.innerHTML = `<span class="empty-hint">先选择大类</span>`; return; }
    const items = state.items.filter(i => i.category_id === cat);
    if (!items.length) {
      box.innerHTML = `<span class="empty-hint">该大类下还没有项目，可到「分类」页添加</span>`;
      return;
    }
    box.innerHTML = items.map(i =>
      `<button type="button" class="chip ${i.id === state.selectedItem ? "chip-active" : ""}" data-id="${i.id}">${escapeHtml(i.name)}</button>`
    ).join("");
  }

  /** 小项 chips：仅当所选项目配置了小项时显示；再点同一小项可取消选择 */
  function renderSubs() {
    const block = page().querySelector("#entry-sub-block");
    const box = page().querySelector("#entry-subs");
    const subs = state.selectedItem
      ? state.subitems.filter(s => s.item_id === state.selectedItem)
      : [];
    if (!subs.length) { block.style.display = "none"; return; }
    block.style.display = "";
    box.innerHTML = subs.map(s =>
      `<button type="button" class="chip ${s.id === state.selectedSub ? "chip-active" : ""}" data-id="${s.id}">${escapeHtml(s.name)}</button>`
    ).join("");
  }

  async function save() {
    const p = page();
    const amountEl = p.querySelector("#entry-amount");
    const dateEl = p.querySelector("#entry-date");
    const noteEl = p.querySelector("#entry-note");

    const cents = parseAmountToCents(amountEl.value);
    if (cents === null) { App.toast("请输入正确金额，例如 268 或 268.50", "error"); amountEl.focus(); return; }
    if (!dateEl.value) { App.toast("请选择日期", "error"); return; }
    if (!state.selectedCat) { App.toast("请选择大类", "error"); return; }
    if (!state.selectedItem) { App.toast("请选择具体项目", "error"); return; }

    try {
      await Store.addExpense({
        amount_cents: cents,
        expense_date: dateEl.value,
        category_id: state.selectedCat,
        item_id: state.selectedItem,
        subitem_id: state.selectedSub || null,
        note: noteEl.value.trim(),
      });
      // 清空金额和备注；保留分类，继续记下一笔
      amountEl.value = "";
      noteEl.value = "";
      amountEl.focus();
      // 超支提醒：该大类该月已设预算且累计超支 → 用警示 toast（不拦截、不打断连续记账）
      const warn = await overspendMsg(state.selectedCat, dateEl.value);
      if (warn) App.toast(warn, "error", 4200);
      else App.toast("已保存 ✓ 可继续记下一笔");
      renderOverview();
    } catch (e) {
      App.fail(e, "保存失败");
    }
  }

  /** 记账后检查：该大类该月是否超预算；返回提示文案或 null（检查失败静默跳过，不影响记账） */
  async function overspendMsg(catId, dateStr) {
    try {
      const { y, m } = ymOf(dateStr);
      const budgets = await Budget.safeGet(y);
      const b = budgets.find(x => x.category_id === catId && x.month === m);
      if (!b || b.amount_cents === null) return null;
      const [from, to] = monthRange(y, m);
      const recs = await Store.getExpenses({ from, to, categoryId: catId });
      const spent = recs.reduce((s, r) => s + r.amount_cents, 0);
      if (spent > b.amount_cents) {
        return `已保存 ✓ ${App.catName(catId)}本月已超预算：${fmtYuan(spent)} / ${fmtYuan(b.amount_cents)}（超 ${fmtYuan(spent - b.amount_cents)}）`;
      }
    } catch (e) { /* 预算检查失败不影响记账 */ }
    return null;
  }

  // ---------------- 概览 ----------------
  async function renderOverview() {
    const box = page().querySelector("#home-overview");
    box.innerHTML = `<div class="card loading-card">加载中…</div>`;
    try {
      const today = todayStr();
      const { y, m } = ymOf(today);
      const [mFrom, mTo] = monthRange(y, m);

      const [todayRecords, monthRecords, budgets] = await Promise.all([
        Store.getExpenses({ from: today, to: today }),
        Store.getExpenses({ from: mFrom, to: mTo }),
        Budget.safeGet(y),
      ]);

      const t = sumRecords(todayRecords);
      const bs = Budget.monthStatus(budgets, m, monthRecords);

      // 本月按大类汇总（含已停用大类，保证统计完整）
      const byCat = groupSum(monthRecords, r => r.category_id);
      const catRows = [...byCat.entries()]
        .map(([id, g]) => ({ id, name: App.catName(id), total: g.total, count: g.count }))
        .sort((a, b) => b.total - a.total);
      const catMax = catRows.length ? catRows[0].total : 1;

      // 预算角标：按 catId 索引 bs.rows
      const budMap = new Map(bs.rows.map(r => [r.catId, r]));
      const unsetMap = new Map(bs.unsetRows.map(r => [r.catId, r]));

      // 今日明细表
      const todayTableHTML = todayRecords.length ? `
        <div class="card" id="home-today-detail">
          <h3 class="card-title">今日消费明细 <em class="muted" style="font-size:14px;font-weight:400">${fmtYuan(t.total)}</em></h3>
          <table class="table">
            <thead><tr><th>大类</th><th>项目</th><th class="ta-r">金额</th><th>备注</th><th class="ta-c">操作</th></tr></thead>
            <tbody>
              ${todayRecords.map(r => `
                <tr>
                  <td>${escapeHtml(App.catName(r.category_id))}</td>
                  <td>${escapeHtml(App.itemName(r.item_id))}${r.subitem_id ? ` <em class="td-sub">${escapeHtml(App.subName(r.subitem_id))}</em>` : ""}</td>
                  <td class="td-amount">${fmtYuan(r.amount_cents)}</td>
                  <td class="td-note">${escapeHtml(r.note || "—")}</td>
                  <td class="ta-c td-ops">
                    <button class="link-btn" data-home-edit="${r.id}">编辑</button>
                    <button class="link-btn link-danger" data-home-del="${r.id}">删除</button>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : "";

      box.innerHTML = `
        ${todayTableHTML}
        <div class="card">
          <h3 class="card-title">本月分类概览</h3>
          ${catRows.length ? `
            <ul class="ov-cat-list">
              ${catRows.map(c => {
                let badge = "";
                const br = budMap.get(c.id);
                if (br) {
                  if (br.status === "over") badge = `<span class="bud-badge bud-badge-over">超 ${fmtYuan(br.overAmt)}</span>`;
                  else if (br.status === "near") badge = `<span class="bud-badge bud-badge-near">${Math.round(br.spent / br.budget * 100)}%</span>`;
                  else badge = `<span class="bud-badge" style="background:var(--accent-weak);color:var(--accent)">剩 ${fmtYuan(br.budget - br.spent)}</span>`;
                } else if (unsetMap.has(c.id)) {
                  badge = `<span class="bud-badge bud-badge-unset">未设</span>`;
                }
                return `
                <li>
                  <span class="ov-cat-name">${escapeHtml(c.name)} <em>${c.count}笔</em></span>
                  <span class="ov-cat-bar"><i style="width:${Math.max(2, (c.total / catMax) * 100).toFixed(1)}%"></i></span>
                  ${badge}
                  <span class="ov-cat-amount">${fmtYuan(c.total)}</span>
                </li>`;
              }).join("")}
            </ul>` : `<div class="empty">本月还没有记录，记一笔吧 ☝️</div>`}
        </div>`;

      // 今日明细表事件委托：编辑/删除
      const todayCard = box.querySelector("#home-today-detail");
      if (todayCard) {
        todayCard.addEventListener("click", e => {
          const editBtn = e.target.closest("[data-home-edit]");
          if (editBtn) { openTodayEdit(editBtn.dataset.homeEdit, todayRecords); return; }
          const delBtn = e.target.closest("[data-home-del]");
          if (delBtn) { delTodayRecord(delBtn.dataset.homeDel); return; }
        });
      }
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="empty">概览加载失败：${escapeHtml(e.message || String(e))}</div></div>`;
    }
  }

  /** 今日记录编辑弹窗（复用记录页逻辑） */
  function openTodayEdit(id, todayRecords) {
    const r = todayRecords.find(x => x.id === id);
    if (!r) return;
    const cats = state.categories;
    const catOpts = cats.map(c =>
      `<option value="${c.id}" ${c.id === r.category_id ? "selected" : ""}>${escapeHtml(c.name)}${c.is_active ? "" : "（已停用）"}</option>`
    ).join("");

    const wrap = App.openModal("编辑记录", `
      <div class="form">
        <div class="amount-row amount-row-sm">
          <span class="currency">¥</span>
          <input type="text" id="home-edit-amount" inputmode="decimal" value="${(r.amount_cents / 100).toFixed(2)}">
        </div>
        <div class="field-row"><label>大类</label><select id="home-edit-cat">${catOpts}</select></div>
        <div class="field-row"><label>项目</label><select id="home-edit-item"></select></div>
        <div class="field-row"><label>小项</label><select id="home-edit-sub"></select></div>
        <div class="field-row"><label>备注</label><input type="text" id="home-edit-note" value="${escapeHtml(r.note || "")}"></div>
      </div>`,
      `<button class="btn btn-ghost" id="home-edit-cancel">取消</button>
       <button class="btn btn-primary" id="home-edit-save">保存</button>`);

    const itemSel = wrap.querySelector("#home-edit-item");
    const subSel = wrap.querySelector("#home-edit-sub");
    const renderItems = () => {
      const catId = wrap.querySelector("#home-edit-cat").value;
      const items = App.cache.items.filter(i => i.category_id === catId);
      itemSel.innerHTML = items.map(i =>
        `<option value="${i.id}" ${i.id === r.item_id ? "selected" : ""}>${escapeHtml(i.name)}${i.is_active ? "" : "（已停用）"}</option>`
      ).join("");
      renderSubs();
    };
    const renderSubs = () => {
      const itemId = itemSel.value;
      const subs = (App.cache.subitems || []).filter(s => s.item_id === itemId);
      subSel.innerHTML = `<option value="">（不选）</option>` + subs.map(s =>
        `<option value="${s.id}" ${s.id === r.subitem_id ? "selected" : ""}>${escapeHtml(s.name)}</option>`
      ).join("");
    };
    wrap.querySelector("#home-edit-cat").addEventListener("change", renderItems);
    itemSel.addEventListener("change", renderSubs);
    renderItems();

    wrap.querySelector("#home-edit-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector("#home-edit-save").addEventListener("click", async () => {
      const cents = parseAmountToCents(wrap.querySelector("#home-edit-amount").value);
      if (cents === null) { App.toast("金额格式不正确", "error"); return; }
      const catId = wrap.querySelector("#home-edit-cat").value;
      const itemId = itemSel.value;
      if (!catId || !itemId) { App.toast("请填写完整", "error"); return; }
      try {
        await Store.updateExpense(id, {
          amount_cents: cents,
          category_id: catId, item_id: itemId,
          subitem_id: subSel.value || null,
          note: wrap.querySelector("#home-edit-note").value.trim(),
        });
        wrap.close();
        App.toast("已修改 ✓");
        await App.refreshMeta();
        renderOverview();
      } catch (e) { App.fail(e, "修改失败"); }
    });
  }

  /** 今日记录删除 */
  async function delTodayRecord(id) {
    const ok = await App.confirm("确定删除这笔记录吗？删除后不可恢复。", { danger: true, okText: "删除" });
    if (!ok) return;
    try {
      await Store.deleteExpense(id);
      App.toast("已删除 ✓");
      renderOverview();
    } catch (e) { App.fail(e, "删除失败"); }
  }

  // ---------------- 页面入口 ----------------
  async function render() {
    bindOnce();
    const p = page();
    p.querySelector("#entry-date").value = todayStr();
    try {
      state.categories = await Store.getCategories(false);
      state.items = await Store.getItems(false);
      state.subitems = await Store.getSubitems(false);
    } catch (e) {
      App.fail(e, "分类加载失败");
      state.categories = []; state.items = []; state.subitems = [];
    }
    // 若之前选中的分类已失效，则清空
    if (state.selectedCat && !state.categories.some(c => c.id === state.selectedCat)) {
      state.selectedCat = null; state.selectedItem = null; state.selectedSub = null;
    }
    if (state.selectedItem && !state.items.some(i => i.id === state.selectedItem)) {
      state.selectedItem = null; state.selectedSub = null;
    }
    if (state.selectedSub && !state.subitems.some(s => s.id === state.selectedSub)) {
      state.selectedSub = null;
    }
    renderCategories();
    renderItems();
    renderSubs();
    renderOverview();
    p.querySelector("#entry-amount").focus();
  }

  App.registerPage("home", { title: "记一笔", render });
})();
