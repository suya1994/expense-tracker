// ============================================================
// 记录页：全部消费记录的查看 / 筛选 / 搜索 / 修改 / 删除
// ============================================================
(() => {
  const state = {
    records: [],
    visible: 0,
    PAGE_SIZE: 20,
    total: 0,
  };

  const page = () => document.getElementById("page-records");

  function bindOnce() {
    const p = page();
    if (p.dataset.bound) return;
    p.dataset.bound = "1";

    p.querySelector("#rec-apply").addEventListener("click", () => load());
    p.querySelector("#rec-reset").addEventListener("click", () => {
      p.querySelector("#rec-from").value = "";
      p.querySelector("#rec-to").value = "";
      p.querySelector("#rec-year").value = "";
      p.querySelector("#rec-cat").value = "";
      p.querySelector("#rec-item").value = "";
      p.querySelector("#rec-sub").value = "";
      p.querySelector("#rec-kw").value = "";
      load();
    });
    p.querySelector("#rec-kw").addEventListener("keydown", e => { if (e.key === "Enter") load(); });
    // 年份筛选 → 自动填充日期区间（近 6 年）
    const ySel = p.querySelector("#rec-year");
    const curY = new Date().getFullYear();
    for (let y = curY - 5; y <= curY; y++) ySel.add(new Option(`${y} 年`, String(y)));
    ySel.addEventListener("change", e => {
      const v = e.target.value;
      if (v) {
        p.querySelector("#rec-from").value = `${v}-01-01`;
        p.querySelector("#rec-to").value = `${v}-12-31`;
      }
    });
    p.querySelector("#rec-cat").addEventListener("change", () => { renderItemsSelect(); });
    p.querySelector("#rec-item").addEventListener("change", () => { renderSubsSelect(); });
    // 记录表操作（事件委托）
    p.querySelector("#rec-table").addEventListener("click", e => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === "edit") openEdit(id);
      if (btn.dataset.act === "del") delRecord(id);
    });
    p.querySelector("#rec-more").addEventListener("click", () => {
      state.visible += state.PAGE_SIZE;
      renderTable();
    });
    p.querySelector("#rec-export-all").addEventListener("click", () => ExportExcel.exportAll());
    // 导入 Excel
    p.querySelector("#rec-import").addEventListener("click", () => p.querySelector("#rec-import-file").click());
    p.querySelector("#rec-import-file").addEventListener("change", onFileSelected);
    // 批量删除：本年 / 本月
    p.querySelector("#rec-del-year").addEventListener("click", () => delRange("year"));
    p.querySelector("#rec-del-month").addEventListener("click", () => delRange("month"));
  }

  // ---------------- 导入 ----------------
  async function onFileSelected(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = ""; // 允许再次选择同一文件
    if (!file) return;
    let parsed;
    try {
      parsed = await ImportExcel.parseFile(file);
    } catch (err) { App.fail(err, "解析失败"); return; }
    if (!parsed.rows.length && !parsed.errors.length) {
      App.toast("文件里没有可识别的数据", "error");
      return;
    }
    await App.refreshMeta();
    showImportPreview(parsed);
  }

  async function showImportPreview(parsed) {
    const preview = ImportExcel.buildPreview(parsed);
    const valid = preview.total;
    // 与库中已有记录重复的行（勾选/取消去重时实时联动显示）
    let libDup = { count: 0, sumCents: 0 };
    try { libDup = (await ImportExcel.countLibraryDupes(parsed)) || libDup; }
    catch (e) { /* 统计失败按 0 处理，不影响导入本身 */ }
    const newCatText = preview.newCats.length
      ? `<div class="imp-line">将新建大类：${preview.newCats.map(escapeHtml).join("、")}</div>` : "";
    const newItemText = preview.newItems
      ? `<div class="imp-line">将新建项目 ${preview.newItems} 个</div>` : "";
    const newSubText = preview.newSubs
      ? `<div class="imp-line">将新建小项 ${preview.newSubs} 个</div>` : "";
    const errHtml = parsed.errors.length
      ? `<details class="imp-details"><summary>${parsed.errors.length} 行无法识别，将被跳过（点击查看）</summary>
         <ul class="imp-errors">${parsed.errors.slice(0, 20).map(x => `<li>第 ${x.row} 行：${escapeHtml(x.msg)}</li>`).join("")}${parsed.errors.length > 20 ? `<li>…共 ${parsed.errors.length} 行</li>` : ""}</ul></details>` : "";
    const dupHtml = parsed.dupRows > 0
      ? `<div class="imp-line imp-warn">文件内有 <b>${parsed.dupRows}</b> 笔完全相同记录（如 同一天相同金额的多笔消费），将<b>全部导入</b>，去重不会跳过它们</div>` : "";

    const wrap = App.openModal("导入预览", `
      <p class="imp-file">${escapeHtml(parsed.fileName)}${parsed.sheetName ? `（工作表：${escapeHtml(parsed.sheetName)}）` : ""}</p>
      <p class="imp-stat">识别到 <b>${valid}</b> 笔有效记录，合计 <b>${fmtYuan(preview.sumCents)}</b>；其中与已有记录完全相同 <b>${libDup.count}</b> 笔</p>
      <div class="imp-line imp-warn" id="imp-dup-effect"></div>
      ${newCatText}${newItemText}${newSubText}${dupHtml}
      <label class="imp-dedupe"><input type="checkbox" id="imp-dedupe" checked> 跳过与已有记录完全相同的（按 日期+分类+项目+小项+金额+备注）</label>
      ${errHtml}`,
      `<button class="btn btn-ghost imp-cancel">取消</button><button class="btn btn-primary imp-ok"></button>`);

    // 勾选/取消去重 → 实时刷新「将导入笔数/合计」和确认按钮
    const effectEl = wrap.querySelector("#imp-dup-effect");
    const okBtn = wrap.querySelector(".imp-ok");
    const applyDedupe = () => {
      const on = wrap.querySelector("#imp-dedupe").checked;
      const n = on ? valid - libDup.count : valid;
      const sum = on ? preview.sumCents - libDup.sumCents : preview.sumCents;
      effectEl.innerHTML = on
        ? (libDup.count > 0
            ? `已勾选去重：将跳过 <b>${libDup.count}</b> 笔与已有重复，实际导入 <b>${n}</b> 笔，合计 ${fmtYuan(sum)}`
            : `已勾选去重：没有与已有记录重复，${valid} 笔将全部导入`)
        : `未勾选去重：<b>${valid}</b> 笔将全部导入（含与已有重复的 ${libDup.count} 笔，会产生重复数据）`;
      if (valid <= 0) { okBtn.disabled = true; okBtn.textContent = "没有可导入的数据"; }
      else if (n <= 0) { okBtn.disabled = true; okBtn.textContent = "全部与已有重复，无可导入"; }
      else { okBtn.disabled = false; okBtn.textContent = `确认导入 ${n} 笔`; }
    };
    wrap.querySelector("#imp-dedupe").addEventListener("change", applyDedupe);
    applyDedupe();

    wrap.querySelector(".imp-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector(".imp-ok").addEventListener("click", async () => {
      const btn = wrap.querySelector(".imp-ok");
      btn.disabled = true;
      btn.textContent = "导入中…";
      const dedupe = wrap.querySelector("#imp-dedupe").checked;
      try {
        const res = await ImportExcel.doImport(parsed, { dedupe });
        wrap.close();
        App.toast(`导入完成：新增 ${res.imported} 笔` + (res.skipped ? `，跳过 ${res.skipped} 笔` : "") + " ✓");
        await App.refreshMeta();
        load();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "确认导入";
        App.fail(err, "导入失败");
      }
    });
  }

  function renderItemsSelect() {
    const p = page();
    const catId = p.querySelector("#rec-cat").value;
    const sel = p.querySelector("#rec-item");
    const cur = sel.value;
    const items = catId ? App.cache.items.filter(i => i.category_id === catId) : App.cache.items;
    sel.innerHTML = `<option value="">全部项目</option>` + items.map(i =>
      `<option value="${i.id}">${escapeHtml(i.name)}${i.is_active ? "" : "（已停用）"}</option>`
    ).join("");
    if (items.some(i => i.id === cur)) sel.value = cur;
    renderSubsSelect();
  }

  /** 小项筛选下拉：选了项目 → 只列该项目的小项；未选项目 → 列范围内全部小项（带项目名前缀区分） */
  function renderSubsSelect() {
    const p = page();
    const catId = p.querySelector("#rec-cat").value;
    const itemId = p.querySelector("#rec-item").value;
    const sel = p.querySelector("#rec-sub");
    const cur = sel.value;
    const subs = (App.cache.subitems || []).filter(s => {
      const item = App.cache.items.find(i => i.id === s.item_id);
      if (!item) return false;
      if (itemId) return s.item_id === itemId;
      return catId ? item.category_id === catId : true;
    });
    sel.innerHTML = `<option value="">全部小项</option>` + subs.map(s => {
      const label = itemId ? s.name : `${App.itemName(s.item_id)} / ${s.name}`;
      return `<option value="${s.id}">${escapeHtml(label)}${s.is_active ? "" : "（已停用）"}</option>`;
    }).join("");
    if (subs.some(s => s.id === cur)) sel.value = cur;
  }

  async function load() {
    const p = page();
    const tbodyWrap = p.querySelector("#rec-table");
    tbodyWrap.innerHTML = `<div class="empty">加载中…</div>`;
    const f = {
      from: p.querySelector("#rec-from").value || undefined,
      to: p.querySelector("#rec-to").value || undefined,
      categoryId: p.querySelector("#rec-cat").value || undefined,
      itemId: p.querySelector("#rec-item").value || undefined,
      subitemId: p.querySelector("#rec-sub").value || undefined,
      keyword: p.querySelector("#rec-kw").value.trim() || undefined,
    };
    try {
      state.records = await Store.getExpenses(f);
      state.total = state.records.reduce((s, r) => s + r.amount_cents, 0);
      state.visible = state.PAGE_SIZE;
      renderTable();
    } catch (e) {
      tbodyWrap.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  function renderTable() {
    const p = page();
    const box = p.querySelector("#rec-table");
    const shown = state.records.slice(0, state.visible);

    p.querySelector("#rec-count").textContent =
      `共 ${state.records.length} 笔 · 合计 ${fmtYuan(state.total)}`;

    if (!state.records.length) {
      box.innerHTML = `<div class="empty">没有符合条件的记录</div>`;
      p.querySelector("#rec-more").style.display = "none";
      return;
    }

    box.innerHTML = `
      <table class="table">
        <thead><tr><th>日期</th><th>大类</th><th>项目</th><th class="ta-r">金额</th><th>备注</th><th class="ta-c">操作</th></tr></thead>
        <tbody>
          ${shown.map(r => `
            <tr>
              <td class="td-date">${escapeHtml(r.expense_date)}</td>
              <td>${escapeHtml(App.catName(r.category_id))}</td>
              <td>${escapeHtml(App.itemName(r.item_id))}${r.subitem_id ? ` <em class="td-sub">${escapeHtml(App.subName(r.subitem_id))}</em>` : ""}</td>
              <td class="td-amount">${fmtYuan(r.amount_cents)}</td>
              <td class="td-note">${escapeHtml(r.note || "—")}</td>
              <td class="ta-c td-ops">
                <button class="link-btn" data-act="edit" data-id="${r.id}">编辑</button>
                <button class="link-btn link-danger" data-act="del" data-id="${r.id}">删除</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    const more = p.querySelector("#rec-more");
    more.style.display = state.visible < state.records.length ? "" : "none";
    more.textContent = `加载更多（还有 ${state.records.length - state.visible} 笔）`;
  }

  // ---------------- 编辑 ----------------
  function openEdit(id) {
    const r = state.records.find(x => x.id === id);
    if (!r) return;
    const cats = App.cache.categories;
    const catOpts = cats.map(c =>
      `<option value="${c.id}" ${c.id === r.category_id ? "selected" : ""}>${escapeHtml(c.name)}${c.is_active ? "" : "（已停用）"}</option>`
    ).join("");

    const wrap = App.openModal("编辑记录", `
      <div class="form">
        <div class="amount-row amount-row-sm">
          <span class="currency">¥</span>
          <input type="text" id="edit-amount" inputmode="decimal" value="${(r.amount_cents / 100).toFixed(2)}">
        </div>
        <div class="field-row"><label>日期</label><input type="date" id="edit-date" value="${r.expense_date}"></div>
        <div class="field-row"><label>大类</label><select id="edit-cat">${catOpts}</select></div>
        <div class="field-row"><label>项目</label><select id="edit-item"></select></div>
        <div class="field-row"><label>小项（选填）</label><select id="edit-sub"></select></div>
        <div class="field-row"><label>备注</label><input type="text" id="edit-note" value="${escapeHtml(r.note || "")}"></div>
      </div>`,
      `<button class="btn btn-ghost" id="edit-cancel">取消</button>
       <button class="btn btn-primary" id="edit-save">保存</button>`);

    const itemSel = wrap.querySelector("#edit-item");
    const subSel = wrap.querySelector("#edit-sub");
    const renderItems = () => {
      const catId = wrap.querySelector("#edit-cat").value;
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
    wrap.querySelector("#edit-cat").addEventListener("change", renderItems);
    itemSel.addEventListener("change", renderSubs);
    renderItems();

    wrap.querySelector("#edit-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector("#edit-save").addEventListener("click", async () => {
      const cents = parseAmountToCents(wrap.querySelector("#edit-amount").value);
      if (cents === null) { App.toast("金额格式不正确", "error"); return; }
      const date = wrap.querySelector("#edit-date").value;
      const catId = wrap.querySelector("#edit-cat").value;
      const itemId = wrap.querySelector("#edit-item").value;
      if (!date || !catId || !itemId) { App.toast("请填写完整", "error"); return; }
      try {
        await Store.updateExpense(id, {
          amount_cents: cents, expense_date: date,
          category_id: catId, item_id: itemId,
          subitem_id: subSel.value || null,
          note: wrap.querySelector("#edit-note").value.trim(),
        });
        wrap.close();
        App.toast("已修改 ✓");
        load();
      } catch (e) { App.fail(e, "修改失败"); }
    });
  }

  async function delRecord(id) {
    const r = state.records.find(x => x.id === id);
    if (!r) return;
    const ok = await App.confirm(`确定删除这笔记录吗？\n${r.expense_date} · ${App.catName(r.category_id)} · ${App.itemName(r.item_id)} · ${fmtYuan(r.amount_cents)}（删除后不可恢复）`, { danger: true, okText: "删除" });
    if (!ok) return;
    try {
      await Store.deleteExpense(id);
      App.toast("已删除 ✓");
      load();
    } catch (e) { App.fail(e, "删除失败"); }
  }

  // ---------------- 批量删除（按年 / 按月，弹窗选择任意范围） ----------------
  async function delRange(scope) {
    const isYear = scope === "year";
    let all;
    try {
      all = await Store.getExpenses({});
    } catch (e) { App.fail(e, "查询失败"); return; }
    if (!all.length) { App.toast("还没有任何记录可删除", "error"); return; }

    // 年份下拉：有数据年份 + 近 5 年（含当前年），保证任意年份都能选
    const dataYears = new Set(all.map(r => r.expense_date.slice(0, 4)));
    const curY = String(new Date().getFullYear());
    for (let y = Number(curY) - 4; y <= Number(curY); y++) dataYears.add(String(y));
    const years = [...dataYears].sort();

    const curM = String(new Date().getMonth() + 1).padStart(2, "0");
    const monthOpts = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, "0");
      return `<option value="${m}"${m === curM ? " selected" : ""}>${i + 1} 月</option>`;
    }).join("");

    const title = isYear ? "删除某年记录" : "删除某月记录";
    const wrap = App.openModal(title, `
      <p class="imp-file">选择要删除的${isYear ? "年份" : "月份"}，范围内所有记录将被删除（不可恢复）</p>
      <div class="form">
        <div class="field-row">
          <label>年份</label>
          <select id="del-y">${years.map(y => `<option value="${y}"${y === curY ? " selected" : ""}>${y} 年</option>`).join("")}</select>
        </div>
        ${isYear ? "" : `
        <div class="field-row">
          <label>月份</label>
          <select id="del-m">${monthOpts}</select>
        </div>`}
        <p class="imp-stat" id="del-stat">计算中…</p>
      </div>`,
      `<button class="btn btn-ghost imp-cancel">取消</button>
       <button class="btn btn-danger imp-del-ok" disabled>删除</button>`);

    // 选中范围统计
    const stat = () => {
      const y = wrap.querySelector("#del-y").value;
      const m = isYear ? "" : wrap.querySelector("#del-m").value;
      const prefix = isYear ? y : `${y}-${m}`;
      const rows = all.filter(r => r.expense_date.startsWith(prefix));
      const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
      const label = isYear ? `${y} 年` : `${y} 年 ${Number(m)} 月`;
      const ok = wrap.querySelector(".imp-del-ok");
      if (!rows.length) {
        wrap.querySelector("#del-stat").textContent = `${label}没有记录`;
        ok.disabled = true;
        ok.textContent = "该范围无记录";
      } else {
        wrap.querySelector("#del-stat").innerHTML = `${label}共有 <b>${rows.length}</b> 笔 · 合计 <b>${fmtYuan(sum)}</b>`;
        ok.disabled = false;
        ok.textContent = `删除 ${label}全部 ${rows.length} 笔`;
      }
    };
    wrap.querySelector("#del-y").addEventListener("change", stat);
    if (!isYear) wrap.querySelector("#del-m").addEventListener("change", stat);
    stat();

    wrap.querySelector(".imp-cancel").addEventListener("click", () => wrap.close());
    wrap.querySelector(".imp-del-ok").addEventListener("click", async () => {
      const y = wrap.querySelector("#del-y").value;
      const m = isYear ? null : wrap.querySelector("#del-m").value;
      const from = isYear ? `${y}-01-01` : `${y}-${m}-01`;
      const to = isYear ? `${y}-12-31` : monthRange(Number(y), Number(m))[1];
      const label = isYear ? `${y} 年` : `${y} 年 ${Number(m)} 月`;
      const rows = isYear
        ? all.filter(r => r.expense_date.startsWith(y))
        : all.filter(r => r.expense_date.startsWith(`${y}-${m}`));
      const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
      wrap.close();
      const ok = await App.confirm(
        `确定删除 ${label}的全部记录吗？\n共 ${rows.length} 笔 · 合计 ${fmtYuan(sum)}\n删除后不可恢复！`,
        { danger: true, okText: "删除" }
      );
      if (!ok) return;
      try {
        const n = await Store.deleteExpensesByRange(from, to);
        App.toast(`已删除 ${n} 笔 ✓`);
        await App.refreshMeta();
        load();
      } catch (e) { App.fail(e, "删除失败"); }
    });
  }

  // ---------------- 页面入口 ----------------
  async function render() {
    bindOnce();
    const p = page();
    // 填充大类筛选
    const catSel = p.querySelector("#rec-cat");
    const curCat = catSel.value;
    catSel.innerHTML = `<option value="">全部大类</option>` + App.cache.categories.map(c =>
      `<option value="${c.id}">${escapeHtml(c.name)}${c.is_active ? "" : "（已停用）"}</option>`
    ).join("");
    if (App.cache.categories.some(c => c.id === curCat)) catSel.value = curCat;
    renderItemsSelect();
    load();
  }

  App.registerPage("records", { title: "记录", render });
})();
