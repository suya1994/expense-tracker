// ============================================================
// Excel / CSV 导入（SheetJS / xlsx）
// 列与「导出全部」Sheet1 对齐：日期 / 大类 / 项目 / 小项(可空) / 金额(元) / 备注
// 兼容：.xlsx .xls .csv；多种日期格式；金额带 ¥/逗号/「元」；
//       表头自动识别（也支持支付宝/微信账单常用的「支出」列）；
//       合计行自动跳过；分类/项目/小项按名字匹配，不存在的自动创建；
//       可按 日期+分类+项目+小项+金额+备注 去重，防止重复导入同一文件。
// ============================================================
const ImportExcel = {

  /**
   * 解析文件（不写库）
   * @returns {Promise<{fileName:string, sheetName:string, rows:Array, errors:Array}>}
   *   rows: {date:'YYYY-MM-DD', category:string, item:string, amount_cents:int, note:string}
   *   errors: {row:int, msg:string}
   */
  async parseFile(file) {
    if (!window.XLSX) { throw new Error("Excel 组件未加载，请检查网络"); }
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      // CSV 统一按 UTF-8 文本读：无 BOM 的 CSV 在 array 模式下会被 SheetJS
      // 按 Latin-1 解码，中文全部乱码（表头匹配失败 → 整文件不可识别）
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch (e) { text = new TextDecoder("utf-8").decode(buf); }
      wb = XLSX.read(text, { type: "string", cellDates: true });
    } else {
      wb = XLSX.read(buf, { type: "array", cellDates: true });
    }
    const wsName = wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    // raw:true 拿原始值（日期是 Date 对象 / Excel 序列号，金额是数字），自己解析最可控
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });

    // ---- 找第一行非空行，识别表头 ----
    let headerRow = -1;
    let hasHeader = false;
    const cell = (row, i) => {
      const v = aoa[row] && aoa[row][i];
      return v === null || v === undefined ? "" : String(v).trim();
    };
    const isBlankRow = r => (aoa[r] || []).every(v => v === "" || v === null || v === undefined);
    for (let r = 0; r < aoa.length; r++) {
      if (isBlankRow(r)) continue;
      const names = aoa[r].map(v => String(v ?? "").trim().toLowerCase());
      const head = {
        date: names.findIndex(n => /^(日期|交易日期|date|时间|交易时间)$/.test(n)),
        amount: names.findIndex(n => /^(金额|金额\(元\)|金额（元）|支出|amount|money)$/.test(n)),
        category: names.findIndex(n => /^(大类|分类|类别|交易分类|category)$/.test(n)),
        item: names.findIndex(n => /^(项目|类目|子类|名称|item)$/.test(n)),
        subitem: names.findIndex(n => /^(小项|子项|明细|subitem)$/.test(n)),
        note: names.findIndex(n => /^(备注|说明|描述|摘要|note)$/.test(n)),
      };
      const anyMatched = head.date >= 0 || head.amount >= 0 || head.category >= 0;
      if (anyMatched) { headerRow = r; hasHeader = true; break; }
      headerRow = r; // 无表头，数据从这一行开始
      break;
    }
    if (headerRow < 0) return { fileName: file.name, sheetName: wsName, rows: [], errors: [{ row: 1, msg: "文件为空" }] };

    // ---- 实际列索引：有表头按名称匹配，无表头按固定列序 日期/大类/项目/金额/备注（小项仅在有表头时识别）----
    const names0 = hasHeader ? aoa[headerRow].map(v => String(v ?? "").trim().toLowerCase()) : [];
    const findH = re => names0.findIndex(n => re.test(n));
    const C = {
      date: hasHeader ? findH(/^(日期|交易日期|date|时间|交易时间)$/) : 0,
      amount: hasHeader ? findH(/^(金额|金额\(元\)|金额（元）|支出|amount|money)$/) : 3,
      category: hasHeader ? findH(/^(大类|分类|类别|交易分类|category)$/) : 1,
      item: hasHeader ? findH(/^(项目|类目|子类|名称|item)$/) : 2,
      subitem: hasHeader ? findH(/^(小项|子项|明细|subitem)$/) : -1,
      note: hasHeader ? findH(/^(备注|说明|描述|摘要|note)$/) : 4,
    };
    const rows = [];
    const errors = [];
    for (let r = headerRow + (hasHeader ? 1 : 0); r < aoa.length; r++) {
      if (isBlankRow(r)) continue;
      const rowNo = r + 1;
      // 合计/小计行跳过（导出文件里「合计」在日期列，金额列为空）
      const dateRaw0 = C.date >= 0 ? aoa[r][C.date] : "";
      const amtRaw = C.amount >= 0 ? aoa[r][C.amount] : "";
      if (/^(合计|总计|小计|total|sum)$/i.test(String(dateRaw0 ?? "").trim()) ||
          /^(合计|总计|小计|total|sum)$/i.test(String(amtRaw ?? "").trim())) continue;

      const dateRaw = C.date >= 0 ? aoa[r][C.date] : "";
      const date = parseDateCell(dateRaw);
      if (!date) { errors.push({ row: rowNo, msg: "日期无法识别" }); continue; }

      const cents = parseMoneyToCents(amtRaw);
      if (cents === null) { errors.push({ row: rowNo, msg: "金额无效或不是正数" }); continue; }

      const category = (C.category >= 0 ? cell(r, C.category) : "").trim();
      if (!category) { errors.push({ row: rowNo, msg: "缺少大类" }); continue; }

      let item = (C.item >= 0 ? cell(r, C.item) : "").trim();
      if (!item) item = "其他";
      const subitem = (C.subitem >= 0 ? cell(r, C.subitem) : "").trim(); // 可空
      const note = C.note >= 0 ? cell(r, C.note) : "";

      rows.push({ date, category, item, subitem, amount_cents: cents, note });
    }
    // 文件内「完全相同」记录统计（去重只针对与库中已有记录，不影响文件内部真实重复）
    const dupCount = new Map();
    for (const r of rows) {
      const k = `${r.date}|${r.category}|${r.item}|${r.subitem}|${r.amount_cents}|${r.note.trim().toLowerCase()}`;
      dupCount.set(k, (dupCount.get(k) || 0) + 1);
    }
    const dupRows = [...dupCount.values()].filter(n => n > 1).reduce((a, n) => a + n - 1, 0);
    return { fileName: file.name, sheetName: wsName, rows, errors, dupRows };
  },

  /**
   * 预览（同步，基于 App.cache）：统计有效笔数/金额、重复数量、将新建的分类/项目/小项
   */
  buildPreview(parsed) {
    const cats = App.cache.categories;
    const items = App.cache.items;
    const subs = App.cache.subitems || [];
    const catByName = new Map(cats.map(c => [c.name, c]));
    const itemKey = (cId, name) => cId + "|" + name;
    const itemByName = new Map(items.map(i => [itemKey(i.category_id, i.name), i]));
    const subKey = (iId, name) => iId + "|" + name;
    const subByKey = new Map(subs.map(s => [subKey(s.item_id, s.name), s]));

    const newCats = [];
    const newItems = new Set();
    const newSubs = new Set();
    let total = 0;
    for (const row of parsed.rows) {
      const cat = catByName.get(row.category);
      if (!cat) {
        if (!newCats.includes(row.category)) newCats.push(row.category);
        newItems.add(row.category + "|" + row.item); // 分类不存在，其下项目必然也是新建
        total += row.amount_cents;
        continue;
      }
      const key = itemKey(cat.id, row.item);
      const item = itemByName.get(key);
      if (!item) {
        newItems.add(row.category + "|" + row.item);
        total += row.amount_cents;
        continue;
      }
      if (row.subitem && !subByKey.get(subKey(item.id, row.subitem))) {
        newSubs.add(row.category + "|" + row.item + "|" + row.subitem);
      }
      total += row.amount_cents;
    }
    return {
      total: parsed.rows.length,
      sumCents: total,
      newCats,
      newItems: newItems.size, // 新建项目数（含新分类下的项目）
      newSubs: newSubs.size,   // 新建小项数
    };
  },

  /**
   * 统计与库中已有记录「完全相同」的行数与金额（预览时联动去重开关实时显示）
   * 键与 doImport 完全一致：日期+分类+项目+小项+金额+备注（分类/项目/小项按 id 匹配，
   * 新建的分类/项目/小项不可能与已有记录重复，直接跳过）
   * @returns {Promise<{count:int, sumCents:int}>}
   */
  async countLibraryDupes(parsed) {
    const rows = parsed.rows || [];
    if (!rows.length) return { count: 0, sumCents: 0 };
    const existing = await Store.getExpenses({});
    if (!existing.length) return { count: 0, sumCents: 0 };
    const keyOf = r => `${r.expense_date}|${r.category_id}|${r.item_id}|${r.subitem_id || ""}|${r.amount_cents}|${(r.note || "").trim().toLowerCase()}`;
    const keySet = new Set(existing.map(keyOf));
    const catByName = new Map(App.cache.categories.map(c => [c.name, c]));
    const itemKey = (cId, name) => cId + "|" + name;
    const itemByName = new Map(App.cache.items.map(i => [itemKey(i.category_id, i.name), i]));
    const subKey = (iId, name) => iId + "|" + name;
    const subByKey = new Map((App.cache.subitems || []).map(s => [subKey(s.item_id, s.name), s]));
    let count = 0, sumCents = 0;
    for (const row of rows) {
      const cat = catByName.get(row.category);
      if (!cat) continue;              // 新分类 → 必不重复
      const item = itemByName.get(itemKey(cat.id, row.item));
      if (!item) continue;             // 新项目 → 必不重复
      const sub = row.subitem ? subByKey.get(subKey(item.id, row.subitem)) : null;
      if (row.subitem && !sub) continue; // 新小项 → 必不重复
      const k = `${row.date}|${cat.id}|${item.id}|${sub ? sub.id : ""}|${row.amount_cents}|${row.note.trim().toLowerCase()}`;
      if (keySet.has(k)) { count++; sumCents += row.amount_cents; }
    }
    return { count, sumCents };
  },

  /**
   * 执行导入：自动创建缺失分类/项目/小项 → 去重 → 批量写记录
   * @param opts.dedupe 是否按 日期+分类+项目+小项+金额+备注 去重（默认 true）
   * @returns {Promise<{imported:int, skipped:int, skippedDup:int, skippedInvalid:int}>}
   */
  async doImport(parsed, opts = {}) {
    const dedupe = opts.dedupe !== false;
    await App.refreshMeta();
    const cats = App.cache.categories;
    const items = App.cache.items;
    const subs = App.cache.subitems || [];
    const catByName = new Map(cats.map(c => [c.name, c]));
    const itemKey = (cId, name) => cId + "|" + name;
    const itemByName = new Map(items.map(i => [itemKey(i.category_id, i.name), i]));
    const subKey = (iId, name) => iId + "|" + name;
    const subByKey = new Map(subs.map(s => [subKey(s.item_id, s.name), s]));

    // 1) 分类/项目/小项映射（缺失的自动创建）
    const expenses = [];
    const skipErrors = [];
    for (const row of parsed.rows) {
      try {
        let cat = catByName.get(row.category);
        if (!cat) {
          cat = await Store.addCategory(row.category);
          catByName.set(cat.name, cat);
        }
        let item = itemByName.get(itemKey(cat.id, row.item));
        if (!item) {
          item = await Store.addItem(cat.id, row.item);
          itemByName.set(itemKey(item.category_id, item.name), item);
        }
        let sub = null;
        if (row.subitem) {
          sub = subByKey.get(subKey(item.id, row.subitem));
          if (!sub) {
            sub = await Store.addSubitem(item.id, row.subitem);
            subByKey.set(subKey(sub.item_id, sub.name), sub);
          }
        }
        expenses.push({
          expense_date: row.date,
          category_id: cat.id,
          item_id: item.id,
          subitem_id: sub ? sub.id : null,
          amount_cents: row.amount_cents,
          note: row.note,
        });
      } catch (e) {
        skipErrors.push(`${row.date} ${row.category}/${row.item}${row.subitem ? "/" + row.subitem : ""}：${e.message || e}`);
      }
    }

    // 2) 去重：只跳过「与库中已有记录完全相同」的（键含分类+项目+小项，更精确）；
    //    文件内部重复保留——同一天相同金额的消费（如宠物医疗 75×2）是真实记录，不误吞
    let skippedDup = 0;
    let toInsert = expenses;
    if (dedupe && expenses.length) {
      const existing = await Store.getExpenses({});
      const keyOf = r => `${r.expense_date}|${r.category_id}|${r.item_id}|${r.subitem_id || ""}|${r.amount_cents}|${(r.note || "").trim().toLowerCase()}`;
      const keySet = new Set(existing.map(keyOf));
      const kept = [];
      for (const e of expenses) {
        if (keySet.has(keyOf(e))) { skippedDup++; }
        else { kept.push(e); }
      }
      toInsert = kept;
    }

    // 3) 批量写入
    const imported = toInsert.length ? await Store.bulkAddExpenses(toInsert) : 0;
    return {
      imported,
      skipped: skippedDup + skipErrors.length + parsed.errors.length,
      skippedDup,
      skippedInvalid: skipErrors.length + parsed.errors.length,
      details: skipErrors,
    };
  },
};

