-- ============================================================
-- 个人记账应用 · Supabase 数据库结构
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴执行
--
-- 核心设计决策：
-- 1. 金额用 bigint 存「分」（amount_cents），彻底避免浮点精度问题
-- 2. 分类删除采用「物理删除 + 数据转移」：删除分类/项目前，
--    应用层先把名下消费记录转移到用户指定的目标分类（同名项目映射，
--    无同名则归入目标分类的「其他」项目），历史消费永不丢失。
--    （is_active 字段保留用于记账选项过滤，兼容早期版本的停用数据）
-- 3. 消费记录通过外键关联分类，改分类名后历史记录自动显示新名称
-- 4. RLS 开启 + 对 anon key 放行（个人应用，URL/Key 自行保密即可）
-- 注意：外键均为 RESTRICT/NO ACTION，应用层必须先转移记录再删分类，
--       顺序错误会直接报外键冲突，这正好保护数据不被误删。
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- 大类 ----------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,   -- 记账选项过滤标记（删除由应用层转移数据后物理删除）
  created_at  timestamptz not null default now()
);

-- ---------- 具体项目（二级分类）----------
create table if not exists public.category_items (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.categories(id) on delete restrict,
  name         text not null,
  sort_order   integer not null default 0,
  is_active    boolean not null default true,  -- 记账选项过滤标记（删除由应用层转移数据后物理删除）
  created_at   timestamptz not null default now()
);

-- ---------- 小项（第三级分类，挂在项目下，可为空）----------
create table if not exists public.sub_items (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.category_items(id) on delete restrict,
  name        text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- 消费记录 ----------
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  amount_cents  bigint  not null check (amount_cents >= 0),  -- 金额（分）
  expense_date  date    not null default current_date,
  category_id   uuid    not null references public.categories(id),
  item_id       uuid    not null references public.category_items(id),
  note          text    not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 旧库升级：expenses 补小项列（新库执行也无副作用）
alter table public.expenses add column if not exists subitem_id uuid references public.sub_items(id);

-- ---------- 预算（大类 × 年 × 月，唯一的预算录入粒度）----------
-- 规则：月度预算 = 当月已设大类之和；年度预算不单独存（= 12 个月之和，算出来显示）。
-- 未设 = 无行（null，不参与计算）；0 = 明确禁花（花一分都算超支）。
-- 删除大类时预算跟着删（不转移）：on delete cascade。
create table if not exists public.budgets (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.categories(id) on delete cascade,
  year         integer not null,
  month        integer not null check (month between 1 and 12),
  amount_cents bigint  not null default 0,
  created_at   timestamptz not null default now()
);

-- 同一大类同年同月只有一条（应用层 upsert 依赖此唯一约束）
create unique index if not exists uq_budgets_cat_year_month
  on public.budgets (category_id, year, month);

-- ---------- 预算模版（每年一个，存各大类分配快照）----------
create table if not exists public.budget_templates (
  id           uuid primary key default gen_random_uuid(),
  year         integer not null unique,
  data         jsonb   not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- 索引：支撑按日期/月份/年份/分类统计查询 ----------
create index if not exists idx_expenses_date      on public.expenses (expense_date);
create index if not exists idx_expenses_category  on public.expenses (category_id);
create index if not exists idx_expenses_item      on public.expenses (item_id);
create index if not exists idx_expenses_subitem   on public.expenses (subitem_id);
create index if not exists idx_items_category     on public.category_items (category_id);
create index if not exists idx_subitems_item      on public.sub_items (item_id);

-- ---------- updated_at 自动维护 ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_expenses_updated on public.expenses;
create trigger trg_expenses_updated
  before update on public.expenses
  for each row execute function public.set_updated_at();

-- ---------- RLS ----------
-- 个人应用：开启 RLS，但对 anon key 全放行。
-- 前提：Supabase URL 和 anon key 不要公开分享。
-- 未来若要收紧，删掉这三条 policy 换成基于 auth.uid() 的策略即可。
alter table public.categories      enable row level security;
alter table public.category_items  enable row level security;
alter table public.sub_items       enable row level security;
alter table public.expenses        enable row level security;
alter table public.budgets         enable row level security;
alter table public.budget_templates enable row level security;

drop policy if exists "personal_app_all" on public.categories;
create policy "personal_app_all" on public.categories
  for all using (true) with check (true);

drop policy if exists "personal_app_all" on public.category_items;
create policy "personal_app_all" on public.category_items
  for all using (true) with check (true);

drop policy if exists "personal_app_all" on public.sub_items;
create policy "personal_app_all" on public.sub_items
  for all using (true) with check (true);

drop policy if exists "personal_app_all" on public.expenses;
create policy "personal_app_all" on public.expenses
  for all using (true) with check (true);

drop policy if exists "personal_app_all" on public.budgets;
create policy "personal_app_all" on public.budgets
  for all using (true) with check (true);

drop policy if exists "personal_app_all" on public.budget_templates;
create policy "personal_app_all" on public.budget_templates
  for all using (true) with check (true);

-- 旧库升级必须执行（新版 Supabase 通过 SQL 建表默认不给 anon 授权）：
grant usage on schema public to anon;
grant all on public.categories     to anon;
grant all on public.category_items to anon;
grant all on public.sub_items      to anon;
grant all on public.expenses       to anon;
grant all on public.budgets        to anon;
grant all on public.budget_templates to anon;

-- ---------- 初始分类数据（可选，也可以在前端页面自己建）----------
-- 若表为空则插入示例分类：
insert into public.categories (name, sort_order)
select '餐饮', 1 where not exists (select 1 from public.categories);
insert into public.categories (name, sort_order)
select '购物', 2 where (select count(*) from public.categories) = 1;
insert into public.categories (name, sort_order)
select '交通', 3 where (select count(*) from public.categories) = 2;

insert into public.category_items (category_id, name, sort_order)
select c.id, '早餐', 1 from public.categories c where c.name = '餐饮'
  and not exists (select 1 from public.category_items);
insert into public.category_items (category_id, name, sort_order)
select c.id, '午餐', 2 from public.categories c where c.name = '餐饮'
  and (select count(*) from public.category_items) = 1;
insert into public.category_items (category_id, name, sort_order)
select c.id, '日用', 1 from public.categories c where c.name = '购物'
  and (select count(*) from public.category_items) = 2;
