// ============================================================
// 预算设置页：模版 + 月度分配
// - 月度总预算 = 该月 budgets 记录之和（不再单独存储）
// - 模版：设置各大类分配，一键应用到全年12个月
// - 大类分配：点开月份，将总预算分配到各具体大类
// - 交互：失焦保存，局部更新 DOM，不刷页面
// ============================================================
(() => {
  const state = {
    year: null, cats: [], budgets: [], yearRecords: [],
    lastStats: null, lastMonthly: new Map(), yearMonthly: new Map(),
  };

  const page = () => document.getElementById("page-budget");

  function bindOnce() {
    const p = page();
    if (p.dataset.bound) return;
    p.dataset.bound = "1";
    const ySel = p.querySelector("#bud-year");
    const nowY = new Date().getFullYear();
    ySel.innerHTML = Array.from({ length: 7 }, (_, i) => nowY - 5 + i)
      .map(y => `<option value="${y}">${y}年</option>`).reverse().join("");
    ySel.addEventListener("change", e => {
      state.year = parseInt(e.target.value, 10);
      render();
    });
    p.querySelector("#bud-back").addEventListener("click", () => { location.hash = "#/home"; });

    const list = p.querySelector("#bud-list");
    list.addEventListener("click", e => {
      const head = e.target.closest(".mbud-head");
      if (head) {
        const block = head.closest(".mbud-block");
        const wasOpen = block.classList.contains("open");
        list.querySelectorAll(".mbud-block.open").forEach(b => b.classList.remove("open"));
        if (!wasOpen) block.classList.add("open");
        return;
      }
      const applyBtn = e.target.closest("#tmpl-apply");
      if (applyBtn) { applyTemplate(); return; }
      const applyMonthBtn = e.target.closest("#tmpl-apply-month");
      if (applyMonthBtn) {
        const y = parseInt(page().querySelector("#tmpl-year").value, 10);
        const m = parseInt(page().querySelector("#tmpl-month").value, 10);
        applyTemplateToMonth(y, m);
        return;
      }
      const catAdopt = e.target.closest("[data-cat-adopt]");
      if (catAdopt) {
        const { catAdoptCat, catAdoptMonth } = catAdopt.dataset;
        adoptSuggestion(catAdoptCat, parseInt(catAdoptMonth, 10));
      }
    });
    // 模版大类分配输入
    list.addEventListener("change", e => {
      const input = e.target.closest("input.tmpl-cat-val");
      if (input) updateTemplateTotal();
    });
    // 大类分配输入
    list.addEventListener("change", e => {
      const input = e.target.closest("input.bud-cat-alloc");
      if (input) saveCatAlloc(input.dataset.cat, parseInt(input.dataset.m, 10), input.value);
    });
    // 回车保存
    list.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const input = e.target.closest("input.tmpl-cat-val, input.bud-cat-alloc");
      if (input) input.blur();
    });
  }

  // ---- 模版 ----
  function getTemplateData() {
    const p = page();
    const catVals = [];
    p.querySelectorAll("input.tmpl-cat-val").forEach(inp => {
      const cents = parseAmountToCents(inp.value);
      catVals.push({ catId: inp.dataset.cat, cents: cents || 0 });
    });
    const allocTotal = catVals.reduce((s, v) => s + v.cents, 0);
    return { catVals, allocTotal };
  }

  function updateTemplateTotal() {
    const p = page();
    const { allocTotal } = getTemplateData();
    const totalEl = p.querySelector("#tmpl-total-display");
    if (totalEl) {
      totalEl.innerHTML = allocTotal > 0
        ? `月合计 <b>${fmtYuan(allocTotal)}</b>`
        : "";
    }
  }

  async function applyTemplate() {
    const { catVals, allocTotal } = getTemplateData();
    const catsWithAlloc = catVals.filter(v => v.cents > 0);
    if (!catsWithAlloc.length) { App.toast("请至少设置一个大类预算", "error"); return; }

    if (!await App.confirm(
      `确认将此模版应用到 ${state.year} 全年12个月？\n` +
      `每月预算合计 ${fmtYuan(allocTotal)}\n` +
      catsWithAlloc.map(v => {
        const c = state.cats.find(x => x.id === v.catId);
        return (c ? c.name : "?") + " " + fmtYuan(v.cents);
      }).join("、"),
      { okText: "应用" }
    )) return;

    try {
      // 写入大类分配
      for (const v of catsWithAlloc) {
        for (let m = 1; m <= 12; m++) {
          await Store.setBudget(v.catId, state.year, m, v.cents);
          syncLocal(v.catId, m, v.cents);
        }
      }
      // 清除不在模版里的大类
      for (const c of state.cats) {
        if (!catVals.some(v => v.catId === c.id)) {
          for (let m = 1; m <= 12; m++) {
            const existing = state.budgets.find(b => b.category_id === c.id && b.year === state.year && b.month === m);
            if (existing && existing.amount_cents > 0) {
              await Store.deleteBudget(c.id, state.year, m);
              state.budgets = state.budgets.filter(b => !(b.category_id === c.id && b.year === state.year && b.month === m));
            }
          }
        }
      }
      // 更新所有月份区块
      for (let m = 1; m <= 12; m++) {
        rerenderMonthBlock(m);
      }
      // 保存模版到线上数据库
      const tmplSave = {
        cats: catVals.map(v => {
          const c = state.cats.find(x => x.id === v.catId);
          return { id: v.catId, name: c ? c.name : "", val: v.cents > 0 ? v.cents / 100 : "" };
        }),
      };
      await Store.setBudgetTemplate(tmplSave);
      App.toast("模版已应用到全年 ✓");
    } catch (e) { App.fail(e, "应用失败"); }
  }

  async function applyTemplateToMonth(year, month) {
    const { catVals, allocTotal } = getTemplateData();
    const catsWithAlloc = catVals.filter(v => v.cents > 0);
    if (!catsWithAlloc.length) { App.toast("请至少设置一个大类预算", "error"); return; }

    if (!await App.confirm(
      `确认将此模版应用到 ${year} 年 ${month} 月？\n` +
      `该月预算合计 ${fmtYuan(allocTotal)}\n` +
      catsWithAlloc.map(v => {
        const c = state.cats.find(x => x.id === v.catId);
        return (c ? c.name : "?") + " " + fmtYuan(v.cents);
      }).join("、"),
      { okText: "应用" }
    )) return;

    try {
      for (const v of catsWithAlloc) {
        await Store.setBudget(v.catId, year, month, v.cents);
        // 同步本地 budgets 缓存
        const existing = state.budgets.find(b => b.category_id === v.catId && b.year === year && b.month === month);
        if (existing) {
          existing.amount_cents = v.cents;
        } else {
          state.budgets.push({ category_id: v.catId, year, month, amount_cents: v.cents });
        }
      }
      // 清除不在模版里的大类
      for (const c of state.cats) {
        if (!catVals.some(v => v.catId === c.id)) {
          const existing = state.budgets.find(b => b.category_id === c.id && b.year === year && b.month === month);
          if (existing && existing.amount_cents > 0) {
            await Store.deleteBudget(c.id, year, month);
            state.budgets = state.budgets.filter(b => !(b.category_id === c.id && b.year === year && b.month === month));
          }
        }
      }
      rerenderMonthBlock(month);
      // 保存模版到数据库
      const tmplSave = {
        cats: catVals.map(v => {
          const c = state.cats.find(x => x.id === v.catId);
          return { id: v.catId, name: c ? c.name : "", val: v.cents > 0 ? v.cents / 100 : "" };
        }),
      };
      await Store.setBudgetTemplate(tmplSave);
      App.toast(`模版已应用到 ${year} 年 ${month} 月 ✓`);
    } catch (e) { App.fail(e, "应用失败"); }
  }

  // ---- 局部更新 helpers ----
  function getMonthBlock(m) {
    return page().querySelector(`.mbud-block[data-month="${m}"]`);
  }

  /** 月度总预算 = 该月 budgets 之和 */
  function monthBudgetCents(m) {
    return state.budgets
      .filter(b => b.year === state.year && b.month === m && b.amount_cents > 0)
      .reduce((s, b) => s + b.amount_cents, 0);
  }

  /** 重新渲染单个月份区块（数据已更新后调用） */
  function rerenderMonthBlock(m) {
    const block = getMonthBlock(m);
    if (!block) return;
    const wasOpen = block.classList.contains("open");

    const budget = monthBudgetCents(m);
    const budgetSet = budget > 0;
    const monthIdx = m - 1;
    const spent = (state.yearRecords || [])
      .filter(r => { const { y, m: rm } = ymOf(r.expense_date); return y === state.year && rm === m; })
      .reduce((s, r) => s + r.amount_cents, 0);
    const nowM2 = new Date().getMonth() + 1;
    const isCurrent = m === nowM2 && state.year === new Date().getFullYear();
    const g = Budget.grid(state.budgets);

    const catAlloc = state.cats.map(c => {
      const arr = g.get(c.id);
      const alloc = arr ? arr[monthIdx] : null;
      const catSpent = (state.yearMonthly.get(c.id) || [])[monthIdx] || 0;
      const st = state.lastStats.byCat.get(c.id);
      return { cat: c, alloc, catSpent, lastAvg: st ? st.avg : 0 };
    });
    const allocTotal = catAlloc.reduce((s, a) => s + (a.alloc || 0), 0);

    block.outerHTML = `
    <div class="mbud-block${wasOpen ? " open" : ""}" data-month="${m}">
      <div class="mbud-head">
        <span class="cat-chevron">▸</span>
        <span class="mbud-month"${isCurrent ? ' style="font-weight:700"' : ""}>${m}月</span>
        <span class="mbud-budget">${budgetSet ? fmtYuan(budget) : "未设"}</span>
        <span class="mbud-spent">已花 ${fmtYuan(spent)}</span>
        <span class="mbud-remain ${budgetSet && spent > budget ? "text-up" : "text-down"}" ${!budgetSet ? 'style="display:none"' : ""}>${budgetSet ? (spent > budget ? "超 " + fmtYuan(spent - budget) : "剩 " + fmtYuan(budget - spent)) : ""}</span>
      </div>
      <div class="mbud-body">
        ${budgetSet ? `
          <div class="mbud-alloc-head">
            <span>大类分配（月合计 ${fmtYuan(allocTotal)}）</span>
            <span>已花 ${fmtYuan(spent)} · 剩余 <b class="${spent > budget ? "text-up" : ""}">${fmtYuan(budget - spent)}</b></span>
          </div>
        ` : ""}
        <div class="mbud-alloc-list">
          ${catAlloc.map(a => `
            <div class="mbud-alloc-row">
              <span class="mbud-alloc-name">${escapeHtml(a.cat.name)}</span>
              <span class="mbud-alloc-spent">${a.catSpent > 0 ? "花 " + fmtCompact(a.catSpent) : ""}</span>
              <input class="bud-cat-alloc" data-cat="${a.cat.id}" data-m="${m}" inputmode="decimal" autocomplete="off"
                     value="${a.alloc != null ? a.alloc / 100 : ""}" placeholder="—">
              ${a.lastAvg > 0 ? `<button class="link-btn" style="font-size:11px" data-cat-adopt="${a.cat.id}" data-cat-month="${m}" title="采用去年月均 ${fmtYuan(a.lastAvg)}">去年均 ${fmtCompact(a.lastAvg)}</button>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    </div>`;

    updateAnnualTotal();
  }

  function updateAnnualTotal() {
    const budget = state.budgets
      .filter(b => b.year === state.year && b.amount_cents > 0)
      .reduce((s, b) => s + b.amount_cents, 0);
    const yearSpent = (state.yearRecords || []).reduce((s, r) => s + r.amount_cents, 0);
    const totalEl = page().querySelector("#bud-total");
    if (totalEl) {
      totalEl.innerHTML = budget
        ? `年度总预算 <b>${fmtYuan(budget)}</b> · 今年已花 ${fmtYuan(yearSpent)}`
        : "尚未设置预算";
    }
  }

  // ---- 大类分配 ----
  function syncLocal(catId, m, cents) {
    const row = state.budgets.find(b => b.category_id === catId && b.year === state.year && b.month === m);
    if (row) row.amount_cents = cents;
    else state.budgets.push({ category_id: catId, year: state.year, month: m, amount_cents: cents });
  }

  async function saveCatAlloc(catId, m, val) {
    const s = String(val).trim();

    if (s === "") {
      try {
        await Store.deleteBudget(catId, state.year, m);
        state.budgets = state.budgets.filter(b => !(b.category_id === catId && b.year === state.year && b.month === m));
        rerenderMonthBlock(m);
      } catch (e) { App.fail(e, "保存失败"); }
      return;
    }

    const cents = parseAmountToCents(s);
    if (cents === null) { App.toast("请输入正确金额", "error"); return; }

    try {
      await Store.setBudget(catId, state.year, m, cents);
      syncLocal(catId, m, cents);
      rerenderMonthBlock(m);
    } catch (e) { App.fail(e, "保存失败"); }
  }

  async function adoptSuggestion(catId, m) {
    const st = state.lastStats.byCat.get(catId);
    if (!st || !st.avg) { App.toast("去年没有该大类的支出记录", "error"); return; }

    try {
      await Store.setBudget(catId, state.year, m, st.avg);
      syncLocal(catId, m, st.avg);
      App.toast(`已采用 ${fmtYuan(st.avg)}`);
      rerenderMonthBlock(m);
    } catch (e) { App.fail(e, "采用失败"); }
  }

  async function render() {
    bindOnce();
    const p = page();
    if (!state.year) {
      state.year = new Date().getFullYear();
      p.querySelector("#bud-year").value = state.year;
    }
    const year = state.year;
    const listEl = p.querySelector("#bud-list");
    listEl.innerHTML = `<div class="card loading-card"><div class="spinner"></div>加载中…</div>`;

    try {
      const [yFrom, yTo] = yearRange(year);
      const [lyFrom, lyTo] = yearRange(year - 1);
      const [cats, budgets, yearRecords, lastRecords] = await Promise.all([
        Store.getCategories(false),
        Budget.safeGet(year),
        Store.getExpenses({ from: yFrom, to: yTo }),
        Store.getExpenses({ from: lyFrom, to: lyTo }),
      ]);
      state.cats = cats;
      state.budgets = budgets;
      state.yearRecords = yearRecords;
      state.lastStats = Budget.lastYearStats(lastRecords);

      state.yearMonthly = new Map();
      state.lastMonthly = new Map();
      for (const c of cats) {
        state.yearMonthly.set(c.id, monthlyTotalsOf(yearRecords.filter(r => r.category_id === c.id)));
        state.lastMonthly.set(c.id, monthlyTotalsOf(lastRecords.filter(r => r.category_id === c.id)));
      }

      const monthSpent = monthlyTotalsOf(yearRecords);
      const nowY = new Date().getFullYear();
      const nowM = new Date().getMonth() + 1;

      // 今年各月均（不含当月）：用于模版参考
      const prevMonthRecords = yearRecords.filter(r => {
        const { m: rm } = ymOf(r.expense_date);
        return rm < nowM;
      });
      const prevMonths = new Set(prevMonthRecords.map(r => monthKey(r.expense_date))).size;
      const yearAvgByCat = new Map();
      const byCatYtd = groupSum(prevMonthRecords, r => r.category_id);
      for (const [id, g] of byCatYtd) {
        yearAvgByCat.set(id, prevMonths > 0 ? Math.round(g.total / prevMonths) : 0);
      }

      const yearBudget = budgets.filter(b => b.year === year && b.amount_cents > 0).reduce((s, b) => s + b.amount_cents, 0);
      const yearSpent = yearRecords.reduce((s, r) => s + r.amount_cents, 0);
      const g = Budget.grid(budgets);

      p.querySelector("#bud-total").innerHTML = yearBudget
        ? `年度总预算 <b>${fmtYuan(yearBudget)}</b> · 今年已花 ${fmtYuan(yearSpent)}`
        : "尚未设置预算";

      if (!cats.length) {
        listEl.innerHTML = `<div class="card"><div class="empty">还没有大类，请先到「分类」页添加</div></div>`;
        return;
      }

      // 模版：从线上数据库读取
      const savedTmpl = await Store.getBudgetTemplate();
      const tmplData = savedTmpl ? savedTmpl.data : null;

      const tmplCats = cats.map(c => {
        const lastAvg = state.lastStats.byCat.get(c.id);
        const thisAvg = yearAvgByCat.get(c.id) || 0;
        let val = "";
        if (tmplData && tmplData.cats) {
          const sv = tmplData.cats.find(v => v.id === c.id);
          if (sv) val = sv.val;
        }
        return { cat: c, val, lastAvg: lastAvg ? lastAvg.avg : 0, thisAvg };
      });
      const tmplAllocTotal = tmplCats.reduce((s, a) => {
        const c = parseAmountToCents(String(a.val).trim());
        return s + (c || 0);
      }, 0);

      listEl.innerHTML = `
        <div class="card">
          <h3 class="card-title">预算模版（一键设置全年每月预算）</h3>
          <div class="tmpl-cats">
            ${tmplCats.map(a => `
              <div class="tmpl-row">
                <label>${escapeHtml(a.cat.name)}</label>
                <span class="tmpl-hint">
                  ${a.lastAvg > 0 ? `<div>去年月均 <b>${fmtCompact(a.lastAvg)}</b></div>` : ""}
                  ${a.thisAvg > 0 ? `<div>今年月均 <b>${fmtCompact(a.thisAvg)}</b></div>` : ""}
                </span>
                <input class="tmpl-cat-val" data-cat="${a.cat.id}" inputmode="decimal" autocomplete="off"
                       value="${a.val}" placeholder="—">
              </div>
            `).join("")}
          </div>
          <div class="tmpl-footer">
            <span id="tmpl-total-display">${tmplAllocTotal > 0 ? `月合计 <b>${fmtYuan(tmplAllocTotal)}</b>` : ""}</span>
            <span class="tmpl-actions">
              <select id="tmpl-year" class="sel-year" style="width:auto">
                ${Array.from({ length: 7 }, (_, i) => nowY - 5 + i)
                  .map(y => `<option value="${y}"${y === state.year ? " selected" : ""}>${y}年</option>`).join("")}
              </select>
              <select id="tmpl-month" class="sel-year" style="width:auto">
                ${Array.from({ length: 12 }, (_, i) => {
                  const m = i + 1;
                  return `<option value="${m}"${m === nowM ? " selected" : ""}>${m}月</option>`;
                }).join("")}
              </select>
            </span>
            <span class="tmpl-actions" style="margin-top:8px">
              <button class="btn btn-ghost" id="tmpl-apply-month">应用到指定月</button>
              <button class="btn btn-primary" id="tmpl-apply">应用到全年</button>
            </span>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">月度预算</h3>
          ${Array.from({ length: 12 }, (_, i) => {
            const m = i + 1;
            const budget = monthBudgetCents(m);
            const budgetSet = budget > 0;
            const spent = monthSpent[i];
            const isCurrent = m === nowM && year === new Date().getFullYear();

            const catAlloc = cats.map(c => {
              const arr = g.get(c.id);
              const alloc = arr ? arr[m - 1] : null;
              const catSpent = (state.yearMonthly.get(c.id) || [])[i] || 0;
              const st = state.lastStats.byCat.get(c.id);
              return { cat: c, alloc, catSpent, lastAvg: st ? st.avg : 0 };
            });
            const allocTotal = catAlloc.reduce((s, a) => s + (a.alloc || 0), 0);

            return `
            <div class="mbud-block" data-month="${m}">
              <div class="mbud-head">
                <span class="cat-chevron">▸</span>
                <span class="mbud-month"${isCurrent ? ' style="font-weight:700"' : ""}>${m}月</span>
                <span class="mbud-budget">${budgetSet ? fmtYuan(budget) : "未设"}</span>
                <span class="mbud-spent">已花 ${fmtYuan(spent)}</span>
                <span class="mbud-remain ${budgetSet && spent > budget ? "text-up" : "text-down"}" ${!budgetSet ? 'style="display:none"' : ""}>${budgetSet ? (spent > budget ? "超 " + fmtYuan(spent - budget) : "剩 " + fmtYuan(budget - spent)) : ""}</span>
              </div>
              <div class="mbud-body">
                ${budgetSet ? `
                  <div class="mbud-alloc-head">
                    <span>大类分配（月合计 ${fmtYuan(allocTotal)}）</span>
                    <span>已花 ${fmtYuan(spent)} · 剩余 <b class="${spent > budget ? "text-up" : ""}">${fmtYuan(budget - spent)}</b></span>
                  </div>
                ` : ""}
                <div class="mbud-alloc-list">
                  ${catAlloc.map(a => `
                    <div class="mbud-alloc-row">
                      <span class="mbud-alloc-name">${escapeHtml(a.cat.name)}</span>
                      <span class="mbud-alloc-spent">${a.catSpent > 0 ? "花 " + fmtCompact(a.catSpent) : ""}</span>
                      <input class="bud-cat-alloc" data-cat="${a.cat.id}" data-m="${m}" inputmode="decimal" autocomplete="off"
                             value="${a.alloc != null ? a.alloc / 100 : ""}" placeholder="—">
                      ${a.lastAvg > 0 ? `<button class="link-btn" style="font-size:11px" data-cat-adopt="${a.cat.id}" data-cat-month="${m}" title="采用去年月均 ${fmtYuan(a.lastAvg)}">去年均 ${fmtCompact(a.lastAvg)}</button>` : ""}
                    </div>
                  `).join("")}
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>`;
    } catch (e) {
      listEl.innerHTML = `<div class="card"><div class="empty">加载失败：${escapeHtml(e.message || String(e))}</div></div>`;
    }
  }

  App.registerPage("budget", { title: "预算", render });
})();
