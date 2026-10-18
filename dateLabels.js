/** Friendly labels for 'YYYY-MM-DD' dates and 'YYYY-MM' months, in the device's language. */

import { localDateISO } from './groceryLogic.js';

function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** "today", "yesterday", "Mon, Oct 12" (the year is added for dates in another year). */
export function formatDateLabel(iso, now = new Date()) {
  if (!iso) return '';
  const todayISO = localDateISO(now);
  if (iso === todayISO) return 'today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (iso === localDateISO(y)) return 'yesterday';
  const date = parseISO(iso);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat(undefined, opts).format(date);
}

/** Heading for a day in a list: "Today", "Yesterday" or the dated label. */
export function formatDayHeading(iso, now = new Date()) {
  const s = formatDateLabel(iso, now);
  return s === 'today' || s === 'yesterday' ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "October 2026" for 'YYYY-MM'; a bare year ('2026') is returned as "All 2026". */
export function formatMonthLabel(key) {
  if (!key) return 'All time';
  if (key.length === 4) return 'All ' + key;
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

/** "Oct" for 'YYYY-MM' (chart labels). */
export function formatMonthShort(key) {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(y, m - 1, 1));
}
