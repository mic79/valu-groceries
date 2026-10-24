/**
 * Nutrition: pure logic (no browser, no network), so it can be unit tested.
 *
 * The group's "Nutrition" tab holds one row per product NAME that the group actually uses
 * (values per 100 g or 100 ml). It is filled from three sources, none of which needs a key or a server:
 *   built-in  a small table of common staples that ships with the app (applied automatically)
 *   AI        values the user asked an assistant of their choice for and pasted back (checked on import)
 *   manual    typed in by hand
 * Nothing is ever sent anywhere by the app itself.
 */

import { textCell, monthKey, localDateISO, defaultMeasure } from './groceryLogic.js';

export const NUTRITION_HEADERS = ['ID', 'Name', 'Kcal', 'Protein', 'Carbs', 'Fat', 'Category', 'Unit', 'GramsPerUnit', 'Source'];

export const NUTRITION_CATEGORIES = [
  'Fruit', 'Vegetables', 'Meat & fish', 'Dairy & eggs', 'Grains & bread', 'Legumes & nuts',
  'Oils & fats', 'Sweets & snacks', 'Drinks', 'Prepared foods', 'Other food', 'Non-food',
];
export const NON_FOOD = 'Non-food';
export const UNITS = ['g', 'ml', 'piece'];
export const UNIT_LABELS = { g: 'grams (g)', ml: 'millilitres (ml)', piece: 'pieces' };

// ── Names ─────────────────────────────────────────────────────────────────────

