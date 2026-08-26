// ============================================================
// 预算共享计算（纯逻辑，供首页/月度/年度/预算页复用）
// 口径约定：
//   - 未设预算 = 无记录（null），不参与任何合计与超支判断
//   - 预算 0 = 明确禁花，花一分都算超支
//   - 月度预算 = 当月已设大类之和；年度预算 = 12 个月之和（不单独存）
//   - 管控口径 = 只统计「已设预算」的大类；未设但有支出的单独黄条提示
//   - 月均分母 = 账本「实际有记账的月份数」（哪个月有任何一笔支出就算 1 个月）
// ============================================================
const Budget = (() => {

  /** 预算行数组 → Map(catId → Array(12))；元素为「分」或 null（该月未设） */
  function grid(budgets) {
    const m = new Map();
    for (const b of budgets) {
      if (!m.has(b.category_id)) m.set(b.category_id, new Array(12).fill(null));
      m.get(b.category_id)[b.month - 1] = b.amount_cents;
    }
    return m;
  }

  /** 大类 12 个月预算合计（分）；未设按 0 计 */
  function catYearTotal(arr) {
    return arr ? arr.reduce((s, v) => s + (v || 0), 0) : 0;
  }

  /** 已过月份里设过的预算合计（分）：时序「应消耗」的分母 */
  function catPassedTotal(arr, passedMonths) {
    if (!arr) return 0;
    let s = 0;
    for (let i = 0; i < 12; i++) if (i < passedMonths) s += (arr[i] || 0);
    return s;
  }

  /**
   * 某月的预算执行情况（管控口径）
   * @param budgets 该年预算行数组  @param month 1-12  @param monthRecords 当月全部记录
   * 返回 { rows, unsetRows, totalBudget, managedSpent, unsetTotal }
   *   rows:      已设预算的大类 [{catId,name,budget,spent,status,overAmt}] 按超支金额降序
   *   unsetRows: 本月未设预算但当月有支出的大类 [{catId,name,spent}] 按支出降序
   */
  function monthStatus(budgets, month, monthRecords) {
    const g = grid(budgets);
    const byCat = groupSum(monthRecords, r => r.category_id);
    const mIdx = month - 1;
    const rows = [], unsetRows = [];
    let totalBudget = 0, managedSpent = 0, unsetTotal = 0;
    for (const [catId, arr] of g) {
      const b = arr[mIdx];
      if (b === null || b === undefined) continue; // 该大类本月未设 → 不参与
      const spent = byCat.has(catId) ? byCat.get(catId).total : 0;
      totalBudget += b;
      managedSpent += spent;
      rows.push({
        catId, name: App.catName(catId), budget: b, spent,
        status: spent > b ? "over" : (b > 0 && spent >= b * 0.8 ? "near" : "ok"),
        overAmt: Math.max(0, spent - b),
      });
    }
    for (const [catId, grp] of byCat) {
      if (g.has(catId) && g.get(catId)[mIdx] != null) continue; // 已计入管控口径
      unsetRows.push({ catId, name: App.catName(catId), spent: grp.total });
      unsetTotal += grp.total;
    }
    rows.sort((a, b) => b.overAmt - a.overAmt || b.spent - a.spent);
    unsetRows.sort((a, b) => b.spent - a.spent);
    return { rows, unsetRows, totalBudget, managedSpent, unsetTotal };
  }

  /**
   * 某年的预算执行情况（时序口径：已花 vs 已过月份的应消耗）
   * @param budgets 该年预算行  @param records 该年全部记录  @param year 统计年份
   * 返回 { rows, unsetRows, totalBudget, expected, managedSpent, unsetTotal, passed, monthsSet }
   *   expected = 已过月份设过的预算合计（历史年 passed=12 → 全年预算）
   */
  function yearStatus(budgets, records, year) {
    const nowY = new Date().getFullYear();
    const passed = year === nowY ? new Date().getMonth() + 1 : 12;
    const g = grid(budgets);
    const byCat = groupSum(records, r => r.category_id);
    const rows = [], unsetRows = [];
    let totalBudget = 0, expected = 0, managedSpent = 0, unsetTotal = 0;
    for (const b of budgets) totalBudget += b.amount_cents;
    for (const [catId, arr] of g) {
      const catBudget = catYearTotal(arr);
      const catExpected = catPassedTotal(arr, passed);
      const spent = byCat.has(catId) ? byCat.get(catId).total : 0;
      expected += catExpected;
      managedSpent += spent;
      rows.push({
        catId, name: App.catName(catId), budget: catBudget, expected: catExpected, spent,
        status: spent > catExpected ? "over" : (catExpected > 0 && spent >= catExpected * 0.8 ? "near" : "ok"),
        overAmt: Math.max(0, spent - catExpected),
      });
    }
    for (const [catId, grp] of byCat) {
      if (g.has(catId)) continue; // 该大类今年设过预算（任意月）→ 已计入
      unsetRows.push({ catId, name: App.catName(catId), spent: grp.total });
      unsetTotal += grp.total;
    }
    rows.sort((a, b) => b.overAmt - a.overAmt || b.spent - a.spent);
    unsetRows.sort((a, b) => b.spent - a.spent);
    return { rows, unsetRows, totalBudget, expected, managedSpent, unsetTotal, passed, monthsSet: new Set(budgets.map(b => b.month)).size };
  }

  /** 某年账本实际有记账的月份数（哪个月有任何一笔支出就算 1 个月） */
  function monthsRecorded(records) {
    return new Set(records.map(r => monthKey(r.expense_date))).size;
  }

  /**
   * 上一年支出参考（预算设置时的提示）
   * 返回 { months, byCat: Map(catId → { total, avg }) }
   *   months = 账本有记账的月份数（分母）；avg = 月均 = 大类年支出 ÷ 账本月数
   */
  function lastYearStats(lastYearRecords) {
    const months = monthsRecorded(lastYearRecords);
    const byCat = groupSum(lastYearRecords, r => r.category_id);
    const m = new Map();
    for (const [id, g] of byCat) {
      m.set(id, { total: g.total, avg: months > 0 ? Math.round(g.total / months) : 0 });
    }
    return { months, byCat: m };
  }

  /** 读取预算（容错：云端没建 budgets 表时提示一次并按未设处理，不影响页面其它数据） */
  let warned = false;
  async function safeGet(year) {
    try {
      return await Store.getBudgets(year);
    } catch (e) {
      if (!warned) {
        warned = true;
        App.toast("预算读取失败：" + (e.message || e) + "（云端请先执行 db/schema.sql 创建 budgets 表）", "error", 5000);
      }
      return [];
    }
  }

  return { grid, catYearTotal, catPassedTotal, monthStatus, yearStatus, monthsRecorded, lastYearStats, safeGet };
})();
