// 年 / 月 / 日 粒度的日期区间计算。
// 内部用“序数日”（UTC 纪元起的天数）表示具体日期，便于做严格先后比较。

export const DAY_MS = 86_400_000;

/** 公历日期 -> 序数日 */
export function ordinal(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** 序数日 -> UTC 年月日 */
export function fromOrdinal(o) {
  const d = new Date(o * DAY_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** 某年某月的天数（month 为 1..12，自动处理闰年） */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 主张覆盖的闭区间 [lo, hi]（序数日） */
export function claimInterval({ year, month, day, precision }) {
  if (precision === 'day') {
    const o = ordinal(year, month, day);
    return { lo: o, hi: o };
  }
  if (precision === 'month') {
    return {
      lo: ordinal(year, month, 1),
      hi: ordinal(year, month, daysInMonth(year, month)),
    };
  }
  return {
    lo: ordinal(year, 1, 1),
    hi: ordinal(year, 12, 31),
  };
}

/** 序数日格式化为 YYYY-MM-DD */
export function formatOrdinal(o) {
  const { year, month, day } = fromOrdinal(o);
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}`;
}

/** 按主张自身粒度显示：1937年 / 1937年7月 / 1937年7月7日 */
export function formatClaim({ year, month, day, precision }) {
  if (precision === 'day') return `${year}年${month}月${day}日`;
  if (precision === 'month') return `${year}年${month}月`;
  return `${year}年`;
}

/**
 * 校验并归一化录入的年/月/日。
 * 输入：year 必填；month、day 可空；精度由所填字段推断。
 * 返回 { precision, year, month, day } 或 { error }。
 */
export function normalizeClaimDate(input) {
  let { year, month, day } = input ?? {};
  if (year === null || year === undefined || year === '') {
    return { error: '年份为必填项' };
  }
  year = Number(year);
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return { error: '年份必须是 1 到 9999 之间的整数' };
  }

  const empty = (v) => v === null || v === undefined || v === '';

  if (empty(month)) {
    if (!empty(day)) return { error: '填写了日期但未填写月份' };
    return { precision: 'year', year, month: null, day: null };
  }
  month = Number(month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: '月份必须是 1 到 12 之间的整数' };
  }

  if (empty(day)) {
    return { precision: 'month', year, month, day: null };
  }
  day = Number(day);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return { error: '日期必须是 1 到 31 之间的整数' };
  }
  if (day > daysInMonth(year, month)) {
    return { error: `${year}年${month}月没有${day}日` };
  }
  return { precision: 'day', year, month, day };
}
