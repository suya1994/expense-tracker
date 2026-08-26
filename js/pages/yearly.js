// ============================================================
// 年度统计页：年份 → 总支出/笔数/月均/同比/近6年年度对比图
// 大类 → 具体项目 → 该项目近 6 年逐年对比（层级下钻）
// ============================================================
(() => {
  const state = { year: null, openCat: null, openItem: null };

  const page = () => document.getElementById("page-yearly");
  const COMPARE_YEARS = 6; // 年度对比展示近 6 年

  function bindOnce() {
    const p = page();
    if (p.dataset.bound) return;
    p.dataset.bound = "1";
    const ySel = p.querySelector("#yr-year");
    const nowY = new Date().getFullYear();
    ySel.innerHTML = Array.from({ length: 7 }, (_, i) => nowY - 5 + i)
      .map(y => `<option value="${y}">${y}年</option>`).reverse().join("");
    p.querySelector("#yr-year").addEventListener("change", e => {
      state.year = parseInt(e.target.value, 10);
      render();
    });
    p.querySelector("#yr-export").addEventListener("click", () => ExportExcel.exportYear(state.year));
    // 对比图：点击柱子切换年份（顶部年度对比 + 大类/项目下钻图通用）
    const onBarClick = e => {
      const rect = e.target.closest("rect.bar-click");
      if (!rect) return;
      const yearsAttr = rect.closest("svg").dataset.years;
      if (!yearsAttr) return;
      const idx = parseInt(rect.dataset.idx, 10);
      const year = parseInt(yearsAttr.split(",")[idx], 10);
      if (!year || year === state.year) return;
      state.year = year;
      p.querySelector("#yr-year").value = year;
      render();
    };
    p.querySelector("#yr-trend").addEventListener("click", onBarClick);
    p.querySelector("#yr-cats").addEventListener("click", onBarClick);
    // 大类下钻（事件委托，单开：同一时间只显示一张对比图）
    p.querySelector("#yr-cats").addEventListener("click", e => {
      const box = p.querySelector("#yr-cats");
      const head = e.target.closest(".cat-head");
      if (head) {
        const block = head.closest(".cat-block");
        const wasOpen = block.classList.contains("open");
        closeAllCatBlocks(box);
        if (!wasOpen) { block.classList.add("open"); state.openCat = block.dataset.cat; }
        else state.openCat = null;
        state.openItem = null;
        return;
      }
      const itemRow = e.target.closest(".item-row[data-item]");
      if (itemRow) toggleItemDetail(itemRow);
    });
  }

  /** 展开/收起某具体项目的近 6 年逐年对比图（单开：切换项目时自动隐藏其他图） */
  async function toggleItemDetail(rowEl) {
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains("item-detail")) {
      existing.remove(); // 再点同一项目 → 仅收起项目图，不自动弹回大类图
      state.openItem = null;
      return;
    }

    const box = rowEl.closest("#yr-cats");
    const block = rowEl.closest(".cat-block");
    closeAllCatBlocks(box, block);   // 收起其他大类
    box.querySelectorAll(".item-detail").forEach(d => d.remove()); // 清空所有旧项目图（单开）
    block.classList.add("open");     // 本大类保持展开
    const cc = block.querySelector(".cat-chart");
    if (cc) cc.style.display = "none"; // 隐藏本大类图，只显示项目图

    const itemId = rowEl.dataset.item;
    const catId = block.dataset.cat;
    state.openCat = catId;               // 记住展开位置，切年后恢复
    state.openItem = itemId;
    const year = state.year;
    const nowY = new Date().getFullYear();
    const years = Array.from({ length: COMPARE_YEARS }, (_, i) => nowY - COMPARE_YEARS + 1 + i);
    const curIdx = years.indexOf(year);

    let yearly, total = 0, count = 0, curRecs;
    try {
      const allRecs = await Promise.all(years.map(y => {
        const [from, to] = yearRange(y);
        return Store.getExpenses({ from, to });
      }));
      const hit = recs => recs.filter(r => r.item_id === itemId && r.category_id === catId);
      yearly = allRecs.map(recs => {
        const h = hit(recs);
        total += h.reduce((s, r) => s + r.amount_cents, 0);
        count += h.length;
        return h.reduce((s, r) => s + r.amount_cents, 0);
      });
      // 当前选中年份该项目的记录（小项构成口径；选中年不在近 6 年窗口时单独拉取）
      if (curIdx >= 0) curRecs = hit(allRecs[curIdx]);
      else {
        const [from, to] = yearRange(year);
        curRecs = hit(await Store.getExpenses({ from, to }));
      }
    } catch (e) { App.fail(e); return; }

    // 小项构成（当前选中年口径，与项目行金额一致）
    const bySub = groupSum(curRecs.filter(r => r.subitem_id), r => r.subitem_id);
    let subHTML = "";
    if (bySub.size > 0) {
      const noSubTotal = curRecs.filter(r => !r.subitem_id).reduce((s, r) => s + r.amount_cents, 0);
      const subRows = [...bySub.entries()]
        .map(([id, g]) => ({ label: App.subName(id), value: g.total }))
        .sort((a, b) => b.value - a.value);
      if (noSubTotal > 0) subRows.push({ label: "未分小项", value: noSubTotal });
      subHTML = `
        <div class="sub-stats">
          <div class="cat-chart-title">${escapeHtml(rowEl.dataset.name)} · 小项构成（${year}年）</div>
          ${ratioBarList(subRows)}
        </div>`;
    }

    const detail = document.createElement("div");
    detail.className = "item-detail";
    detail.innerHTML = `
      <div class="cat-chart-title">${escapeHtml(rowEl.dataset.name)} · 近 ${COMPARE_YEARS} 年逐年对比</div>
      ${barChartSVG(yearly, years.map(y => y + "年"), { height: 150, highlightIndex: curIdx, attachData: true }).replace("<svg ", `<svg data-years="${years.join(",")}" `)}
      ${subHTML}
      <div class="detail-total">近 ${COMPARE_YEARS} 年合计：<b>${fmtYuan(total)}</b> · 共 ${count} 笔</div>`;
    rowEl.after(detail);
  }

  /** 大类行年度角标：对「时序应消耗」（已过月份的预算折算）超支红 / ≥80% 黄 / 未设灰 */
  function yearBudBadge(arr, passed, spent) {
    if (!arr) return `<span class="bud-badge bud-badge-unset">未设</span>`;
    const catBudget = Budget.catYearTotal(arr);
    const expected = Budget.catPassedTotal(arr, passed);
    if (catBudget <= 0) {
      return (arr.some(v => v != null) && spent > 0)
        ? `<span class="bud-badge bud-badge-over">超 ${fmtYuan(spent)}</span>` : "";
    }
    if (spent > expected) return `<span class="bud-badge bud-badge-over">超 ${fmtYuan(spent - expected)}</span>`;
    if (expected > 0 && spent >= expected * 0.8) return `<span class="bud-badge bud-badge-near">${Math.round(spent / expected * 100)}%</span>`;
    return "";
  }

  /** 年度预算卡：时序口径——进度条上画「应消耗线」（已过月份 ÷ 12），过了线才算超 */
  function yearBudgetCard(budgets, records, year) {
    if (!budgets.length) {
      return `
        <div class="card budget-card">
          <div class="table-head">
            <h3 class="card-title">年度预算</h3>
            <a href="#/budget" class="link-btn">去设置 →</a>
          </div>
          <div class="empty" style="padding:10px;font-size:13px">尚未设置预算，设置后这里显示年度执行进度和超支提醒</div>
        </div>`;
    }
    const ys = Budget.yearStatus(budgets, records, year);
    const isNow = year === new Date().getFullYear();
    const over = ys.managedSpent > ys.expected;
    const diff = ys.managedSpent - ys.expected;
    const barPct = ys.totalBudget > 0 ? Math.min(100, ys.managedSpent / ys.totalBudget * 100) : 0;
    const markPct = Math.min(100, ys.passed / 12 * 100); // 应消耗线位置（历史年 = 100% 右端）

    let statusHTML;
    if (over) {
      let pred = "";
      if (isNow && ys.passed > 0) {
        const projected = Math.round(ys.managedSpent / ys.passed * 12);
        pred = `；按此节奏年底将达 ${fmtYuan(projected)}${projected > ys.totalBudget ? `（超预算 ${fmtYuan(projected - ys.totalBudget)}）` : "（预算内）"}`;
      }
      statusHTML = `<span class="text-up">超时序 ${fmtYuan(diff)}</span>（应消耗 ${fmtYuan(ys.expected)}）${pred}`;
    } else {
      statusHTML = `<span class="budget-remain">快于节奏 ${fmtYuan(-diff)}</span>（应消耗 ${fmtYuan(ys.expected)}）`;
    }

    const overRows = ys.rows.filter(r => r.status === "over");
    return `
      <div class="card budget-card">
        <div class="table-head">
          <h3 class="card-title">年度预算</h3>
          <a href="#/budget" class="link-btn">调整 →</a>
        </div>
        <div class="budget-line">
          <span class="budget-amount">${fmtYuan(ys.totalBudget)}</span>
          <span class="muted">已设 ${ys.monthsSet}/12 月 · 已花 <b class="${over ? "text-up" : ""}">${fmtYuan(ys.managedSpent)}</b>${ys.unsetTotal ? ` · 未设大类另花 ${fmtYuan(ys.unsetTotal)}` : ""}</span>
          ${ys.managedSpent > ys.totalBudget ? `<span class="text-up">已超全年 ${fmtYuan(ys.managedSpent - ys.totalBudget)}</span>` : ""}
        </div>
        <div class="budget-track">
          <i class="${over ? "over" : ""}" style="width:${barPct.toFixed(1)}%"></i>
          ${isNow ? `<em class="budget-mark" style="left:${markPct.toFixed(1)}%" title="应消耗线（${ys.passed}/12）"></em>` : ""}
        </div>
        <div class="muted" style="margin-top:6px;font-size:13px">${statusHTML}${isNow ? " · 竖线 = 应消耗线" : ""}</div>
        ${overRows.length || ys.unsetRows.length ? `
        <div class="budget-rows">
          ${overRows.map(r => `<div class="bud-row over"><span>${escapeHtml(r.name)}</span><span>${fmtYuan(r.spent)} / 应消耗 ${fmtYuan(r.expected)} · 超 ${fmtYuan(r.overAmt)}</span></div>`).join("")}
          ${ys.unsetRows.map(r => `<div class="bud-row unset"><span>${escapeHtml(r.name)}</span><span>${fmtYuan(r.spent)} · 未设预算</span></div>`).join("")}
        </div>` : ""}
      </div>`;
  }

  async function render() {
    bindOnce();
    const p = page();
    if (!state.year) {
      state.year = new Date().getFullYear();
      p.querySelector("#yr-year").value = state.year;
    }
    const year = state.year;

    p.querySelector("#yr-summary").innerHTML = `<div class="card loading-card">加载中…</div>`;
    p.querySelector("#yr-cats").innerHTML = "";
    p.querySelector("#yr-trend").innerHTML = "";

    try {
      // 近 6 年数据：固定以当前自然年为窗口终点，点选其他年份只高亮
      const nowY = new Date().getFullYear();
      const years = Array.from({ length: COMPARE_YEARS }, (_, i) => nowY - COMPARE_YEARS + 1 + i);
      const curIdx = years.indexOf(year);
      const range = years.map(y => yearRange(y));
      const [allRecords, budgets] = await Promise.all([
        Promise.all(range.map(([from, to]) => Store.getExpenses({ from, to }))),
        Budget.safeGet(year),
      ]);

      const records = allRecords[curIdx];
      const prevRecords = curIdx > 0 ? allRecords[curIdx - 1] : [];

      const cur = sumRecords(records);
      const prev = sumRecords(prevRecords);
      // 月均分母：账本实际有记账的月份数（当年防未来日期记录，封顶已过月份）
      let recMonths = Budget.monthsRecorded(records);
      const nowM = new Date().getMonth() + 1;
      if (year === nowY) recMonths = Math.min(recMonths, nowM);
      const monthsDiv = recMonths || 1;
      const monthlyAvg = recMonths > 0 ? Math.round(cur.total / recMonths) : 0;
      const passed = year === nowY ? nowM : 12;

      // ---- 汇总 ----
      let yoyHTML = "";
      if (prev.count > 0) {
        const diff = cur.total - prev.total;
        const pct = prev.total > 0 ? (diff / prev.total) * 100 : null;
        yoyHTML = `
          <div class="card ov-card">
            <div class="ov-label">同比 ${year - 1}年</div>
            <div class="ov-amount ${diff >= 0 ? "text-up" : "text-down"}">${fmtYuanSigned(diff)}</div>
            <div class="ov-sub">${prev.total > 0 ? fmtPct(pct) + "（去年 " + fmtYuan(prev.total) + "）" : ""}</div>
          </div>`;
      }
      p.querySelector("#yr-summary").innerHTML = `
        <div class="ov-grid ov-grid-3">
          <div class="card ov-card">
            <div class="ov-label">${year}年 总支出</div>
            <div class="ov-amount">${fmtYuan(cur.total)}</div>
            <div class="ov-sub">共 ${cur.count} 笔</div>
          </div>
          <div class="card ov-card">
            <div class="ov-label">月均消费</div>
            <div class="ov-amount">${recMonths > 0 ? fmtYuan(monthlyAvg) : "—"}</div>
            <div class="ov-sub">${recMonths > 0 ? `按实际 ${recMonths} 个月平均` : "该年还没有记录"}</div>
          </div>
          ${yoyHTML || `<div class="card ov-card"><div class="ov-label">同比</div><div class="ov-amount">—</div><div class="ov-sub">${year - 1}年暂无数据</div></div>`}
        </div>
        ${yearBudgetCard(budgets, records, year)}`;

      // ---- 年度对比（近 6 年）----
      const yearlyTotals = allRecords.map(sumRecords).map(s => s.total);
      const yearHasData = yearlyTotals.map(t => t > 0);
      const hasAnyData = yearlyTotals.some(t => t > 0);
      let meta = "";
      if (hasAnyData) {
        let maxIdx = -1, minIdx = -1;
        years.forEach((_, i) => {
          if (!yearHasData[i]) return;
          if (maxIdx === -1 || yearlyTotals[i] > yearlyTotals[maxIdx]) maxIdx = i;
          if (minIdx === -1 || yearlyTotals[i] < yearlyTotals[minIdx]) minIdx = i;
        });
        meta = `
          <div class="trend-meta">
            <span>最高：<b>${years[maxIdx]}年</b> ${fmtYuan(yearlyTotals[maxIdx])}</span>
            <span>最低：<b>${years[minIdx]}年</b> ${fmtYuan(yearlyTotals[minIdx])}</span>
            <span>当前：<b>${year}年</b> ${fmtYuan(yearlyTotals[curIdx])}</span>
          </div>`;
      }

      p.querySelector("#yr-trend").innerHTML = `
        <div class="card">
          <h3 class="card-title">年度支出对比（近 ${COMPARE_YEARS} 年 · 点击柱子切换年份）</h3>
          ${hasAnyData ? barChartSVG(yearlyTotals, years.map(y => y + "年"), { highlightIndex: curIdx, attachData: true }).replace("<svg ", `<svg data-years="${years.join(",")}" `) : ""}
          ${hasAnyData ? meta : `<div class="empty">近 ${COMPARE_YEARS} 年暂无数据</div>`}
        </div>`;

      // ---- 大类列表（含同比、下钻）----
      const byCat = groupSum(records, r => r.category_id);
      const prevByCat = groupSum(prevRecords, r => r.category_id);
      const catRows = [...byCat.entries()]
        .map(([id, g]) => ({ id, name: App.catName(id), total: g.total, count: g.count, records: g.records }))
        .sort((a, b) => b.total - a.total);

      // 近 6 年每年各大类总额（顺序与 years 一致，用于大类逐年对比图）
      // 注意：必须按年份索引写入并补 0——若只在有数据的年份 push，
      // 数据不连续时（如仅有 2025/2026 两年）柱子会错位画到前面的年份上
      const catYearlyByCat = new Map();
      allRecords.forEach((recs, i) => {
        for (const [cid, gg] of groupSum(recs, r => r.category_id)) {
          if (!catYearlyByCat.has(cid)) catYearlyByCat.set(cid, new Array(years.length).fill(0));
          catYearlyByCat.get(cid)[i] = gg.total;
        }
      });
      const gB = Budget.grid(budgets);

      const box = p.querySelector("#yr-cats");
      if (!catRows.length) {
        box.innerHTML = `<div class="card"><div class="empty">该年度还没有消费记录</div></div>`;
      } else {
        box.innerHTML = `
          <div class="card">
            <h3 class="card-title">大类统计（点大类看近 ${COMPARE_YEARS} 年变化，点柱子切年份，点项目看逐年对比）</h3>
            ${ratioBarList(catRows.map(c => ({ label: c.name, value: c.total })))}
            ${catRows.map(c => {
              const pct = cur.total > 0 ? (c.total / cur.total) * 100 : 0;
              const monthAvg = recMonths > 0 ? Math.round(c.total / monthsDiv) : 0;
              const prevG = prevByCat.get(c.id);
              let yoy = "";
              if (prevG && prevG.total > 0) {
                const d = (c.total - prevG.total) / prevG.total * 100;
                yoy = `<span class="yoy ${d >= 0 ? "text-up" : "text-down"}">同比${fmtPct(d)}</span>`;
              }
              const byItem = groupSum(c.records, r => r.item_id);
              const itemRows = [...byItem.entries()]
                .map(([id, g]) => ({ id, name: App.itemName(id), total: g.total, count: g.count }))
                .sort((a, b) => b.total - a.total);
              const catYearly = catYearlyByCat.get(c.id) || years.map(() => 0);
              return `
                <div class="cat-block" data-cat="${c.id}">
                  <div class="cat-head">
                    <span class="cat-chevron">▸</span>
                    <span class="cat-name">${escapeHtml(c.name)} ${yoy}</span>
                    ${yearBudBadge(gB.get(c.id), passed, c.total)}
                    <span class="cat-amount">${fmtYuan(c.total)}</span>
                  </div>
                  <div class="cat-body">
                    <div class="cat-chart">
                      <div class="cat-chart-title">${escapeHtml(c.name)} · 近 ${COMPARE_YEARS} 年逐年对比</div>
                      ${barChartSVG(catYearly, years.map(y => y + "年"), { height: 150, highlightIndex: curIdx, attachData: true }).replace("<svg ", `<svg data-years="${years.join(",")}" `)}
                    </div>
                    <div class="cat-bar"><i style="width:${Math.max(2, pct).toFixed(1)}%"></i></div>
                    ${itemRows.map(i => `
                      <div class="item-row item-clickable" data-item="${i.id}" data-name="${escapeHtml(i.name)}" title="点击查看该项目近 ${COMPARE_YEARS} 年对比">
                        <span>↳ ${escapeHtml(i.name)} <em>${i.count}笔 · 月均 ${fmtYuan(recMonths > 0 ? Math.round(i.total / monthsDiv) : 0)}</em></span>
                        <span class="cat-amount">${fmtYuan(i.total)}</span>
                      </div>`).join("")}
                    <div class="item-hint">点击具体项目可查看近 ${COMPARE_YEARS} 年变化图</div>
                  </div>
                </div>`;
            }).join("")}
          </div>`;
      }

      // 恢复展开位置（点击柱子切年后不丢上下文；该大类/项目在新年份无记录则自然不显示）
      if (state.openCat) {
        const block = box.querySelector(`.cat-block[data-cat="${state.openCat}"]`);
        if (block) {
          block.classList.add("open");
          if (state.openItem) {
            const row = block.querySelector(`.item-row[data-item="${state.openItem}"]`);
            if (row) toggleItemDetail(row);
          }
        }
      }

    } catch (e) {
      p.querySelector("#yr-summary").innerHTML = `<div class="card"><div class="empty">加载失败：${escapeHtml(e.message || String(e))}</div></div>`;
    }
  }

  App.registerPage("yearly", { title: "年度", render });
})();