/** "Tomatoes" -> "tomato", "Berries" -> "berry", "Glass" stays "glass". Good enough to treat singular and plural alike. */
function stemWord(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && (w.endsWith('oes') || /(ch|sh|x|ss|z)es$/.test(w))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

/** Lower-case words of a product name (letters and digits only), singular. */
export function nameTokens(title) {
  return String(title ?? '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stemWord);
}

/** Key of a product name: "Organic Bananas" and "organic banana" are the same product. '' when there is no name. */
export function nutritionKey(title) {
  return nameTokens(title).join(' ');
}

const FILLER = new Set(['organic', 'fresh', 'frozen', 'large', 'small', 'big', 'baby', 'bio', 'raw', 'whole', 'the', 'a', 'of', 'and', 'pack', 'box']);

/**
 * Finds the entry for a product name in a Map(key -> entry): the exact name first, then the same name
 * without filler words ("organic"), then the last words of the name ("Spicy tomato sauce" -> "tomato sauce",
 * "Organic bananas" -> "banana"). Only the END of a name is used, so "apple pie" never becomes "apple".
 */
export function matchEntry(title, lookup) {
  const tokens = nameTokens(title);
  if (!tokens.length) return null;
  const exact = lookup.get(tokens.join(' '));
  if (exact) return exact;
  const core = tokens.filter((t) => !FILLER.has(t));
  if (core.length && core.length < tokens.length) {
    const hit = lookup.get(core.join(' '));
    if (hit) return hit;
  }
  for (let k = tokens.length - 1; k >= 1; k--) {
    const hit = lookup.get(tokens.slice(-k).join(' '));
    if (hit) return hit;
  }
  return null;
}

// ── Sheet rows ────────────────────────────────────────────────────────────────

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export function rowToNutrition(r) {
  const row = r || [];
  const unit = String(row[7] ?? '').trim().toLowerCase();
  return {
    id: String(row[0] ?? ''),
    name: String(row[1] ?? ''),
    kcal: num(row[2]) ?? 0,
    protein: num(row[3]) ?? 0,
    carbs: num(row[4]) ?? 0,
    fat: num(row[5]) ?? 0,
    category: String(row[6] ?? '').trim() || 'Other food',
    unit: UNITS.includes(unit) ? unit : 'g',
    gramsPerUnit: num(row[8]) > 0 ? num(row[8]) : 1,
    source: String(row[9] ?? '').trim(),
  };
}

export function nutritionToRow(e) {
  return [
    e.id || nutritionKey(e.name),
    textCell(e.name),
    round1(e.kcal), round1(e.protein), round1(e.carbs), round1(e.fat),
    e.category || 'Other food', e.unit || 'g', e.gramsPerUnit > 0 ? e.gramsPerUnit : 1, e.source || '',
  ];
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** Map(key -> entry) of the rows in the Nutrition tab. */
export function nutritionLookup(entries) {
  const map = new Map();
  for (const e of entries) if (e.id) map.set(e.id, e);
  return map;
}

// ── Quantity -> grams ─────────────────────────────────────────────────────────

/**
 * How many grams a purchase is. The quantity of an item is a plain number, so the entry says how to read it:
 *   piece  a small count of pieces (eggs 12, croissants 4): number × grams per piece. No quantity = one piece.
 *          A large number (50+) is treated as pack weight in grams — people often log "750" for a 750 g tub or
 *          "500" for a loaf even when the nutrition row still says "piece".
 *   g / ml the number is the amount itself (1 ml counts as 1 g). A very small number (under 10) with a known
 *          piece weight is read as pieces ("Tomatoes 4"); without one it is ambiguous (litres? kilos?) and skipped.
 * Returns null when the amount cannot be known.
 */
/** Quantity at or above this on a "piece" row is read as grams (tub / loaf / bag weight), not piece count. */
export const PIECE_QTY_AS_GRAMS_FROM = 50;

export function quantityToGrams(quantity, entry) {
  const q = parseFloat(String(quantity ?? '').replace(',', '.'));
  const hasQty = Number.isFinite(q) && q > 0;
  const gpu = entry.gramsPerUnit > 1 ? entry.gramsPerUnit : 0;
  if (entry.unit === 'piece') {
    if (!gpu) return null;
    // 750 g yogurt tub, 500 g loaf: not 750×100 g or 500×450 g.
    if (hasQty && q >= PIECE_QTY_AS_GRAMS_FROM) return q;
    return (hasQty ? q : 1) * gpu;
  }
  if (!hasQty) return null;
  if (q < 10) return gpu ? q * gpu : null;
  return q;
}

/** What one purchase contributes ({grams, kcal, protein, carbs, fat}), or null when the quantity is unknown. */
export function purchaseNutrition(item, entry) {
  const grams = quantityToGrams(item.quantity, entry);
  if (grams === null) return null;
  const f = grams / 100;
  return { grams, kcal: entry.kcal * f, protein: entry.protein * f, carbs: entry.carbs * f, fat: entry.fat * f };
}

// ── Statistics ────────────────────────────────────────────────────────────────

const emptyTotals = () => ({ grams: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 });
const addTo = (t, n) => { t.grams += n.grams; t.kcal += n.kcal; t.protein += n.protein; t.carbs += n.carbs; t.fat += n.fat; };

/** Days from `from` to the earlier of `to` and today, both included (at least 1). */
export function daysInRange(from, to, today = localDateISO()) {
  if (!from) return 1;
  const end = to && to < today ? to : today;
  const a = new Date(from + 'T12:00:00');
  const b = new Date(end + 'T12:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/**
 * Calories and macros of what was bought in a period (purchases = items with a CheckedDate).
 * `lookup` is Map(key -> entry). Everything that cannot be counted is reported, so the numbers stay honest:
 *   unmatched    products without nutrition data yet
 *   unquantified products with data but no usable quantity
 *   nonFood      purchases of non-food products (left out of everything)
 */
export function nutritionStats(items, lookup, range = { from: '', to: '' }, today = localDateISO()) {
  const total = emptyTotals();
  const cats = new Map();
  const products = new Map();
  const unmatched = new Map();
  const unquantified = new Map();
  let nonFood = 0;
  let counted = 0;
  let purchases = 0;

  for (const item of items) {
    const d = item.checkedDate;
    if (!d || (range.from && d < range.from) || (range.to && d > range.to)) continue;
    purchases++;
    const key = nutritionKey(item.title);
    const entry = matchEntry(item.title, lookup);
    if (!entry) {
      const cur = unmatched.get(key) || { key, title: item.title, count: 0 };
      cur.count++;
      unmatched.set(key, cur);
      continue;
    }
    if (entry.category === NON_FOOD) { nonFood++; continue; }
    const n = purchaseNutrition(item, entry);
    if (!n) {
      const cur = unquantified.get(entry.id) || { key: entry.id, title: entry.name || item.title, count: 0 };
      cur.count++;
      unquantified.set(entry.id, cur);
      continue;
    }
    counted++;
    addTo(total, n);
    const c = cats.get(entry.category) || { name: entry.category, ...emptyTotals(), count: 0, products: new Map() };
    addTo(c, n);
    c.count++;
    const cp = c.products.get(entry.id) || { key: entry.id, title: entry.name || item.title, ...emptyTotals(), count: 0 };
    addTo(cp, n);
    cp.count++;
    c.products.set(entry.id, cp);
    cats.set(entry.category, c);
    products.set(entry.id, cp);
  }

  const macroKcal = total.protein * 4 + total.carbs * 4 + total.fat * 9;
  const share = (g, k) => (macroKcal > 0 ? (g * k) / macroKcal : 0);
  const categories = [...cats.values()]
    .sort((a, b) => b.kcal - a.kcal)
    .map((c) => ({
      name: c.name, kcal: c.kcal, grams: c.grams, count: c.count, pct: total.kcal > 0 ? c.kcal / total.kcal : 0,
      products: [...c.products.values()].sort((a, b) => b.kcal - a.kcal),
    }));
  const sumCount = (m) => [...m.values()].reduce((s, u) => s + u.count, 0);
  const needing = counted + sumCount(unquantified) + sumCount(unmatched);
  const days = daysInRange(range.from || '', range.to || '', today);
  return {
    purchases, counted, nonFood, days,
    totals: total,
    perDay: total.kcal / days,
    share: { protein: share(total.protein, 4), carbs: share(total.carbs, 4), fat: share(total.fat, 9) },
    categories,
    products: [...products.values()].sort((a, b) => b.kcal - a.kcal),
    unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    unquantified: [...unquantified.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    coverage: needing > 0 ? counted / needing : 1,
  };
}

/** Calories bought per month, for the months given as 'YYYY-MM' keys. */
export function monthlyKcal(items, lookup, months) {
  return bucketKcal(items, lookup, months, monthKey);
}

/** Calories bought per calendar year, for the given years (['2024', '2025']). */
export function yearlyKcal(items, lookup, years) {
  return bucketKcal(items, lookup, years, (iso) => (iso && iso.length >= 4 ? iso.slice(0, 4) : ''));
}

function bucketKcal(items, lookup, months, keyOf) {
  const out = new Map(months.map((m) => [m, 0]));
  for (const item of items) {
    const m = keyOf(item.checkedDate);
    if (!out.has(m)) continue;
    const entry = matchEntry(item.title, lookup);
    if (!entry || entry.category === NON_FOOD) continue;
    const n = purchaseNutrition(item, entry);
    if (n) out.set(m, out.get(m) + n.kcal);
  }
  return months.map((key) => ({ key, kcal: out.get(key) }));
}

// ── Checking an entry (used for every import and manual edit) ─────────────────

/** Matches free text to one of the categories ("meat", "Dairy", "fish & meat" ...). null when it cannot. */
export function normalizeCategory(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const exact = NUTRITION_CATEGORIES.find((c) => c.toLowerCase() === t);
  if (exact) return exact;
  const rules = [
    [/non.?food|household|cleaning|toiletr|hygiene|paper|care/, 'Non-food'],
    [/fruit|berr/, 'Fruit'], [/veg|salad|produce/, 'Vegetables'], [/meat|fish|poultry|seafood|chicken|beef|pork/, 'Meat & fish'],
    [/dairy|egg|milk|cheese|yog/, 'Dairy & eggs'], [/grain|bread|cereal|pasta|rice|bak/, 'Grains & bread'],
    [/legume|nut|seed|bean|lentil/, 'Legumes & nuts'], [/oil|fat/, 'Oils & fats'], [/sweet|snack|candy|chocolate|dessert|sugar/, 'Sweets & snacks'],
    [/drink|beverage|juice|wine|beer|water|coffee|tea|alcohol/, 'Drinks'], [/prepared|ready|sauce|meal|condiment|soup|canned/, 'Prepared foods'],
    [/food|other|misc/, 'Other food'],
  ];
  for (const [re, cat] of rules) if (re.test(t)) return cat;
  return null;
}

/**
 * Checks and normalises an entry. Returns { entry, status, problems } where status is
 *   'ok'     fine
 *   'review' imported, but something looks off (e.g. the calories do not match the macros)
 *   'error'  cannot be used (impossible numbers, missing data)
 */
export function validateEntry(raw) {
  const problems = [];
  let status = 'ok';
  const flag = (level, msg) => { problems.push(msg); if (level === 'error' || status === 'ok') status = level; };

  const name = String(raw.name ?? '').trim();
  if (!name) flag('error', 'No name');

  let category = normalizeCategory(raw.category);
  if (!category) { if (String(raw.category ?? '').trim()) flag('review', 'Unknown category "' + raw.category + '", set to Other food'); category = 'Other food'; }

  const unitText = String(raw.unit ?? '').trim().toLowerCase();
  const unitMap = { g: 'g', gram: 'g', grams: 'g', ml: 'ml', millilitre: 'ml', milliliter: 'ml', piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', unit: 'piece', units: 'piece', each: 'piece' };
  let unit = unitMap[unitText];
  if (!unit) { if (unitText) flag('review', 'Unknown unit "' + raw.unit + '", set to g'); unit = 'g'; }

  const gpuRaw = num(raw.gramsPerUnit);
  const gramsPerUnit = gpuRaw !== null && gpuRaw > 0 ? gpuRaw : 1;
  if (gpuRaw !== null && (gpuRaw <= 0 || gpuRaw > 5000)) flag('review', 'Odd weight per piece (' + raw.gramsPerUnit + ' g)');
  if (unit === 'piece' && gramsPerUnit <= 1) flag('review', 'Pieces need a weight per piece');

  const values = { kcal: num(raw.kcal), protein: num(raw.protein), carbs: num(raw.carbs), fat: num(raw.fat) };
  const entry = {
    id: nutritionKey(name), name, category, unit, gramsPerUnit: Math.min(gramsPerUnit, 5000),
    kcal: values.kcal ?? 0, protein: values.protein ?? 0, carbs: values.carbs ?? 0, fat: values.fat ?? 0,
    source: raw.source || '',
  };

  if (category === NON_FOOD) {
    Object.assign(entry, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    return { entry, status, problems };
  }

  const missing = Object.entries(values).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length === 4) flag('error', 'No nutrition values');
  else if (missing.length) flag('review', 'Missing ' + missing.join(', ') + ' (counted as 0)');

  if (values.kcal !== null && (values.kcal < 0 || values.kcal > 900)) flag('error', 'Calories out of range (' + values.kcal + ' per 100 g)');
  for (const k of ['protein', 'carbs', 'fat']) {
    if (values[k] !== null && (values[k] < 0 || values[k] > 100)) flag('error', k[0].toUpperCase() + k.slice(1) + ' out of range (' + values[k] + ' g per 100 g)');
  }
  if (status !== 'error') {
    if (entry.protein + entry.carbs + entry.fat > 100.5) flag('error', 'Protein + carbs + fat is more than 100 g');
    else if (values.kcal !== null && !missing.length && category !== 'Drinks') { // drinks: alcohol has calories no macro explains
      const expected = entry.protein * 4 + entry.carbs * 4 + entry.fat * 9;
      if (Math.abs(entry.kcal - expected) > Math.max(40, expected * 0.35)) {
        flag('review', 'Calories (' + Math.round(entry.kcal) + ') do not match the macros (about ' + Math.round(expected) + ')');
      }
    }
  }
  return { entry, status, problems };
}

// ── Reading what the user pastes back ─────────────────────────────────────────

const COLUMN_ALIASES = {
  name: ['name', 'product', 'item', 'food', 'title'],
  kcal: ['kcal', 'calories', 'calorie', 'energy', 'cal', 'kcalper100g'],
  protein: ['protein', 'proteins', 'proteing'],
  carbs: ['carbs', 'carbohydrates', 'carbohydrate', 'carb', 'carbsg'],
  fat: ['fat', 'fats', 'totalfat', 'fatg'],
  category: ['category', 'type', 'group'],
  unit: ['unit', 'units', 'measure'],
  gramsPerUnit: ['gramsperunit', 'gperunit', 'gramsperpiece', 'weightperpiece', 'pieceweight', 'gramsperpc'],
};
const DEFAULT_ORDER = ['name', 'kcal', 'protein', 'carbs', 'fat', 'category', 'unit', 'gramsPerUnit'];

function squash(s) { return String(s).toLowerCase().replace(/[^a-z]/g, ''); }

function columnOf(cell) {
  const k = squash(cell);
  return Object.keys(COLUMN_ALIASES).find((col) => COLUMN_ALIASES[col].includes(k)) || null;
}

/** Splits one line of CSV (quotes allowed) with the given delimiter. */
function splitLine(line, delim) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** "89", "89.5", "89,5", "89 kcal", "~89", "1,234.5" -> number; blank or text -> null. */
export function toNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  let s = String(text ?? '').trim().replace(/^[~≈<>]\s*/, '').replace(/[^\d.,-]/g, '');
  if (!s || s === '-' || !/\d/.test(s)) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the answer of an assistant: CSV, semicolon/tab separated or a markdown table, with or without
 * a code fence, a header row and chatter around it. Columns are found by their header (or, without a header,
 * in the order name, kcal, protein, carbs, fat, category, unit, grams_per_unit). Every row is checked.
 * `requested` (optional) is the list of names that were asked for; answers are matched back to them.
 * Returns { rows: [{ line, requestedName, entry, status, problems }], ignored, unanswered }.
 */
export function parseNutritionImport(text, requested = []) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^```/.test(l));
  const cleaned = lines.filter((l) => !/^\|?[\s:|-]+\|?$/.test(l) || !/-/.test(l)); // drop markdown separator rows
  const isTable = cleaned.filter((l) => (l.match(/\|/g) || []).length >= 3).length >= 2;
  const split = (l) => {
    if (isTable) return l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const counts = { '\t': (l.match(/\t/g) || []).length, ';': (l.match(/;/g) || []).length, ',': (l.match(/,/g) || []).length };
    const delim = counts['\t'] > 0 ? '\t' : counts[';'] >= counts[','] && counts[';'] > 0 ? ';' : ',';
    return splitLine(l, delim);
  };

  let map = null;
  const rows = [];
  let ignored = 0;
  const reqByKey = new Map(requested.map((n) => [nutritionKey(n), n]));

  for (const line of cleaned) {
    const cells = split(line);
    if (cells.length < 2) { ignored++; continue; }
    const cols = cells.map(columnOf);
    if (!map && cols.filter(Boolean).length >= 3) { map = cols; continue; } // the header row
    const layout = map || DEFAULT_ORDER;
    // A name with a comma in it ("Discount (CAD 1,00)") that the assistant did not put in quotes spills into extra
    // cells. The name is the first column and the other columns are fixed, so the surplus belongs to the name.
    if (layout[0] === 'name' && cells.length > layout.length && !isTable) {
      const extra = cells.length - layout.length;
      cells.splice(0, extra + 1, cells.slice(0, extra + 1).join(','));
    }
    const raw = {};
    layout.forEach((col, i) => { if (col && raw[col] === undefined) raw[col] = cells[i]; });
    if (!raw.name) { ignored++; continue; }
    // Numbers: tolerate units and decimal commas.
    for (const k of ['kcal', 'protein', 'carbs', 'fat', 'gramsPerUnit']) raw[k] = toNumber(raw[k]);
    const { entry, status, problems } = validateEntry({ ...raw, source: 'AI' });
    let requestedName = reqByKey.get(entry.id) || null;
    let st = status;
    const pr = problems.slice();
    if (requested.length && !requestedName) {
      // Maybe the assistant shortened or changed the name slightly: match on the last words.
      const loose = requested.find((n) => matchEntry(n, new Map([[entry.id, true]])) || matchEntry(entry.name, new Map([[nutritionKey(n), true]])));
      if (loose) requestedName = loose;
      else { st = 'error'; pr.push('Not one of the products you asked about'); }
    }
    if (requestedName) { entry.name = requestedName; entry.id = nutritionKey(requestedName); }
    rows.push({ line, requestedName, entry, status: st, problems: pr });
  }

  const answered = new Set(rows.filter((r) => r.status !== 'error').map((r) => r.entry.id));
  const unanswered = requested.filter((n) => !answered.has(nutritionKey(n)));
  return { rows, ignored, unanswered };
}

// ── What to ask the assistant ─────────────────────────────────────────────────

/** The text the user pastes into an assistant (ChatGPT, Gemini, Claude, a local model ...). */
export function buildNutritionPrompt(names) {
  return [
    'I am filling in the nutrition table of a grocery app. For each product below, give the nutrition facts per 100 g (or per 100 ml for liquids) of the plain, generic product as it is normally bought.',
    '',
    'Answer with ONLY a CSV table inside one code block, no other text. Use exactly this header row:',
    'name,kcal,protein,carbs,fat,category,unit,grams_per_unit',
    '',
    'Rules:',
    '- name: copy the product name exactly as written below, one row per product. If a name contains a comma, put the whole name in double quotes.',
    '- kcal, protein, carbs, fat: numbers per 100 g or 100 ml (protein, carbs and fat in grams). Use a dot as decimal separator and no units.',
    '- category: exactly one of: ' + NUTRITION_CATEGORIES.join(', ') + '.',
    '- unit: g for things bought by weight (including yogurt tubs, loaves, bars and bags when the list quantity is grams), ml for liquids, piece only when the list quantity is a small count of whole items (eggs, croissants). Prefer g over piece for bread and produce when pack weight is what people type.',
    '- grams_per_unit: for piece, the typical weight in grams of one piece. For g or ml, the typical weight of one piece if a small count is sometimes typed (an apple, a tomato, a loaf), otherwise 1.',
    '- Household and personal-care items (cleaning, paper, soap ...): category Non-food, all numbers 0, unit g, grams_per_unit 1.',
    '- If a name is ambiguous, pick the most common meaning. Give your best typical estimate; never leave numbers out for food.',
    '',
    'Products:',
    ...names,
  ].join('\n');
}

// ── Built-in staples ──────────────────────────────────────────────────────────

/**
 * name|alias|alias, kcal, protein, carbs, fat (per 100 g or 100 ml), category, unit, grams per piece.
 * Typical values for the plain product as bought (raw / dry where that is how it is sold).
 * Where a unit is g/ml, the last number is the weight of one piece, used when a small quantity like 4 is typed.
 */
const STAPLE_ROWS = [
  // Fruit
  ['apple', 52, 0.3, 13.8, 0.2, 'Fruit', 'g', 180], ['banana', 89, 1.1, 22.8, 0.3, 'Fruit', 'g', 120], ['orange|clementine|mandarin', 47, 0.9, 11.8, 0.1, 'Fruit', 'g', 150],
  ['lemon', 29, 1.1, 9.3, 0.3, 'Fruit', 'g', 60], ['lime', 30, 0.7, 10.5, 0.2, 'Fruit', 'g', 45], ['pear', 57, 0.4, 15.2, 0.1, 'Fruit', 'g', 170],
  ['grape', 69, 0.7, 18.1, 0.2, 'Fruit', 'g', 1], ['strawberry', 32, 0.7, 7.7, 0.3, 'Fruit', 'g', 1], ['blueberry', 57, 0.7, 14.5, 0.3, 'Fruit', 'g', 1],
  ['raspberry', 52, 1.2, 11.9, 0.7, 'Fruit', 'g', 1], ['berries|frozen berries|mixed berries|berry mix', 45, 0.8, 10, 0.3, 'Fruit', 'g', 1],
  ['peach|nectarine', 39, 0.9, 9.5, 0.3, 'Fruit', 'g', 150], ['mango', 60, 0.8, 15, 0.4, 'Fruit', 'g', 300], ['pineapple', 50, 0.5, 13.1, 0.1, 'Fruit', 'g', 1],
  ['watermelon', 30, 0.6, 7.6, 0.2, 'Fruit', 'g', 1], ['kiwi', 61, 1.1, 14.7, 0.5, 'Fruit', 'g', 75], ['avocado', 160, 2, 8.5, 14.7, 'Fruit', 'g', 150],
  ['plum', 46, 0.7, 11.4, 0.3, 'Fruit', 'g', 60], ['cherry', 63, 1.1, 16, 0.2, 'Fruit', 'g', 1], ['raisin|dried fruit', 299, 3.1, 79, 0.5, 'Fruit', 'g', 1],
  // Vegetables
  ['tomato|cherry tomato', 18, 0.9, 3.9, 0.2, 'Vegetables', 'g', 120], ['cucumber', 15, 0.7, 3.6, 0.1, 'Vegetables', 'g', 300], ['carrot', 41, 0.9, 9.6, 0.2, 'Vegetables', 'g', 60],
  ['onion|red onion|shallot', 40, 1.1, 9.3, 0.1, 'Vegetables', 'g', 150], ['garlic', 149, 6.4, 33, 0.5, 'Vegetables', 'g', 40], ['potato', 77, 2, 17, 0.1, 'Vegetables', 'g', 170],
  ['sweet potato', 86, 1.6, 20.1, 0.1, 'Vegetables', 'g', 200], ['spinach', 23, 2.9, 3.6, 0.4, 'Vegetables', 'g', 1], ['lettuce|salad|salad mix|arugula|rocket', 15, 1.4, 2.9, 0.2, 'Vegetables', 'g', 300],
  ['broccoli', 34, 2.8, 6.6, 0.4, 'Vegetables', 'g', 300], ['cauliflower', 25, 1.9, 5, 0.3, 'Vegetables', 'g', 600], ['bell pepper|pepper|paprika', 31, 1, 6, 0.3, 'Vegetables', 'g', 150],
  ['zucchini|courgette', 17, 1.2, 3.1, 0.3, 'Vegetables', 'g', 200], ['mushroom', 22, 3.1, 3.3, 0.3, 'Vegetables', 'g', 1], ['cabbage', 25, 1.3, 5.8, 0.1, 'Vegetables', 'g', 900],
  ['celery', 16, 0.7, 3, 0.2, 'Vegetables', 'g', 1], ['corn|sweet corn', 86, 3.3, 19, 1.4, 'Vegetables', 'g', 1], ['peas|green peas', 80, 5.4, 14, 0.4, 'Vegetables', 'g', 1],
  ['green beans', 31, 1.8, 7, 0.2, 'Vegetables', 'g', 1], ['eggplant|aubergine', 25, 1, 6, 0.2, 'Vegetables', 'g', 300], ['leek', 61, 1.5, 14, 0.3, 'Vegetables', 'g', 200],
  ['beet|beetroot', 43, 1.6, 9.6, 0.2, 'Vegetables', 'g', 100], ['asparagus', 20, 2.2, 3.9, 0.1, 'Vegetables', 'g', 1], ['ginger', 80, 1.8, 18, 0.8, 'Vegetables', 'g', 1],
  // Meat & fish
  ['chicken breast', 120, 22.5, 0, 2.6, 'Meat & fish', 'g', 1], ['chicken thigh|chicken leg|chicken drumstick', 200, 17, 0, 14, 'Meat & fish', 'g', 1], ['chicken', 190, 19, 0, 12, 'Meat & fish', 'g', 1],
  ['ground beef|minced beef|mince|ground meat', 250, 17, 0, 20, 'Meat & fish', 'g', 1], ['beef|steak|beef steak', 200, 20, 0, 13, 'Meat & fish', 'g', 1],
  ['pork|pork chop|pork loin', 145, 21, 0, 6, 'Meat & fish', 'g', 1], ['bacon', 541, 37, 1.4, 42, 'Meat & fish', 'g', 1], ['ham', 145, 21, 1.5, 5.5, 'Meat & fish', 'g', 1],
  ['sausage', 300, 12, 2, 27, 'Meat & fish', 'g', 1], ['salmon|salmon fillet', 208, 20.4, 0, 13.4, 'Meat & fish', 'g', 1], ['tuna|canned tuna', 116, 25.5, 0, 0.8, 'Meat & fish', 'g', 1],
  ['shrimp|prawn', 99, 24, 0.2, 0.3, 'Meat & fish', 'g', 1], ['cod|white fish|fish fillet', 82, 18, 0, 0.7, 'Meat & fish', 'g', 1], ['turkey', 120, 22, 0, 3, 'Meat & fish', 'g', 1],
  // Dairy & eggs
  ['milk|2% milk', 50, 3.3, 4.8, 2, 'Dairy & eggs', 'ml', 1], ['whole milk', 61, 3.2, 4.8, 3.3, 'Dairy & eggs', 'ml', 1], ['skim milk|skimmed milk', 34, 3.4, 5, 0.1, 'Dairy & eggs', 'ml', 1],
  ['almond milk', 15, 0.6, 0.3, 1.1, 'Drinks', 'ml', 1], ['oat milk', 45, 1, 7, 1.5, 'Drinks', 'ml', 1], ['soy milk|soya milk', 33, 2.9, 1.7, 1.8, 'Drinks', 'ml', 1],
  ['egg', 143, 12.6, 0.7, 9.5, 'Dairy & eggs', 'piece', 50], ['butter', 717, 0.9, 0.1, 81, 'Dairy & eggs', 'g', 1], ['margarine', 717, 0.2, 0.7, 80, 'Oils & fats', 'g', 1],
  ['cheese|cheddar', 403, 25, 1.3, 33, 'Dairy & eggs', 'g', 1], ['mozzarella', 280, 28, 3.1, 17, 'Dairy & eggs', 'g', 1], ['parmesan', 431, 38, 4.1, 29, 'Dairy & eggs', 'g', 1],
  ['feta', 264, 14, 4, 21, 'Dairy & eggs', 'g', 1], ['camembert|brie', 300, 20, 0.5, 24, 'Dairy & eggs', 'g', 1], ['cream cheese', 342, 6, 4, 34, 'Dairy & eggs', 'g', 1],
  ['yogurt|yoghurt|plain yogurt', 61, 3.5, 4.7, 3.3, 'Dairy & eggs', 'g', 1], ['greek yogurt|greek yoghurt', 97, 9, 3.9, 5, 'Dairy & eggs', 'g', 1],
  ['cream|heavy cream|whipping cream', 340, 2.1, 2.8, 36, 'Dairy & eggs', 'ml', 1], ['sour cream', 193, 2.4, 4.6, 19, 'Dairy & eggs', 'g', 1],
  // Grains & bread — unit g with a loaf/piece weight so "1" means one loaf and "500" means 500 g (not 500 loaves).
  ['bread|toast|sandwich bread', 255, 9, 47, 3, 'Grains & bread', 'g', 450], ['whole wheat bread|wholemeal bread|brown bread', 247, 13, 41, 3.4, 'Grains & bread', 'g', 450],
  ['baguette', 270, 9, 56, 1.2, 'Grains & bread', 'g', 250], ['croissant', 406, 8.2, 45.8, 21, 'Grains & bread', 'g', 60], ['bun|roll|bread roll|bagel', 280, 9, 53, 3, 'Grains & bread', 'g', 70],
  ['rice|basmati rice|white rice|brown rice', 360, 7, 79, 0.6, 'Grains & bread', 'g', 1], ['pasta|spaghetti|penne|macaroni|noodle', 357, 12.5, 71, 1.5, 'Grains & bread', 'g', 1],
  ['oat|oats|rolled oats|oatmeal|porridge', 379, 13.2, 67.7, 6.5, 'Grains & bread', 'g', 1], ['cereal|granola|muesli|corn flakes', 380, 8, 80, 2.5, 'Grains & bread', 'g', 1],
  ['flour', 364, 10, 76, 1, 'Grains & bread', 'g', 1], ['couscous', 376, 12.8, 77, 0.6, 'Grains & bread', 'g', 1], ['quinoa', 368, 14, 64, 6, 'Grains & bread', 'g', 1],
  ['tortilla|wrap', 310, 8, 52, 8, 'Grains & bread', 'g', 40], ['cracker', 430, 9, 70, 12, 'Grains & bread', 'g', 1],
  // Legumes & nuts
  ['lentil', 352, 25, 63, 1.1, 'Legumes & nuts', 'g', 1], ['chickpea', 119, 7, 20, 2, 'Legumes & nuts', 'g', 1], ['beans|kidney beans|black beans|canned beans', 100, 6.5, 17, 0.5, 'Legumes & nuts', 'g', 1],
  ['tofu', 76, 8, 1.9, 4.8, 'Legumes & nuts', 'g', 1], ['almond', 579, 21, 22, 50, 'Legumes & nuts', 'g', 1], ['peanut', 567, 26, 16, 49, 'Legumes & nuts', 'g', 1],
  ['walnut', 654, 15, 14, 65, 'Legumes & nuts', 'g', 1], ['cashew', 553, 18, 30, 44, 'Legumes & nuts', 'g', 1], ['nuts|mixed nuts', 600, 18, 20, 52, 'Legumes & nuts', 'g', 1],
  ['peanut butter', 588, 25, 20, 50, 'Legumes & nuts', 'g', 1],
  // Oils & fats
  ['olive oil', 810, 0, 0, 92, 'Oils & fats', 'ml', 1], ['vegetable oil|sunflower oil|canola oil|cooking oil', 800, 0, 0, 91, 'Oils & fats', 'ml', 1],
  // Sweets & snacks
  ['chocolate|dark chocolate|milk chocolate', 546, 4.9, 61, 31, 'Sweets & snacks', 'g', 1], ['sugar', 387, 0, 100, 0, 'Sweets & snacks', 'g', 1], ['honey', 304, 0.3, 82, 0, 'Sweets & snacks', 'g', 1],
  ['jam|jelly|marmalade', 250, 0.4, 60, 0.1, 'Sweets & snacks', 'g', 1], ['chips|crisps|potato chips', 536, 7, 53, 34, 'Sweets & snacks', 'g', 1],
  ['cookie|biscuit', 480, 6, 68, 20, 'Sweets & snacks', 'g', 1], ['ice cream', 207, 3.5, 24, 11, 'Sweets & snacks', 'g', 1], ['maple syrup', 260, 0, 67, 0.1, 'Sweets & snacks', 'ml', 1],
  ['candy|sweets|gummy', 350, 4, 80, 0.5, 'Sweets & snacks', 'g', 1], ['popcorn', 387, 13, 78, 4.5, 'Sweets & snacks', 'g', 1],
  // Drinks
  ['orange juice', 45, 0.7, 10.4, 0.2, 'Drinks', 'ml', 1], ['apple juice|juice', 46, 0.1, 11.4, 0.1, 'Drinks', 'ml', 1], ['cola|soda|soft drink|lemonade', 42, 0, 10.6, 0, 'Drinks', 'ml', 1],
  ['beer', 43, 0.5, 3.6, 0, 'Drinks', 'ml', 1], ['red wine', 85, 0.1, 2.6, 0, 'Drinks', 'ml', 1], ['white wine|wine|rose wine|sparkling wine', 82, 0.1, 2.6, 0, 'Drinks', 'ml', 1],
  ['water|mineral water|sparkling water', 0, 0, 0, 0, 'Drinks', 'ml', 1], ['coffee|coffee beans|ground coffee|espresso', 2, 0.1, 0, 0, 'Drinks', 'g', 1], ['tea|tea bags', 1, 0, 0.3, 0, 'Drinks', 'g', 1],
  // Prepared foods
  ['tomato sauce|pasta sauce', 40, 1.4, 7.5, 0.5, 'Prepared foods', 'g', 1], ['canned tomatoes|crushed tomatoes|tomato paste', 25, 1.2, 5, 0.2, 'Prepared foods', 'g', 1],
  ['pizza|frozen pizza', 266, 11, 33, 10, 'Prepared foods', 'g', 1], ['soup', 40, 1.5, 6, 1, 'Prepared foods', 'g', 1], ['hummus', 166, 8, 14, 10, 'Prepared foods', 'g', 1],
  ['ketchup', 100, 1.2, 25, 0.1, 'Prepared foods', 'g', 1], ['mayonnaise|mayo', 680, 1, 0.6, 75, 'Prepared foods', 'g', 1], ['mustard', 66, 4, 6, 3.3, 'Prepared foods', 'g', 1],
  ['soy sauce', 53, 8, 5, 0.6, 'Prepared foods', 'ml', 1], ['salsa', 36, 1.5, 7, 0.2, 'Prepared foods', 'g', 1], ['stock|broth|bouillon', 10, 1, 1, 0.3, 'Prepared foods', 'ml', 1],
  // Non-food
  ['toilet paper|paper towel|kitchen roll|tissue|napkin', 0, 0, 0, 0, 'Non-food', 'g', 1], ['dish soap|dishwasher tablet|laundry detergent|detergent|fabric softener|cleaning spray|cleaner|bleach|sponge', 0, 0, 0, 0, 'Non-food', 'g', 1],
  ['soap|shampoo|conditioner|shower gel|toothpaste|toothbrush|deodorant|razor|body lotion', 0, 0, 0, 0, 'Non-food', 'g', 1], ['garbage bag|trash bag|bin bag|aluminium foil|aluminum foil|cling film|baking paper|diaper|nappy|wipe|battery|light bulb|candle', 0, 0, 0, 0, 'Non-food', 'g', 1],
];

/** Map(key -> staple) of the built-in table, one key per alias. */
export const STAPLES = (() => {
  const map = new Map();
  for (const [names, kcal, protein, carbs, fat, category, unit, gramsPerUnit] of STAPLE_ROWS) {
    for (const alias of names.split('|')) {
      const key = nutritionKey(alias);
      if (key && !map.has(key)) map.set(key, { kcal, protein, carbs, fat, category, unit, gramsPerUnit });
    }
  }
  return map;
})();

/**
 * Entries to add to the Nutrition tab for product names that have none yet and that the built-in table knows.
 * `titles` are the product names of the group; `lookup` is what the sheet already has.
 */
export function missingStaples(titles, lookup) {
  const added = new Map();
  for (const title of titles) {
    const key = nutritionKey(title);
    if (!key || added.has(key) || matchEntry(title, lookup)) continue;
    const staple = matchEntry(title, STAPLES);
    if (!staple) continue;
    added.set(key, { id: key, name: String(title).trim(), ...staple, source: 'built-in' });
  }
  return [...added.values()];
}

/**
 * The lookup to use when only reading (Home, History): what the sheet has, plus the built-in staples for the
 * given product names, applied in memory only. Nothing is written.
 */
export function readLookup(entries, titles) {
  const own = nutritionLookup(entries);
  return nutritionLookup([...entries, ...missingStaples(titles, own)]);
}

/**
 * A `measure` for productStats. What was LOGGED decides: products counted in pieces (eggs, a loaf, non-food) or
 * bought with a small number and a known piece weight (Bananas 6) are pieces; a number from 10 up in grams or
 * millilitres is an amount. When a piece weight is known, a purchase also carries the other reading (`grams` of a
 * piece purchase, `pieces` of a weight purchase) so mixed purchases can still be compared. Anything unclear falls
 * back to the default reading of the quantity.
 */
export function nutritionMeasure(lookup) {
  const number = (quantity) => {
    const q = parseFloat(String(quantity ?? '').replace(',', '.'));
    return Number.isFinite(q) && q > 0 ? q : null;
  };
  return (item) => {
    const entry = matchEntry(item.title, lookup);
    if (!entry) return defaultMeasure(item);
    const q = number(item.quantity);
    const gpu = entry.gramsPerUnit > 1 ? entry.gramsPerUnit : 0;
    if (entry.category === NON_FOOD) {
      // Soap, toilet paper: whatever the quantity, it counts things, never grams.
      return { basis: 'piece', amount: q ?? 1 };
    }
    if (entry.unit === 'piece') {
      if (q !== null && q >= PIECE_QTY_AS_GRAMS_FROM) {
        const m = { basis: 'g', amount: q };
        return gpu ? { ...m, pieces: q / gpu } : m;
      }
      const pieces = q ?? 1;
      return gpu ? { basis: 'piece', amount: pieces, grams: pieces * gpu } : { basis: 'piece', amount: pieces };
    }
    // Sold by weight or volume.
    if (q !== null && q >= 10) {
      const m = { basis: entry.unit === 'ml' ? 'ml' : 'g', amount: q };
      return gpu ? { ...m, pieces: q / gpu } : m;
    }
    if (q !== null && gpu) return { basis: 'piece', amount: q, grams: q * gpu };
    return defaultMeasure(item);
  };
}

/**
 * Rows of the Nutrition tab of the old Nutri app (Name, Calories, Protein, Carbs, Fat, Category, Unit,
 * GramsPerUnit; values per 100 g) as entries for this app. They were typed in by the user, so their source is
 * 'manual'. Every row is checked like any other: rows that cannot be used (no name, impossible numbers) are
 * left out and reported, doubtful ones are kept and counted in `review`. The first row of a name wins.
 */
export function convertNutriNutrition(rows) {
  const entries = [];
  const skipped = [];
  const seen = new Set();
  let review = 0;
  const flagged = new Map(); // id -> what looked doubtful at import time
  for (const r of rows || []) {
    const row = r || [];
    if (!String(row[0] ?? '').trim()) continue;
    const { entry, status, problems } = validateEntry({
      name: row[0], kcal: row[1], protein: row[2], carbs: row[3], fat: row[4],
      category: row[5], unit: row[6], gramsPerUnit: row[7], source: 'manual',
    });
    if (status === 'error') { skipped.push({ name: String(row[0]).trim(), problems }); continue; }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (status === 'review') { review++; flagged.set(entry.id, problems); }
    entries.push(entry);
  }
  return { entries, skipped, review, flagged };
}

/** The short reason behind a validateEntry problem, so many rows can be summed up ("80 pieces without a weight"). */
export function problemKind(problem) {
  const p = String(problem);
  if (p.startsWith('Pieces need')) return 'pieces without a weight';
  if (p.startsWith('Odd weight')) return 'odd piece weight';
  if (p.startsWith('Unknown category')) return 'unknown category';
  if (p.startsWith('Unknown unit')) return 'unknown unit';
  if (p.startsWith('Missing')) return 'missing values';
  if (p.startsWith('Calories')) return 'calories not matching the macros';
  return 'other';
}

/** What is doubtful about a saved entry (empty when it looks fine), judged by the same rules as an import. */
export function entryProblems(e) {
  if (!e) return [];
  const { status, problems } = validateEntry({
    name: e.name, kcal: e.kcal, protein: e.protein, carbs: e.carbs, fat: e.fat,
    category: e.category, unit: e.unit, gramsPerUnit: e.gramsPerUnit, source: e.source,
  });
  return status === 'ok' ? [] : problems;
}
