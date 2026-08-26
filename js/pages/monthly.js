// ============================================================
// 月度统计页：选定年月 → 总支出/笔数/环比/大类(可展开到项目)/全年趋势
// ============================================================
(() => {
  const state = { year: null, month: null, yearRecords: [], openCat: null, openItem: null };
  const MONTH_LABELS = Array.from({ length: 12 }, (_, i) => (i + 1) + "月");

  const page = () => document.getElementById("page-monthly");

  function bindOnce() {
    const p = page();
    if (p.dataset.bound) return;
    p.dataset.bound = "1";
    // 填充年份（近 6 年）和月份选项
    const ySel = p.querySelector("#mon-year");
    const nowY = new Date().getFullYear();
    ySel.innerHTML = Array.from({ length: 7 }, (_, i) => nowY - 5 + i)
      .map(y => `<option value="${y}">${y}年</option>`).reverse().join("");
    p.querySelector("#mon-month").innerHTML =
      Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}月</option>`).join("");
    p.querySelector("#mon-year").addEventListener("change", e => {
      state.year = parseInt(e.target.value, 10);
      render();
    });
    p.querySelector("#mon-month").addEventListener("change", e => {
      state.month = parseInt(e.target.value, 10);
      render();
    });
    p.querySelector("#mon-prev").addEventListener("click", () => stepMonth(-1));
    p.querySelector("#mon-next").addEventListener("click", () => stepMonth(1));
    // 大类展开/收起（单开：同一时间只显示一张对比图）+ 项目点击看趋势图
    p.querySelector("#mon-cats").addEventListener("click", e => {
      const box = p.querySelector("#mon-cats");
      const head = e.target.closest(".cat-head");
      if (head) {
        const block = head.closest(".cat-block");
        const wasOpen = block.classList.contains("open");
        closeAllCatBlocks(box);          // 收起所有大类（含当前，若已展开）
        if (!wasOpen) {                  // 原来收起 → 展开显示大类图；原来展开 → 保持收起
          block.classList.add("open");
          state.openCat = block.dataset.cat;
        } else {
          state.openCat = null;
        }
        state.openItem = null;
        return;
      }
      const itemRow = e.target.closest(".item-row[data-item]");
      if (itemRow) toggleItemChart(itemRow);
    });
    // 对比图/趋势图：点击柱子 → 整页切换到该月数据
    const onBarClick = e => {
      const rect = e.target.closest("rect.bar-click");
      if (!rect) return;
      const m = parseInt(rect.dataset.idx, 10) + 1;
      if (!m || m === state.month) return;
      state.month = m;
      p.querySelector("#mon-month").value = m;
      render();
    };
    p.querySelector("#mon-cats").addEventListener("click", onBarClick);
    p.querySelector("#mon-trend").addEventListener("click", onBarClick);
  }

  /** 展开/收起某项目的 12 个月趋势图（单开：切换项目时自动隐藏其他图） */
  function toggleItemChart(rowEl) {
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains("item-detail")) {
      existing.remove(); // 再点同一项目 → 仅收起项目图，不自动弹回大类图
      state.openItem = null;
      return;
    }

    const box = rowEl.closest("#mon-cats");
    const block = rowEl.closest(".cat-block");
    closeAllCatBlocks(box, block);   // 收起其他大类
    box.querySelectorAll(".item-detail").forEach(d => d.remove()); // 清空所有旧项目图（单开）
    block.classList.add("open");     // 本大类保持展开
    const cc = block.querySelector(".cat-chart");
    if (cc) cc.style.display = "none"; // 隐藏本大类图，只显示项目图

    const itemId = rowEl.dataset.item;
    const catId = block.dataset.cat;
    state.openCat = catId;               // 记住展开位置，切月后恢复
    state.openItem = itemId;
    const { year, month, yearRecords } = state;
    const records = yearRecords.filter(r => r.item_id === itemId && r.category_id === catId);
    const totals = monthlyTotalsOf(records);
    const total = records.reduce((s, r) => s + r.amount_cents, 0);

    // 小项构成（当月口径，与项目行金额一致；该项目当月有小项记录才显示）
    const monthRecs = records.filter(r => ymOf(r.expense_date).m === month);
    const bySub = groupSum(monthRecs.filter(r => r.subitem_id), r => r.subitem_id);
    let subHTML = "";
    if (bySub.size > 0) {
      const noSubTotal = monthRecs.filter(r => !r.subitem_id).reduce((s, r) => s + r.amount_cents, 0);
      const subRows = [...bySub.entries()]
        .map(([id, g]) => ({ label: App.subName(id), value: g.total }))
        .sort((a, b) => b.value - a.value);
      if (noSubTotal > 0) subRows.push({ label: "未分小项", value: noSubTotal });
      subHTML = `
        <div class="sub-stats">
          <div class="cat-chart-title">${escapeHtml(rowEl.dataset.name)} · 小项构成（${month}月）</div>
          ${ratioBarList(subRows)}
        </div>`;
    }

    const detail = document.createElement("div");
    detail.className = "item-detail";
    detail.innerHTML = `
      <div class="cat-chart-title">${escapeHtml(rowEl.dataset.name)} · ${year}年各月</div>
      ${barChartSVG(totals, MONTH_LABELS, { height: 150, highlightIndex: month - 1, attachData: true })}
      ${subHTML}
      <div class="detail-total">全年合计：<b>${fmtYuan(total)}</b> · 共 ${records.length} 笔</div>`;
    rowEl.after(detail);
  }

  function stepMonth(delta) {
    let { year, month } = state;
    month += delta;
    if (month === 0) { month = 12; year--; }
    if (month === 13) { month = 1; year++; }
    state.year = year; state.month = month;
    page().querySelector("#mon-year").value = year;
    page().querySelector("#mon-month").value = month;
    render();
  }

  /** 大类行右侧预算角标：超支红 / ≥80% 黄 / 未设灰；正常且 <80% 不显示 */
  function budBadge(arr, mIdx, spent) {
    if (!arr || arr[mIdx] == null) return `<span class="bud-badge bud-badge-unset">未设</span>`;
    const b = arr[mIdx];
    if (spent > b) return `<span class="bud-badge bud-badge-over">超 ${fmtYuan(spent - b)}</span>`;
    if (b > 0 && spent >= b * 0.8) return `<span class="bud-badge bud-badge-near">${Math.round(spent / b * 100)}%</span>`;
    return "";
  }

  async function render() {
    bindOnce();
    const p = page();
    if (!state.year) {
      const now = new Date();
      state.year = now.getFullYear();
      state.month = now.getMonth() + 1;
      p.querySelector("#mon-year").value = state.year;
      p.querySelector("#mon-month").value = state.month;
    }
    const { year, month } = state;

    p.querySelector("#mon-summary").innerHTML = `<div class="card loading-card">加载中…</div>`;
    p.querySelector("#mon-cats").innerHTML = "";

    try {
      // 拉取整年数据，一次计算：当月、上月、12个月趋势（预算一并拉取）
      const [from, to] = yearRange(year);
      const [yearRecords, budgets] = await Promise.all([
        Store.getExpenses({ from, to }),
        Budget.safeGet(year),
      ]);
      state.yearRecords = yearRecords; // 供项目趋势图展开用（避免重复请求）

      const monthRecords = yearRecords.filter(r => ymOf(r.expense_date).m === month);
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const prevRecords = prevMonth === 12
        ? (await Store.getExpenses({ from: `${prevYear}-12-01`, to: `${prevYear}-12-31` }))
        : yearRecords.filter(r => ymOf(r.expense_date).m === prevMonth);

      const cur = sumRecords(monthRecords);
      const prev = sumRecords(prevRecords);
      const bs = Budget.monthStatus(budgets, month, monthRecords);

      // ---- 汇总卡片 + 预算合并 ----
      let momLine = "";
      if (prev.count > 0) {
        const diff = cur.total - prev.total;
        const pct = prev.total > 0 ? (diff / prev.total) * 100 : null;
        momLine = `<div class="sum-row"><span class="${diff >= 0 ? "text-up" : "text-down"}">相比${prevMonth}月 ${fmtYuanSigned(diff)}${pct != null ? "（" + fmtPct(pct) + "）" : ""}</span></div>`;
      } else {
        momLine = `<div class="sum-row muted">相比${prevMonth}月 暂无数据</div>`;
      }

      const hasBudget = bs.totalBudget > 0;
      const over = hasBudget && bs.managedSpent > bs.totalBudget;
      const remain = hasBudget ? bs.totalBudget - bs.managedSpent : 0;
      const pctBar = hasBudget ? Math.min(100, bs.managedSpent / bs.totalBudget * 100) : 0;

      p.querySelector("#mon-summary").innerHTML = `
        <div class="card summary-card">
          <div class="sum-head">
            <span class="sum-title">${year}年${month}月</span>
            <a href="#/budget" class="link-btn">调整 →</a>
          </div>
          <div class="sum-main">${fmtYuan(cur.total)}</div>
          <div class="sum-row">共 ${cur.count} 笔</div>
          ${momLine}
          ${hasBudget ? `
            <div class="budget-track"><i class="${over ? "over" : ""}" style="width:${pctBar.toFixed(1)}%"></i></div>
            <div class="sum-row">
              月预算 ${fmtYuan(bs.totalBudget)} · 已花 <b class="${over ? "text-up" : ""}">${fmtYuan(bs.managedSpent)}</b>
              · ${over ? "超 " + fmtYuan(-remain) : "剩 " + fmtYuan(remain)}
            </div>
          ` : `<div class="sum-row muted"><a href="#/budget" class="link-btn">去设置预算 →</a></div>`}
        </div>`;

      // ---- 大类统计（可展开到项目；行尾预算角标）----
      const byCat = groupSum(monthRecords, r => r.category_id);
      const gB = Budget.grid(budgets);
      const catRows = [...byCat.entries()]
        .map(([id, g]) => ({ id, name: App.catName(id), total: g.total, count: g.count, records: g.records }))
        .sort((a, b) => b.total - a.total);

      const catsBox = p.querySelector("#mon-cats");
      if (!catRows.length) {
        catsBox.innerHTML = `<div class="card"><div class="empty">本月还没有消费记录</div></div>`;
      } else {
        catsBox.innerHTML = `
          <div class="card">
            <h3 class="card-title">大类统计（点大类看全年变化，点柱子切月份，点项目看逐月）</h3>
            ${ratioBarList(catRows.map(c => ({ label: c.name, value: c.total })))}
            ${catRows.map(c => {
              const pct = cur.total > 0 ? (c.total / cur.total) * 100 : 0;
              const byItem = groupSum(c.records, r => r.item_id);
              const itemRows = [...byItem.entries()]
                .map(([id, g]) => ({ id, name: App.itemName(id), total: g.total, count: g.count }))
                .sort((a, b) => b.total - a.total);
              const catYearTotals = monthlyTotalsOf(yearRecords.filter(r => r.category_id === c.id));
              return `
                <div class="cat-block" data-cat="${c.id}">
                  <div class="cat-head">
                    <span class="cat-chevron">▸</span>
                    <span class="cat-name">${escapeHtml(c.name)}</span>
                    <span class="cat-meta">${c.count}笔 · ${pct.toFixed(1)}%</span>
                    ${budBadge(gB.get(c.id), month - 1, c.total)}
                    <span class="cat-amount">${fmtYuan(c.total)}</span>
                  </div>
                  <div class="cat-body">
                    <div class="cat-chart">
                      <div class="cat-chart-title">${escapeHtml(c.name)} · ${year}年各月</div>
                      ${barChartSVG(catYearTotals, MONTH_LABELS, { height: 150, highlightIndex: month - 1, attachData: true })}
                    </div>
                    <div class="cat-bar"><i style="width:${Math.max(2, pct).toFixed(1)}%"></i></div>
                    ${itemRows.map(i => `
                      <div class="item-row item-clickable" data-item="${i.id}" data-name="${escapeHtml(i.name)}" title="点击查看该项目全年各月变化">
                        <span>${escapeHtml(i.name)} <em>${i.count}笔</em></span>
                        <span class="cat-amount">${fmtYuan(i.total)}</span>
                      </div>`).join("")}
                  </div>
                </div>`;
            }).join("")}
          </div>`;
      }

      // ---- 全年各月趋势 ----
      const monthlyTotals = Array.from({ length: 12 }, (_, i) => 0);
      for (const r of yearRecords) monthlyTotals[ymOf(r.expense_date).m - 1] += r.amount_cents;
      p.querySelector("#mon-trend").innerHTML = `
        <div class="card">
          <h3 class="card-title">${year}年各月趋势（点击柱子切换月份）</h3>
          ${barChartSVG(monthlyTotals, Array.from({ length: 12 }, (_, i) => (i + 1) + "月"), { highlightIndex: month - 1, attachData: true })}
        </div>`;

      // 点击柱子切月后，恢复之前展开的大类/项目，不丢浏览上下文
      if (state.openCat) {
        const block = catsBox.querySelector(`.cat-block[data-cat="${state.openCat}"]`);
        if (block) {
          block.classList.add("open");
          if (state.openItem) {
            const row = block.querySelector(`.item-row[data-item="${state.openItem}"]`);
            if (row) toggleItemChart(row);
          }
        }
      }

    } catch (e) {
      p.querySelector("#mon-summary").innerHTML = `<div class="card"><div class="empty">加载失败：${escapeHtml(e.message || String(e))}</div></div>`;
    }
  }

  App.registerPage("monthly", { title: "月度", render });
})();
