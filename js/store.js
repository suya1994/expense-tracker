// ============================================================
// 存储层：全部直连 Supabase，无本地缓存
// 所有金额均为整数「分」，避免浮点误差。
// ============================================================
const Store = (() => {

  let sb = null;
  let connError = null;

  // ---------------- Supabase 适配器 ----------------
  const db = {
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
      const buildQ = () => {
        let q = sb.from("expenses").select("*");
        if (f.from) q = q.gte("expense_date", f.from);
        if (f.to) q = q.lte("expense_date", f.to);
        if (f.categoryId) q = q.eq("category_id", f.categoryId);
        if (f.itemId) q = q.eq("item_id", f.itemId);
        if (f.subitemId) q = q.eq("subitem_id", f.subitemId);
        if (f.keyword) q = q.ilike("note", `%${f.keyword}%`);
        return q;
      };
      let all = [];
      let from = 0;
      const size = 1000;
      while (true) {
        const { data, error } = await buildQ().range(from, from + size - 1).order("expense_date", { ascending: false }).order("created_at", { ascending: false });
        if (error) throw error;
        if (!data || !data.length) break;
        all = all.concat(data);
        if (data.length < size) break;
        from += size;
      }
      return all;
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
    async deleteExpensesByRange(from, to) {
      const { data, error } = await sb.from("expenses").delete().gte("expense_date", from).lte("expense_date", to).select("id");
      if (error) throw error;
      return (data || []).length;
    },
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
    async getBudgetTemplate() {
      const { data, error } = await sb.from("budget_templates").select("data, updated_at").eq("year", 0).maybeSingle();
      if (error) throw error;
      return data;
    },
    async setBudgetTemplate(data) {
      const { error } = await sb.from("budget_templates").upsert({ year: 0, data, updated_at: new Date().toISOString() }, { onConflict: "year" });
      if (error) throw error;
    },
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
  //  对外 API：全部直连 Supabase
  // ================================================================
  return {
    get connError() { return connError; },

    async init() {
      if (!window.supabase || typeof CONFIG !== "object" ||
          !CONFIG.supabaseUrl || !CONFIG.supabaseKey ||
          String(CONFIG.supabaseUrl).includes("YOUR_")) {
        connError = "未配置 Supabase，请在 js/config.js 中填写 supabaseUrl 和 supabaseKey";
        return;
      }
      try {
        sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
      } catch (e) {
        connError = e.message || String(e);
      }
    },

    async getCategories(includeInactive) { return db.getCategories(includeInactive); },
    async getItems(includeInactive) { return db.getItems(includeInactive); },
    async getSubitems(includeInactive) { return db.getSubitems(includeInactive); },
    async getExpenses(f) { return db.getExpenses(f); },
    async getBudgets(year) { return db.getBudgets(year); },
    async getBudgetTemplate() { return db.getBudgetTemplate(); },

    async addCategory(name) { return db.addCategory(name); },
    async updateCategory(id, patch) { return db.updateCategory(id, patch); },
    async addItem(categoryId, name) { return db.addItem(categoryId, name); },
    async updateItem(id, patch) { return db.updateItem(id, patch); },
    async addSubitem(itemId, name) { return db.addSubitem(itemId, name); },
    async updateSubitem(id, patch) { return db.updateSubitem(id, patch); },
    async deleteSubitem(id) { return db.deleteSubitem(id); },
    async addExpense(e) { return db.addExpense(e); },
    async updateExpense(id, patch) { return db.updateExpense(id, patch); },
    async deleteExpense(id) { return db.deleteExpense(id); },
    async deleteExpensesByRange(from, to) { return db.deleteExpensesByRange(from, to); },
    async setBudget(catId, year, month, amountCents) { return db.setBudget(catId, year, month, amountCents); },
    async deleteBudget(catId, year, month) { return db.deleteBudget(catId, year, month); },
    async setBudgetTemplate(data) { return db.setBudgetTemplate(data); },
    async bulkAddExpenses(rows) { return db.bulkAddExpenses(rows); },
    async deleteCategoryWithTransfer(catId, targetCatId) { return db.deleteCategoryWithTransfer(catId, targetCatId); },
    async deleteItemWithTransfer(itemId, targetItemId) { return db.deleteItemWithTransfer(itemId, targetItemId); },
  };
})();
