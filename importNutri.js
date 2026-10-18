/**
 * One-time import of a spreadsheet created by the old Nutri app into a Valu Groceries group.
 * Reads the Nutri "Groceries", "Locations" and "Nutrition" tabs (never writes to them) and appends the converted
 * rows to the group's Items, Stores and Nutrition tabs. Safe to run twice: rows that were already imported
 * (same Nutri id, or same product name for nutrition data) are skipped.
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import { convertNutriRows, itemToRow, storeToRow } from './groceryLogic.js';
import { convertNutriNutrition, rowToNutrition, nutritionToRow, problemKind } from './nutritionLogic.js';

const CHUNK = 400;

/** An old Nutri sheet may have no Nutrition tab at all: that is not an error. */
async function readOptional(sourceSheetId, range) {
  try {
    return await SheetsApi.getValues(sourceSheetId, range, { unformatted: true });
  } catch {
    return [];
  }
}

/**
 * @returns {Promise<{stores: number, items: number, nutrition: number, nutritionReview: number,
 *                    nutritionReasons: Object<string, number>, nutritionSkipped: number, skipped: number}>} how many rows were added (skipped = already here)
 */
export async function importFromNutri(targetSheetId, sourceSheetId) {
  const [groceryRows, locationRows, nutritionRows] = await Promise.all([
    SheetsApi.getValues(sourceSheetId, 'Groceries!A2:I', { unformatted: true }),
    SheetsApi.getValues(sourceSheetId, 'Locations!A2:F', { unformatted: true }),
    readOptional(sourceSheetId, 'Nutrition!A2:H'),
  ]);
  if (!groceryRows.length && !locationRows.length && !nutritionRows.length) {
    throw new Error('That spreadsheet has no Groceries, Locations or Nutrition data. Pick a sheet created by the old Nutri app.');
  }

  const converted = convertNutriRows(groceryRows, locationRows);
  const nutri = convertNutriNutrition(nutritionRows);

  // A group made before the Nutrition tab existed gets it now.
  await SheetsApi.ensureSchema(targetSheetId);
  const [existingStores, existingItems, existingNutrition] = await Promise.all([
    SheetsApi.getTabData(targetSheetId, TABS.STORES),
    SheetsApi.getTabData(targetSheetId, TABS.ITEMS),
    SheetsApi.getTabData(targetSheetId, TABS.NUTRITION),
  ]);
  const haveStores = new Set(existingStores.map((r) => String(r[0])));
  const haveItems = new Set(existingItems.map((r) => String(r[0])));
  const haveNutrition = new Set(existingNutrition.map((r) => rowToNutrition(r).id));

  const newStores = converted.stores.filter((s) => !haveStores.has(s.id));
  const newItems = converted.items.filter((i) => !haveItems.has(i.id));
  const newNutrition = nutri.entries.filter((e) => !haveNutrition.has(e.id));

  if (newStores.length) await SheetsApi.appendRows(targetSheetId, TABS.STORES, newStores.map(storeToRow));
  const itemRows = newItems.map(itemToRow);
  for (let i = 0; i < itemRows.length; i += CHUNK) {
    await SheetsApi.appendRows(targetSheetId, TABS.ITEMS, itemRows.slice(i, i + CHUNK));
  }
  if (newNutrition.length) await SheetsApi.appendRows(targetSheetId, TABS.NUTRITION, newNutrition.map(nutritionToRow));

  // Doubtful entries among the ones actually added now, and why (an entry can have several reasons).
  const reasons = {};
  let review = 0;
  for (const e of newNutrition) {
    const problems = nutri.flagged.get(e.id) || [];
    if (!problems.length) continue;
    review++;
    for (const k of new Set(problems.map(problemKind))) reasons[k] = (reasons[k] || 0) + 1;
  }

  return {
    stores: newStores.length,
    items: newItems.length,
    nutrition: newNutrition.length,
    nutritionReview: review,
    nutritionReasons: reasons,
    nutritionSkipped: nutri.skipped.length,
    skipped: (converted.stores.length - newStores.length) + (converted.items.length - newItems.length) + (nutri.entries.length - newNutrition.length),
  };
}
