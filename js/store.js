// ============================================================
// 存储层：统一 API，两种实现 + 缓存同步
//   1. Supabase 适配器（配置了 CONFIG 时启用）
//   2. 本地 localStorage 适配器（未配置时，方便试用）
//   3. 缓存层：所有读写优先 localStorage，后台同步 Supabase
// 所有金额均为整数「分」，避免浮点误差。
// ============================================================
const Store = (() => {

  let mode = "local";
  let sb = null;
  let connError = null;
  let _syncing = false;

  // ---------------- 本地适配器（保持原样）----------------
  const LS_KEYS = { cat: "et.categories", item: "et.category_items", sub: "et.subitems", exp: "et.expenses", bud: "et.budgets" };
  const LS_PENDING = "et.pending_ops";
  const LS_SYNCED = "et.last_synced";

  function lsRead(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
  }
  function lsWrite(key, arr) { localStorage.setItem(key, JSON.stringify(arr)); }
  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }
  function nextSort(arr) { return arr.reduce((m, x) => Math.max(m, x.sort_order || 0), 0) + 1; }

  function getPending() { return lsRead(LS_PENDING); }
  function savePending(ops) { lsWrite(LS_PENDING, ops); }
  function addPending(op) {
    const ops = getPending();
    ops.push(op);
    savePending(ops);
  }
  function todayKey() { return new Date().toISOString().slice(0, 10); }

  const local = {
    async getCategories(includeInactive) {
      const all = lsRead(LS_KEYS.cat).sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "zh"));
      return includeInactive ? all : all.filter(c => c.is_active);
    },
    async getItems(includeInactive) {
      const all = lsRead(LS_KEYS.item).sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "zh"));
      return includeInactive ? all : all.filter(i => i.is_active);
    },
    async addCategory(name) {
      const arr = lsRead(LS_KEYS.cat);
      const row = { id: uuid(), name, sort_order: nextSort(arr), is_active: true, created_at: new Date().toISOString() };
      arr.push(row); lsWrite(LS_KEYS.cat, arr);
      return row;
    },
    async updateCategory(id, patch) {
      const arr = lsRead(LS_KEYS.cat);
      const row = arr.find(c => c.id === id);
      if (!row) throw new Error("大类不存在");
      Object.assign(row, patch); lsWrite(LS_KEYS.cat, arr);
      return row;
    },
    async addItem(categoryId, name) {
      const arr = lsRead(LS_KEYS.item);
      const row = { id: uuid(), category_id: categoryId, name, sort_order: nextSort(arr), is_active: true, created_at: new Date().toISOString() };
      arr.push(row); lsWrite(LS_KEYS.item, arr);
      return row;
    },
    async updateItem(id, patch) {
      const arr = lsRead(LS_KEYS.item);
      const row = arr.find(i => i.id === id);
      if (!row) throw new Error("项目不存在");
      Object.assign(row, patch); lsWrite(LS_KEYS.item, arr);
      return row;
    },
    // ---------------- 小项（第三级，挂在项目下）----------------
    async getSubitems(includeInactive) {
      const all = lsRead(LS_KEYS.sub).sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "zh"));
      return includeInactive ? all : all.filter(s => s.is_active);
    },
    async addSubitem(itemId, name) {
      const items = lsRead(LS_KEYS.item);
      if (!items.some(i => i.id === itemId)) throw new Error("项目不存在");
      const arr = lsRead(LS_KEYS.sub);
      if (arr.some(s => s.item_id === itemId && s.name === name)) throw new Error("该项目下已存在同名小项");
      const row = { id: uuid(), item_id: itemId, name, sort_order: nextSort(arr), is_active: true, created_at: new Date().toISOString() };
      arr.push(row); lsWrite(LS_KEYS.sub, arr);
      return row;
    },
    async updateSubitem(id, patch) {
      const arr = lsRead(LS_KEYS.sub);
      const row = arr.find(s => s.id === id);
      if (!row) throw new Error("小项不存在");
      Object.assign(row, patch); lsWrite(LS_KEYS.sub, arr);
      return row;
    },
    /** 删除小项：名下记录的 subitem_id 置空（不删除记录），返回受影响笔数 */
    async deleteSubitem(id) {
      const exps = lsRead(LS_KEYS.exp);
      let moved = 0;
      for (const r of exps) {
        if (r.subitem_id === id) { r.subitem_id = null; r.updated_at = new Date().toISOString(); moved++; }
      }
      lsWrite(LS_KEYS.exp, exps);
      lsWrite(LS_KEYS.sub, lsRead(LS_KEYS.sub).filter(s => s.id !== id));
      return { moved };
    },
    async getExpenses(f = {}) {
      let arr = lsRead(LS_KEYS.exp);
      if (f.from) arr = arr.filter(r => r.expense_date >= f.from);
      if (f.to) arr = arr.filter(r => r.expense_date <= f.to);
      if (f.categoryId) arr = arr.filter(r => r.category_id === f.categoryId);
      if (f.itemId) arr = arr.filter(r => r.item_id === f.itemId);
      if (f.subitemId) arr = arr.filter(r => r.subitem_id === f.subitemId);
      if (f.keyword) {
        const kw = f.keyword.toLowerCase();
        arr = arr.filter(r => (r.note || "").toLowerCase().includes(kw));
      }
      arr.sort((a, b) => (b.expense_date.localeCompare(a.expense_date)) || ((b.created_at || "").localeCompare(a.created_at || "")));
      return arr;
    },
    async addExpense(e) {
      const arr = lsRead(LS_KEYS.exp);
      const row = { id: uuid(), amount_cents: e.amount_cents, expense_date: e.expense_date, category_id: e.category_id, item_id: e.item_id, subitem_id: e.subitem_id || null, note: e.note || "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      arr.push(row); lsWrite(LS_KEYS.exp, arr);
      return row;
    },
    async updateExpense(id, patch) {
      const arr = lsRead(LS_KEYS.exp);
      const row = arr.find(r => r.id === id);
      if (!row) throw new Error("记录不存在");
      Object.assign(row, patch, { updated_at: new Date().toISOString() });
      lsWrite(LS_KEYS.exp, arr);
      return row;
    },
    async deleteExpense(id) {
      lsWrite(LS_KEYS.exp, lsRead(LS_KEYS.exp).filter(r => r.id !== id));
      return true;
    },
    /** 按日期范围批量删除（删除本年/本月用）：一次读、一次写，返回删除笔数 */
    async deleteExpensesByRange(from, to) {
      const arr = lsRead(LS_KEYS.exp);
      const kept = arr.filter(r => !(r.expense_date >= from && r.expense_date <= to));
      lsWrite(LS_KEYS.exp, kept);
      return arr.length - kept.length;
    },
    // ---------------- 预算（大类 × 年 × 月）----------------
    async getBudgets(year) {
      return lsRead(LS_KEYS.bud).filter(b => b.year === year);
    },
    async setBudget(catId, year, month, amountCents) {
      const arr = lsRead(LS_KEYS.bud);
      const row = arr.find(b => b.category_id === catId && b.year === year && b.month === month);
      if (row) { row.amount_cents = amountCents; }
      else arr.push({ id: uuid(), category_id: catId, year, month, amount_cents: amountCents, created_at: new Date().toISOString() });
      lsWrite(LS_KEYS.bud, arr);
      return true;
    },
    async deleteBudget(catId, year, month) {
      const arr = lsRead(LS_KEYS.bud);
      const kept = arr.filter(b => !(b.category_id === catId && b.year === year && b.month === month));
      lsWrite(LS_KEYS.bud, kept);
      return arr.length - kept.length;
    },
    /** 批量新增记录（导入用）：一次读、一次写，比逐条 addExpense 快得多 */
    async bulkAddExpenses(rows) {
      if (!rows.length) return 0;
      const arr = lsRead(LS_KEYS.exp);
      const now = new Date().toISOString();
      for (const e of rows) {
        arr.push({
          id: uuid(),
          amount_cents: e.amount_cents,
          expense_date: e.expense_date,
          category_id: e.category_id,
          item_id: e.item_id,
          subitem_id: e.subitem_id || null,
          note: e.note || "",
          created_at: now,
          updated_at: now,
        });
      }
      lsWrite(LS_KEYS.exp, arr);
      return rows.length;
    },
    /**
     * 删除大类（含转移）：
     * - 无消费记录：直接删除该大类及其下所有项目
     * - 有消费记录：先把记录 category_id 改为 targetCatId，
     *   item_id 映射到目标大类同名项目（无同名则归入「其他」，自动创建），
     *   再删除原大类及其项目。历史数据不丢。
     */
    async deleteCategoryWithTransfer(catId, targetCatId) {
      let cats = lsRead(LS_KEYS.cat);
      let items = lsRead(LS_KEYS.item);
      let exps = lsRead(LS_KEYS.exp);
      if (!cats.some(c => c.id === catId)) throw new Error("大类不存在");
      const affected = exps.filter(r => r.category_id === catId);
      if (affected.length) {
        if (!targetCatId) throw new Error("该大类下有消费记录，必须指定转移目标");
        if (!cats.some(c => c.id === targetCatId)) throw new Error("目标大类不存在");
        let other = items.find(i => i.category_id === targetCatId && i.name === "其他");
        if (!other) {
          other = { id: uuid(), category_id: targetCatId, name: "其他", sort_order: nextSort(items), is_active: true, created_at: new Date().toISOString() };
          items.push(other);
        }
        const myItems = items.filter(i => i.category_id === catId);
        for (const r of affected) {
          const src = myItems.find(i => i.id === r.item_id);
          const name = src ? src.name : "其他";
          const same = items.find(i => i.category_id === targetCatId && i.name === name);
          r.category_id = targetCatId;
          r.item_id = (same || other).id;
          r.subitem_id = null;
          r.updated_at = new Date().toISOString();
        }
      }
      lsWrite(LS_KEYS.item, items.filter(i => i.category_id !== catId));
      lsWrite(LS_KEYS.cat, cats.filter(c => c.id !== catId));
      lsWrite(LS_KEYS.exp, exps);
      lsWrite(LS_KEYS.bud, lsRead(LS_KEYS.bud).filter(b => b.category_id !== catId));
      const catItemIds = new Set(items.filter(i => i.category_id === catId).map(i => i.id));
      if (catItemIds.size) lsWrite(LS_KEYS.sub, lsRead(LS_KEYS.sub).filter(s => !catItemIds.has(s.item_id)));
      return { moved: affected.length };
    },
    /**
     * 删除具体项目（含转移）：
     * - 无消费记录：直接删除
     * - 有消费记录：item_id 改为 targetItemId；
     *   未指定 targetItemId 时自动在同大类创建「其他」项目承接
     */
    async deleteItemWithTransfer(itemId, targetItemId) {
      let items = lsRead(LS_KEYS.item);
      let exps = lsRead(LS_KEYS.exp);
      const item = items.find(i => i.id === itemId);
      if (!item) throw new Error("项目不存在");
      const affected = exps.filter(r => r.item_id === itemId);
      if (affected.length) {
        let target = targetItemId ? items.find(i => i.id === targetItemId) : null;
        if (!target) {
          target = items.find(i => i.category_id === item.category_id && i.name === "其他");
        }
        if (!target) {
          target = { id: uuid(), category_id: item.category_id, name: "其他", sort_order: nextSort(items), is_active: true, created_at: new Date().toISOString() };
          items.push(target);
        }
        for (const r of affected) {
          r.item_id = target.id;
          r.subitem_id = null;
          r.updated_at = new Date().toISOString();
        }
      }
      lsWrite(LS_KEYS.exp, exps);
      lsWrite(LS_KEYS.item, items.filter(i => i.id !== itemId));
      lsWrite(LS_KEYS.sub, lsRead(LS_KEYS.sub).filter(s => s.item_id !== itemId));
      return { moved: affected.length };
    },
  };

  // ---------------- Supabase 适配器（保持原样）----------------
  const supabaseAdapter = {
    async getCategories(includeInactive) {
      let q = sb.from("categories").select("*").order("sort_order").order("name");
      if (!includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async getItems(includeInactive) {
      let q = sb.from("category_items").select("*").order("sort_order").order("name");
      if (!includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async addCategory(name) {
      const { data, error } = await sb.from("categories").insert({ name }).select().single();
      if (error) throw error;
      return data;
    },
    async updateCategory(id, patch) {
      const { data, error } = await sb.from("categories").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    async addItem(categoryId, name) {
      const { data, error } = await sb.from("category_items").insert({ category_id: categoryId, name }).select().single();
      if (error) throw error;
      return data;
    },
    async updateItem(id, patch) {
      const { data, error } = await sb.from("category_items").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    // ---------------- 小项（第三级，挂在项目下）----------------
    async getSubitems(includeInactive) {
      let q = sb.from("sub_items").select("*").order("sort_order").order("name");
      if (!includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async addSubitem(itemId, name) {
      const { data, error } = await sb.from("sub_items").insert({ item_id: itemId, name }).select().single();
      if (error) throw error;
      return data;
    },
    async updateSubitem(id, patch) {
      const { data, error } = await sb.from("sub_items").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    async deleteSubitem(id) {
      const { data, error: e1 } = await sb.from("expenses").update({ subitem_id: null }).eq("subitem_id", id).select("id");
      if (e1) throw e1;
      const moved = (data || []).length;
      const { error: e2 } = await sb.from("sub_items").delete().eq("id", id);
      if (e2) throw e2;
      return { moved };
    },
    async getExpenses(f = {}) {
      let q = sb.from("expenses").select("*");
      if (f.from) q = q.gte("expense_date", f.from);
      if (f.to) q = q.lte("expense_date", f.to);
      if (f.categoryId) q = q.eq("category_id", f.categoryId);
      if (f.itemId) q = q.eq("item_id", f.itemId);
      if (f.subitemId) q = q.eq("subitem_id", f.subitemId);
      if (f.keyword) q = q.ilike("note", `%${f.keyword}%`);
      const { data, error } = await q.order("expense_date", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async addExpense(e) {
      const { data, error } = await sb.from("expenses").insert({
        amount_cents: e.amount_cents, expense_date: e.expense_date,
        category_id: e.category_id, item_id: e.item_id,
        subitem_id: e.subitem_id || null, note: e.note || "",
      }).select().single();
      if (error) throw error;
      return data;
    },
    async updateExpense(id, patch) {
      const { data, error } = await sb.from("expenses").update(patch).eq("id", id).select().single();
      if (error) throw error;
      return data;
    },
    async deleteExpense(id) {
      const { error } = await sb.from("expenses").delete().eq("id", id);
      if (error) throw error;
      return true;
    },
    /** 按日期范围批量删除：delete 返回被删行数 */
    async deleteExpensesByRange(from, to) {
      const { data, error } = await sb.from("expenses").delete().gte("expense_date", from).lte("expense_date", to).select("id");
      if (error) throw error;
      return (data || []).length;
    },
    // ---------------- 预算（大类 × 年 × 月）----------------
    async getBudgets(year) {
      const { data, error } = await sb.from("budgets").select("*").eq("year", year);
      if (error) throw error;
      return data || [];
    },
    async setBudget(catId, year, month, amountCents) {
      const { data, error } = await sb.from("budgets").upsert(
        { category_id: catId, year, month, amount_cents: amountCents },
        { onConflict: "category_id,year,month" }
      ).select().single();
      if (error) throw error;
      return data;
    },
    async deleteBudget(catId, year, month) {
      const { error } = await sb.from("budgets").delete()
        .eq("category_id", catId).eq("year", year).eq("month", month);
      if (error) throw error;
      return true;
    },
    /** 批量新增记录（导入用）：分批 upsert，避免单次请求体过大 */
    async bulkAddExpenses(rows) {
      const BATCH = 500;
      let n = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH).map(e => ({
          amount_cents: e.amount_cents,
          expense_date: e.expense_date,
          category_id: e.category_id,
          item_id: e.item_id,
          subitem_id: e.subitem_id || null,
          note: e.note || "",
        }));
        const { error } = await sb.from("expenses").insert(chunk);
        if (error) throw error;
        n += chunk.length;
      }
      return n;
    },
    /** 删除大类（含转移），逻辑同本地适配器 */
    async deleteCategoryWithTransfer(catId, targetCatId) {
      const { data: exps, error: e1 } = await sb.from("expenses").select("id, item_id").eq("category_id", catId);
      if (e1) throw e1;
      const moved = (exps || []).length;
      if (moved) {
        if (!targetCatId) throw new Error("该大类下有消费记录，必须指定转移目标");
        const { data: allItems, error: e2 } = await sb.from("category_items").select("id, category_id, name");
        if (e2) throw e2;
        let other = allItems.find(i => i.category_id === targetCatId && i.name === "其他");
        if (!other) {
          const { data: n, error: e3 } = await sb.from("category_items").insert({ category_id: targetCatId, name: "其他" }).select().single();
          if (e3) throw e3;
          other = n;
          allItems.push(other);
        }
        const updates = exps.map(r => {
          const src = allItems.find(i => i.id === r.item_id);
          const name = src ? src.name : "其他";
          const same = allItems.find(i => i.category_id === targetCatId && i.name === name);
          return { id: r.id, category_id: targetCatId, item_id: (same || other).id, subitem_id: null };
        });
        const { error: e4 } = await sb.from("expenses").upsert(updates);
        if (e4) throw e4;
      }
      const delItemIds = allItems.filter(i => i.category_id === catId).map(i => i.id);
      if (delItemIds.length) {
        const { error: e7 } = await sb.from("sub_items").delete().in("item_id", delItemIds);
        if (e7) throw e7;
      }
      const { error: e5 } = await sb.from("category_items").delete().eq("category_id", catId);
      if (e5) throw e5;
      const { error: e6 } = await sb.from("categories").delete().eq("id", catId);
      if (e6) throw e6;
      return { moved };
    },
    /** 删除具体项目（含转移），逻辑同本地适配器 */
    async deleteItemWithTransfer(itemId, targetItemId) {
      const { data: item, error: e0 } = await sb.from("category_items").select("category_id").eq("id", itemId).single();
      if (e0) throw new Error("项目不存在");
      const { data: exps, error: e1 } = await sb.from("expenses").select("id").eq("item_id", itemId);
      if (e1) throw e1;
      const moved = (exps || []).length;
      if (moved) {
        let target = null;
        if (targetItemId) {
          const { data: t, error: e2 } = await sb.from("category_items").select("id").eq("id", targetItemId).single();
          if (e2) throw new Error("目标项目不存在");
          target = t;
        }
        if (!target) {
          const { data: existing } = await sb.from("category_items").select("id").eq("category_id", item.category_id).eq("name", "其他").limit(1);
          if (existing && existing.length) target = existing[0];
        }
        if (!target) {
          const { data: n, error: e3 } = await sb.from("category_items").insert({ category_id: item.category_id, name: "其他" }).select().single();
          if (e3) throw e3;
          target = n;
        }
        const updates = exps.map(r => ({ id: r.id, item_id: target.id, subitem_id: null }));
        const { error: e4 } = await sb.from("expenses").upsert(updates);
        if (e4) throw e4;
      }
      const { error: e5 } = await sb.from("category_items").delete().eq("id", itemId);
      if (e5) throw e5;
      const { error: e6 } = await sb.from("sub_items").delete().eq("item_id", itemId);
      if (e6) throw e6;
      return { moved };
    },
  };

  // ================================================================
  //  缓存同步层：本地优先 + pending_ops + 后台同步
  // ================================================================

  /** 将本地待同步操作推送到 Supabase */
  async function flushPending() {
    const ops = getPending();
    if (!ops.length) return;
    const failed = [];
    for (const op of ops) {
      try {
        switch (op.op) {
          case "addExpense": await supabaseAdapter.addExpense(op.data); break;
          case "updateExpense": await supabaseAdapter.updateExpense(op.id, op.patch); break;
          case "deleteExpense": await supabaseAdapter.deleteExpense(op.id); break;
          case "deleteExpensesByRange": await supabaseAdapter.deleteExpensesByRange(op.from, op.to); break;
          case "bulkAddExpenses": await supabaseAdapter.bulkAddExpenses(op.rows); break;
          case "setBudget": await supabaseAdapter.setBudget(op.catId, op.year, op.month, op.amountCents); break;
          case "deleteBudget": await supabaseAdapter.deleteBudget(op.catId, op.year, op.month); break;
          case "addCategory": await supabaseAdapter.addCategory(op.name); break;
          case "updateCategory": await supabaseAdapter.updateCategory(op.id, op.patch); break;
          case "addItem": await supabaseAdapter.addItem(op.categoryId, op.name); break;
          case "updateItem": await supabaseAdapter.updateItem(op.id, op.patch); break;
          case "addSubitem": await supabaseAdapter.addSubitem(op.itemId, op.name); break;
          case "updateSubitem": await supabaseAdapter.updateSubitem(op.id, op.patch); break;
          case "deleteSubitem": await supabaseAdapter.deleteSubitem(op.id); break;
          case "deleteCategoryWithTransfer": await supabaseAdapter.deleteCategoryWithTransfer(op.catId, op.targetCatId); break;
          case "deleteItemWithTransfer": await supabaseAdapter.deleteItemWithTransfer(op.itemId, op.targetItemId); break;
        }
      } catch (e) {
        console.warn("[sync] pending op failed:", op.op, e.message);
        failed.push(op);
      }
    }
    savePending(failed);
  }

  /** 从 Supabase 全量拉取，替换本地缓存 */
  async function pullRemoteToCache() {
    const [cats, items, subs, exps, allBud] = await Promise.all([
      supabaseAdapter.getCategories(true),
      supabaseAdapter.getItems(true),
      supabaseAdapter.getSubitems(true),
      supabaseAdapter.getExpenses({}),
      (async () => {
        const currentYear = new Date().getFullYear();
        const lastYear = currentYear - 1;
        const [cy, ly] = await Promise.all([
          supabaseAdapter.getBudgets(currentYear),
          supabaseAdapter.getBudgets(lastYear),
        ]);
        return [...cy, ...ly];
      })(),
    ]);
    lsWrite(LS_KEYS.cat, cats);
    lsWrite(LS_KEYS.item, items);
    lsWrite(LS_KEYS.sub, subs);
    lsWrite(LS_KEYS.exp, exps);
    lsWrite(LS_KEYS.bud, allBud);
    localStorage.setItem(LS_SYNCED, todayKey());
  }

  /** 重试所有失败的 pending ops */
  async function retryPending() {
    const ops = getPending();
    if (!ops.length) return;
    await flushPending();
  }

  // ================================================================
  //  对外 API：所有读走本地缓存，所有写先本地后远程
  // ================================================================
  return {
    get mode() { return mode; },
    get connError() { return connError; },
    get pendingCount() { return getPending().length; },

    async init() {
      // 1. 检测 Supabase 连接
      if (window.supabase && typeof CONFIG === "object" &&
          CONFIG.supabaseUrl && CONFIG.supabaseKey &&
          !String(CONFIG.supabaseUrl).includes("YOUR_")) {
        try {
          sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
          const { error } = await sb.from("categories").select("id").limit(1);
          if (error) { connError = error.message; mode = "local"; }
          else { mode = "supabase"; }
        } catch (e) {
          connError = e.message || String(e);
          mode = "local";
        }
      }

      // 2. 检查本地是否有缓存
      const hasCache = lsRead(LS_KEYS.cat).length > 0 || lsRead(LS_KEYS.exp).length > 0;

      if (mode === "supabase") {
        if (!hasCache) {
          // 首次使用：从 Supabase 加载完整数据
          try {
            await pullRemoteToCache();
          } catch (e) {
            console.warn("[sync] 首次拉取失败:", e.message);
          }
        } else {
          // 有缓存：先渲染，后台同步
          const lastSynced = localStorage.getItem(LS_SYNCED);
          const syncedToday = lastSynced === todayKey();

          // 后台执行（不阻塞 init 返回）
          (async () => {
            try {
              _syncing = true;
              await flushPending();
              if (!syncedToday && getPending().length === 0) {
                await pullRemoteToCache();
              }
            } catch (e) {
              console.warn("[sync] 后台同步失败:", e.message);
            } finally {
              _syncing = false;
            }
          })();
        }
      }

      return mode;
    },

    // ---- 读取：始终走本地缓存 ----
    async getCategories(includeInactive) { return local.getCategories(includeInactive); },
    async getItems(includeInactive) { return local.getItems(includeInactive); },
    async getSubitems(includeInactive) { return local.getSubitems(includeInactive); },
    async getExpenses(f) { return local.getExpenses(f); },
    async getBudgets(year) { return local.getBudgets(year); },

    // ---- 写入：先本地 → 加 pending → 后台同步 ----
    async addCategory(name) {
      const row = await local.addCategory(name);
      addPending({ op: "addCategory", name });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async updateCategory(id, patch) {
      const row = await local.updateCategory(id, patch);
      addPending({ op: "updateCategory", id, patch });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async addItem(categoryId, name) {
      const row = await local.addItem(categoryId, name);
      addPending({ op: "addItem", categoryId, name });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async updateItem(id, patch) {
      const row = await local.updateItem(id, patch);
      addPending({ op: "updateItem", id, patch });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async addSubitem(itemId, name) {
      const row = await local.addSubitem(itemId, name);
      addPending({ op: "addSubitem", itemId, name });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async updateSubitem(id, patch) {
      const row = await local.updateSubitem(id, patch);
      addPending({ op: "updateSubitem", id, patch });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async deleteSubitem(id) {
      const result = await local.deleteSubitem(id);
      addPending({ op: "deleteSubitem", id });
      if (mode === "supabase") retryPending().catch(() => {});
      return result;
    },
    async addExpense(e) {
      const row = await local.addExpense(e);
      addPending({ op: "addExpense", data: e });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async updateExpense(id, patch) {
      const row = await local.updateExpense(id, patch);
      addPending({ op: "updateExpense", id, patch });
      if (mode === "supabase") retryPending().catch(() => {});
      return row;
    },
    async deleteExpense(id) {
      const result = await local.deleteExpense(id);
      addPending({ op: "deleteExpense", id });
      if (mode === "supabase") retryPending().catch(() => {});
      return result;
    },
    async deleteExpensesByRange(from, to) {
      const count = await local.deleteExpensesByRange(from, to);
      addPending({ op: "deleteExpensesByRange", from, to });
      if (mode === "supabase") retryPending().catch(() => {});
      return count;
    },
    async setBudget(catId, year, month, amountCents) {
      await local.setBudget(catId, year, month, amountCents);
      addPending({ op: "setBudget", catId, year, month, amountCents });
      if (mode === "supabase") retryPending().catch(() => {});
      return true;
    },
    async deleteBudget(catId, year, month) {
      await local.deleteBudget(catId, year, month);
      addPending({ op: "deleteBudget", catId, year, month });
      if (mode === "supabase") retryPending().catch(() => {});
      return true;
    },
    async bulkAddExpenses(rows) {
      const count = await local.bulkAddExpenses(rows);
      addPending({ op: "bulkAddExpenses", rows });
      if (mode === "supabase") retryPending().catch(() => {});
      return count;
    },
    async deleteCategoryWithTransfer(catId, targetCatId) {
      const result = await local.deleteCategoryWithTransfer(catId, targetCatId);
      addPending({ op: "deleteCategoryWithTransfer", catId, targetCatId });
      if (mode === "supabase") retryPending().catch(() => {});
      return result;
    },
    async deleteItemWithTransfer(itemId, targetItemId) {
      const result = await local.deleteItemWithTransfer(itemId, targetItemId);
      addPending({ op: "deleteItemWithTransfer", itemId, targetItemId });
      if (mode === "supabase") retryPending().catch(() => {});
      return result;
    },
  };
})();
