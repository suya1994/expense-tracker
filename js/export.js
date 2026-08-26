// ============================================================
// Excel 导出（SheetJS / xlsx），生成真正的 .xlsx 文件
// 五个 Sheet：全部记录 / 月度统计 / 年度统计 / 详细分类统计 / 月份×项目
// 金额以「元」为数值写入单元格（整数分 ÷ 100，无精度损失），可直接二次计算
// ============================================================
// 占比（0-1，保留 4 位小数，整数运算避免浮点尾巴）
function pct4(part, whole) {
  if (whole <= 0) return 0;
  return Math.round(part / whole * 10000) / 10000;
}

const ExportExcel = {

  /** 导出全部数据 */
  async exportAll() {
    await this._export(await Store.getExpenses({}), "全部", "all");
  },

  /** 导出指定年份 */
  async exportYear(year) {
    const [from, to] = yearRange(year);
    await this._export(await Store.getExpenses({ from, to }), `${year}年`, "year", { year });
  },

  /**
   * @param records 当前范围内的消费记录
   * @param label 文件名标签
   * @param scopeType 'all' | 'year'
   */
  async _export(records, label, scopeType, scope = {}) {
    if (!window.XLSX) { App.toast("Excel 组件未加载，请检查网络", "error"); return; }
    try {
      await App.refreshMeta();
      const wb = XLSX.utils.book_new();

      const total = records.reduce((s, r) => s + r.amount_cents, 0);
      // 月均分母：账本实际有记账的月份数（当年封顶已过月份），全 App 统一口径
      const monthSet = new Set(records.map(r => monthKey(r.expense_date)));
      let recMonths = monthSet.size;
      if (scopeType === "year" && scope.year === new Date().getFullYear())
        recMonths = Math.min(recMonths, new Date().getMonth() + 1);
      const monthsCount = (scopeType === "year" ? recMonths : Math.max(1, monthSet.size)) || 1;

      // ---------- Sheet1 全部消费记录 ----------
      const s1 = [["日期", "大类", "项目", "小项", "金额(元)", "备注"]];
      for (const r of records) {
        s1.push([
          r.expense_date,
          App.catName(r.category_id),
          App.itemName(r.item_id),
          r.subitem_id ? App.subName(r.subitem_id) : "",
          centsToYuan(r.amount_cents),
          r.note || "",
        ]);
      }
      s1.push(["合计", "", "", "", centsToYuan(total), `${records.length} 笔`]);
      const ws1 = XLSX.utils.aoa_to_sheet(s1);
      ws1["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws1, "消费记录");

      // ---------- Sheet2 月度统计 ----------
      const catIds = [...new Set(records.map(r => r.category_id))];
      const catNameById = id => App.catName(id);
      const byMonth = groupSum(records, r => monthKey(r.expense_date));
      const sortedMonths = [...byMonth.keys()].sort();
      const s2 = [["月份", "总支出(元)", "笔数", ...catIds.map(catNameById)]];
      for (const mk of sortedMonths) {
        const g = byMonth.get(mk);
        const byCat = groupSum(g.records, r => r.category_id);
        s2.push([mk, centsToYuan(g.total), g.count,
          ...catIds.map(id => { const c = byCat.get(id); return c ? centsToYuan(c.total) : 0; })]);
      }
      s2.push(["合计", centsToYuan(total), records.length,
        ...catIds.map(id => { const all = records.filter(r => r.category_id === id); return centsToYuan(all.reduce((s, r) => s + r.amount_cents, 0)); })]);
      const ws2 = XLSX.utils.aoa_to_sheet(s2);
      ws2["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 8 }, ...catIds.map(() => ({ wch: 12 }))];
      XLSX.utils.book_append_sheet(wb, ws2, "月度统计");

      // ---------- Sheet3 年度统计（大类维度）----------
      const byCatAll = groupSum(records, r => r.category_id);
      const s3 = [["大类", "总金额(元)", "月均金额(元)", "占比"]];
      for (const [id, g] of [...byCatAll.entries()].sort((a, b) => b[1].total - a[1].total)) {
        s3.push([catNameById(id), centsToYuan(g.total), centsToYuan(Math.round(g.total / monthsCount)),
          total > 0 ? pct4(g.total, total) : 0]);
      }
      s3.push(["合计", centsToYuan(total), centsToYuan(Math.round(total / monthsCount)), 1]);
      const ws3 = XLSX.utils.aoa_to_sheet(s3);
      ws3["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws3, "年度统计");

      // ---------- Sheet4 详细分类统计（大类×项目）----------
      const byItem = groupSum(records, r => r.item_id);
      const s4 = [["大类", "具体项目", "总金额(元)", "月均金额(元)", "占比"]];
      const itemRows = [...byItem.entries()]
        .map(([id, g]) => ({ cat: catNameById(records.find(r => r.item_id === id).category_id), name: App.itemName(id), g }))
        .sort((a, b) => a.cat.localeCompare(b.cat, "zh") || b.g.total - a.g.total);
      for (const row of itemRows) {
        s4.push([row.cat, row.name, centsToYuan(row.g.total),
          centsToYuan(Math.round(row.g.total / monthsCount)),
          total > 0 ? pct4(row.g.total, total) : 0]);
      }
      const ws4 = XLSX.utils.aoa_to_sheet(s4);
      ws4["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws4, "详细分类统计");

      // ---------- Sheet5 月份 × 具体项目 ----------
      // 按年份分行：导出「全部」时跨年数据不会混入同一列；单年/单月导出只有一行
      const s5 = [["年份", "大类", "项目", ...Array.from({ length: 12 }, (_, i) => (i + 1) + "月"), "全年"]];
      const yearKeys = [...new Set(records.map(r => ymOf(r.expense_date).y))].sort();
      for (const row of itemRows) {
        for (const yk of yearKeys) {
          const yearRecs = row.g.records.filter(r => ymOf(r.expense_date).y === yk);
          if (!yearRecs.length) continue;
          const months = Array.from({ length: 12 }, () => 0);
          for (const r of yearRecs) months[ymOf(r.expense_date).m - 1] += r.amount_cents;
          s5.push([String(yk), row.cat, row.name, ...months.map(centsToYuan), centsToYuan(yearRecs.reduce((s, r) => s + r.amount_cents, 0))]);
        }
      }
      // 合计行（同样按年份分行）
      for (const yk of yearKeys) {
        const yRecs = records.filter(r => ymOf(r.expense_date).y === yk);
        if (!yRecs.length) continue;
        const totMonths = Array.from({ length: 12 }, () => 0);
        for (const r of yRecs) totMonths[ymOf(r.expense_date).m - 1] += r.amount_cents;
        s5.push([String(yk), "合计", "", ...totMonths.map(centsToYuan), centsToYuan(yRecs.reduce((s, r) => s + r.amount_cents, 0))]);
      }
      const ws5 = XLSX.utils.aoa_to_sheet(s5);
      ws5["!cols"] = [{ wch: 8 }, { wch: 12 }, { wch: 14 }, ...Array.from({ length: 13 }, () => ({ wch: 10 }))];
      XLSX.utils.book_append_sheet(wb, ws5, "月份x项目");

      // ---------- 生成文件 ----------
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const filename = `记账_${label}_${stamp}.xlsx`;
      XLSX.writeFile(wb, filename);
      App.toast(`已导出 ${filename}（${records.length} 笔记录）`);
    } catch (e) {
      App.fail(e, "导出失败");
    }
  },
};