// ---------------- 内部工具 ----------------

/** Date → YYYY-MM-DD（本地时区） */
function fmtDateLocal(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Excel 日期序列号 → YYYY-MM-DD（Excel 纪元 1899-12-30，按 UTC 换算避免时区偏移） */
function excelSerialToDate(serial) {
  const ms = (Math.floor(serial) - 25569) * 86400 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** 解析日期单元格：Date 对象 / Excel 序列号 / 多种字符串格式 → YYYY-MM-DD 或 null */
function parseDateCell(v) {
  if (v instanceof Date && !isNaN(v)) return fmtDateLocal(v);
  if (typeof v === "number" && isFinite(v) && v > 20000 && v < 60000) return excelSerialToDate(v);
  // 去掉首尾空白（含 BOM、全角空格、零宽空格），否则正则 ^ 会失败
  let s = String(v).replace(/^[\s\uFEFF\u3000\u200B]+|[\s\uFEFF\u3000\u200B]+$/g, "");
  if (!s) return null;
  let y, mo, d;
  // 2026-01-02 12:30 / 2026/1/2 / 2026.1.2 / 2026年1月2日
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) { y = parseInt(m[1], 10); mo = parseInt(m[2], 10); d = parseInt(m[3], 10); }
  else {
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/); // 20260102
    if (m) { y = parseInt(m[1], 10); mo = parseInt(m[2], 10); d = parseInt(m[3], 10); }
    else return null;
  }
  if (!(y >= 1900 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const chk = new Date(y, mo - 1, d);
  if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 解析金额为「分」：数字或字符串（支持 ¥、逗号、「元」），必须为正数，否则 null */
function parseMoneyToCents(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (!isFinite(v) || v <= 0) return null;
    return Math.round(v * 100);
  }
  let s = String(v).trim().replace(/[¥￥,\s元]/g, "");
  if (s.startsWith("-")) return null; // 负数视为无效（本应用只记支出）
  s = s.replace(/^\+/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [intPart, decPart = ""] = s.split(".");
  const cents = parseInt(intPart, 10) * 100 + parseInt((decPart + "00").slice(0, 2), 10);
  return cents > 0 ? cents : null;
}
