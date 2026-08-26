// ============================================================
// 格式化与工具函数（纯函数，无副作用）
// ============================================================

/** 解析用户输入的金额字符串为「分」（整数），非法返回 null */
function parseAmountToCents(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim().replace(/[¥￥,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [intPart, decPart = ""] = s.split(".");
  const cents = parseInt(intPart, 10) * 100 + parseInt((decPart + "00").slice(0, 2), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 分 → 元（数字，用于 Excel），除法安全：整数分 / 100 在 JS 中无精度损失（< 2^53） */
function centsToYuan(cents) {
  return cents / 100;
}

/** 分 → 展示字符串 ¥1,234.56 */
function fmtYuan(cents) {
  const n = cents / 100;
  return "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 带符号：+¥120.00 / -¥80.50 */
function fmtYuanSigned(cents) {
  const sign = cents >= 0 ? "+" : "-";
  return sign + fmtYuan(Math.abs(cents));
}

/** 紧凑显示（图表用）：123456分 → ¥1,234.56；12345600分 → ¥12.35万 */
function fmtCompact(cents) {
  const yuan = cents / 100;
  if (yuan >= 10000) {
    const w = yuan / 10000;
    return "¥" + (Math.round(w * 100) / 100) + "万";
  }
  return "¥" + yuan.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/** 百分比字符串 */
function fmtPct(p) {
  if (p === null || p === undefined || !isFinite(p)) return "—";
  return (p >= 0 ? "+" : "") + (Math.round(p * 10) / 10) + "%";
}

/** 今天 YYYY-MM-DD（本地时区） */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 月份区间 [起, 止] YYYY-MM-DD */
function monthRange(year, month) { // month: 1-12
  const last = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  return [`${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, "0")}`];
}

/** 年区间 [起, 止] */
function yearRange(year) {
  return [`${year}-01-01`, `${year}-12-31`];
}

/** 记录的 expense_date → {y, m} */
function ymOf(dateStr) {
  const [y, m] = dateStr.split("-");
  return { y: parseInt(y, 10), m: parseInt(m, 10) };
}

/** 记录 → YYYY-MM */
function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/** 汇总：总金额、笔数 */
function sumRecords(records) {
  let total = 0;
  for (const r of records) total += r.amount_cents;
  return { total, count: records.length };
}

/** 按 keyFn 分组汇总，返回 Map(key → {total, count, records}) */
function groupSum(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { total: 0, count: 0, records: [] });
    const g = map.get(k);
    g.total += r.amount_cents;
    g.count += 1;
    g.records.push(r);
  }
  return map;
}

/** 记录的 12 个月金额分布（分），索引 0=1月；无消费月为 0 */
function monthlyTotalsOf(records) {
  const totals = Array.from({ length: 12 }, () => 0);
  for (const r of records) totals[ymOf(r.expense_date).m - 1] += r.amount_cents;
  return totals;
}

// ============================================================
// 横向占比条（大类占比，比饼图更直观：比例一目了然，无需对照图例）
// items: [{label, value}]（value 单位为分）；按金额降序
// 每行：色块 + 名称 + 进度条（相对最大项）+ 金额 + 百分比（占总和）
// ============================================================
const CHART_COLORS = ["#5B8FF9", "#61DDAA", "#65789B", "#F6BD16", "#7262FD", "#78D3F8", "#9661BC", "#F6903D", "#008685", "#F08BB4"];

function ratioBarList(items) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (!total || !items.length) return "";
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const max = sorted[0].value;
  const rows = sorted.map((s, i) => {
    const pct = (s.value / total * 100).toFixed(1);
    const width = (s.value / max * 100).toFixed(1);
    const color = CHART_COLORS[i % CHART_COLORS.length];
    return `
      <div class="rbar-row">
        <i class="rbar-dot" style="background:${color}"></i>
        <span class="rbar-name" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
        <span class="rbar-track"><i class="rbar-fill" style="width:${width}%;background:${color}"></i></span>
        <span class="rbar-amt">${fmtYuan(s.value)}</span>
        <span class="rbar-pct">${pct}%</span>
      </div>`;
  }).join("");
  return `<div class="rbar-list">${rows}</div>`;
}

/** 收起容器内所有已展开的大类（含其内部项目图），并恢复其大类图显示；except 指定的大类跳过 */
function closeAllCatBlocks(container, except) {
  container.querySelectorAll(".cat-block.open").forEach(b => {
    if (except && b === except) return;
    b.classList.remove("open");
    b.querySelectorAll(".item-detail").forEach(d => d.remove());
    const cc = b.querySelector(".cat-chart");
    if (cc) cc.style.display = "";
  });
}

// ============================================================
// 轻量 SVG 柱状图（用于月度/年度对比，避免引入图表库）
// values: number[]（分）；labels: string[]
// opts.attachData: true → 每根柱子加 data-idx + class="bar-click"（供点击切换）
// opts.height: 图表高度（默认 220；大类/项目下钻用 150 紧凑版）
// ============================================================
function barChartSVG(values, labels, opts = {}) {
  const W = 680, H = opts.height || 220;
  const padL = 16, padR = 16;
  const padT = H >= 200 ? 34 : 26, padB = 30;
  const n = values.length;
  if (!n) return "";
  const max = Math.max(...values, 1);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const slot = innerW / n;
  const barW = Math.min(52, slot * 0.75);
  const highlight = opts.highlightIndex ?? -1;
  const accent = "var(--accent)", muted = "var(--bar-muted)";

  let bars = "";
  values.forEach((v, i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const h = v > 0 ? Math.max(3, (v / max) * innerH) : 2;
    const y = padT + innerH - h;
    const fill = i === highlight ? accent : muted;
    const clickAttr = opts.attachData ? ` data-idx="${i}" class="bar-click"` : "";
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${fill}"${clickAttr}><title>${escapeHtml(labels[i])}：${fmtYuan(v)}</title></rect>`;
    if (v > 0) {
      bars += `<text class="chart-bar-val" x="${(x + barW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)">${escapeHtml(fmtCompact(v))}</text>`;
    }
    bars += `<text class="chart-bar-label" x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="13" fill="var(--muted)">${escapeHtml(labels[i])}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="柱状图">
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="1"/>
    ${bars}
  </svg>`;
}
