# Valu Groceries

Shopping lists that stay private and live in your own Google Drive. A sibling of Valu Finance: same
look and feel, same "sign in once, stay signed in" authentication, same Google-Sheets-as-database idea.

- **Stores page** (like Nutri's Locations): per store the items to buy, items bought, last purchase and spending this month, a show/hide switch in the list, search (name, city, currency), All/Visible/Hidden filter, sorting, select several to show, hide or delete.
- Lists per store. Like Nutri, a square in front of each item selects it (a square above the list selects all); the bar that appears marks them as bought, sets a date, moves or deletes them. Reorder by dragging.
- **Quantity is a plain number** (`12` pieces, or `500` grams or millilitres for weight and volume). It is shown next to the item and used by the Nutrition page (from 10 upwards it is read as grams or millilitres). Quantities typed as text by older versions are kept as they are.
- **Quick add**: the bar takes a name, a quantity and a price (in the store's currency) in one go. Suggestions list what you bought in that store first, one row per distinct quantity and price (picking one adds the item with that quantity and price as an estimate), then product names from your other stores (name only: never their quantity or price).
- **Reuse earlier purchases**: *Add from a previous trip* (one or several dates, or a whole day), *Select -> Buy again*, and *Select* in History.
- **Dates**: select items -> *Date* sets the purchase date (today, yesterday or any earlier day), or puts them back on the list.
- **Price after buying**: mark a single item without a price as bought and a small box asks for it in the store's currency.
- **History**: period (all time, year, month, day or range), search (item, notes, store, city), multi-store filter, sorting, a *Products* view (count, average / lowest / highest price, and the cheapest store compared per 100 g / 100 ml, or per piece, so pack sizes do not distort it; amounts come from the quantity and, when present, the Nutrition data), edit a purchase, and bulk actions on a selection: add to list, date, move, delete and *Copy* (clipboard text with the fields, format and header of your choice; remembered on the device, nothing is exported to a file).
- **Nutrition**: calories per day, protein/carbs/fat split, food groups, calories per month, per year (All time and one chip per year for older history), top products and coverage, from a per-group `Nutrition` tab (values per 100 g / 100 ml). A built-in table of ~270 common groceries fills it in automatically and offline; for other products the page builds a request you copy into an AI assistant of your choice (ChatGPT, Gemini, Claude...) and you paste the answer back, where it is validated before saving. The app itself never contacts any assistant or database, and only the names you tick go into the copied text. Estimates of what was bought, not eaten. A group can turn Nutrition off (`trackNutrition` in the Settings tab); when it is on, each device can hide the page under Settings (`vg_show_nutrition`).
- **Home layout**: *Settings -> Home layout* shows or hides each Home widget (shopping list, spending, shopping days and items, nutrition, bought most often) and reorders them. Stored on the device in `localStorage` (`vg_home_layout`), as in Valu Finance. Spending is one widget: pick 12 months or a year, then open a month to see where you shopped underneath. Bought most often can be this month, 12 months or all time.
- **Start page**: *Settings -> Start page* picks the page the app opens on (Dashboard by default, or Groceries, History, Nutrition, Stores). Stored on the device in localStorage (g_start_page). It applies once per launch, only when the address names no page, and replaces the history entry so Back leaves the app.
- Optional price tracking: history by day, a dashboard on the home page with monthly spending (and the split per store) and most-bought items.
- **Foreign currency**: pick a store/item paid in another currency, type the price as it is on the shelf and
  it is converted with the latest exchange rate (frankfurter) and stored in the group's base currency.
- Shared lists: share the spreadsheet in Drive, the other person opens it from *Groups → Open shared group*.
  Changes show up within ~20 s.
- Installable PWA, works offline for the shell, light/dark theme.
- **Quick look** demo on the landing page works without signing in (add `?demo` to the URL to jump straight in).

## How sign-in works (and why it does not log you out)

Google OAuth code flow with PKCE → a small Cloudflare Worker exchanges the code and keeps the long-lived
refresh token sealed. The browser only holds short-lived access tokens and renews them silently, so you
authenticate once per device, not once per session. Scope is `drive.file`: the app only sees the spreadsheets
it created or that you picked with the Google Picker.

## Setup

Everything deployment-specific is in `config.js`.

1. **Google Cloud (same project as Valu Finance is fine)**
   - OAuth client → add the new origin to *Authorized JavaScript origins* and
     `<origin>/` to *Authorized redirect URIs* (for local testing: `http://localhost:8000` and `http://localhost:8000/`).
     Use `localhost`, not `127.0.0.1`, for Google sign-in.
   - API key (Picker) → add the new origin to the allowed HTTP referrers (e.g. `https://groceries.example.com/*`).
2. **Auth worker** – either
   - reuse the Valu worker: add the new origin to its `ALLOWED_ORIGINS`, or
   - deploy `cloudflare-worker/`: `cd cloudflare-worker && npm i && npx wrangler secret put GOOGLE_CLIENT_SECRET && npx wrangler secret put ENCRYPTION_SECRET && npx wrangler deploy`
     (edit `ALLOWED_ORIGINS` in `wrangler.toml` first), then put its URL in `config.js` → `WORKER_URL`.
3. **Host** the folder as static files (Cloudflare Pages / Workers assets, Netlify, GitHub Pages…). `_headers` contains the
   security headers (CSP etc.) for Cloudflare/Netlify-style hosts.
4. Bump `version.js` when you release (it also names the offline cache), so installed apps update.

## Run locally

```
python -m http.server 8000
```

Open <http://localhost:8000/>. Run the checks with `node --test "tests/*.test.mjs"`.

## Data

Spreadsheet name: `Valu Groceries: <group name>` (tabs `Items`, `Stores`, `Settings` and `Nutrition`). Items have `PaidAmount`/`PaidCurrency` columns holding the original foreign amount (the converted price in the base currency is in `Price`). Older sheets get the new header cells automatically. Valu Finance and Valu Groceries
use different name prefixes and storage keys, so they never see each other's data, even on the same origin.

Migrating from old Nutri: *Groups → Import from Nutri* copies stores, items and the Nutrition tab from a Nutri spreadsheet (its amount column becomes the quantity; nutrition rows are checked like any other entry, and existing ones are never overwritten).

## Notes

- Icons and the wordmark are the Valu ones; swap `icons/` and the landing SVG for Groceries-specific branding when you have it.
- Not ported from Valu Finance: assistant, FI calculator, forecast.
