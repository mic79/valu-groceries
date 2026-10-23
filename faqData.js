/** FAQ content for Valu Groceries (shown on the FAQ page). Answers support **bold** and line breaks. */

export const FAQ_CATEGORIES = [
  { id: 'basics', label: 'Basics', icon: 'info' },
  { id: 'features', label: 'Features', icon: 'auto_awesome' },
  { id: 'data', label: 'Data & Privacy', icon: 'lock' },
  { id: 'setup', label: 'Setup & Configuration', icon: 'settings' },
];

export const FAQ_ENTRIES = [
  {
    id: 'whatIs',
    category: 'basics',
    question: 'What is Valu Groceries?',
    answer:
      'Valu Groceries is a shopping list app that stores everything in your own Google Sheets: no servers, no subscriptions, full privacy.\n\n' +
      'Plan what you need per store, mark items as bought, and - if you like - keep track of what you spend. ' +
      'It is the sibling of Valu Finance and works the same way.',
  },
  {
    id: 'addTick',
    category: 'basics',
    question: 'How do I add items and mark them as bought?',
    answer:
      'Type the item in the bar at the bottom and press enter. While you type, things you bought before are suggested. Products from **this store** come first, together with how you bought them there: the quantity and the price (for example "Eggs 12 $4.99", "Eggs 12 $5.49" and "Eggs 6 $2.99" are three rows, each different way is listed once). Tap one and the item is added with that quantity and price as an estimate. Products you only bought at other stores follow, marked with the store they came from, with no quantity and no price.\n\n' +
      'Tap the square in front of an item to select it. The square above the list selects everything still to buy in that store. A bar appears at the bottom: **Bought** moves the selected items to **Bought today**, and **Date** lets you pick another day. With nothing selected, tap an item to change its quantity, store, price or notes.\n\n' +
      'The quantity is a plain number, like "12" or "500": how many pieces, or how many grams or millilitres for things sold by weight or volume (write 1 kg as 1000). Keeping it a number lets other tools read it later, for example to work out nutrition. Nothing is calculated from it in this app; it just shows next to the name so you can recognise the right product in the shop. Type it in the small Qty box next to the name. Next to it is a small Price box (when prices are tracked): type the price in the store\'s currency and it is converted for you at a shop abroad. A price you type there replaces a suggested one.\n\n' +
      'The slider icon next to the text box opens the full form when you want to add details straight away.',
  },
  {
    id: 'stores',
    category: 'features',
    question: 'How do stores work?',
    answer:
      'Each store you add (in **Stores**) gets its own list, shown as tabs on the Groceries page. Items without a store live in **Anywhere**. ' +
      'You can give a store a city or branch to tell two shops with the same name apart, and hide stores you no longer use without losing their history.\n\n' +
      'The **Stores** page shows per store how many items are still to buy, how many you bought, when you last shopped there and (with price tracking) what you spent this month. Use the switch on a row to show or hide a store, search by name or city, filter on All, Visible or Hidden, sort the list, or select several stores to show, hide or delete them together.',
  },
  {
    id: 'organize',
    category: 'features',
    question: 'Can I reorder, move or delete several items at once?',
    answer:
      'Yes. Select items with the squares in front of them (or the square above the list for all of them). The bar that appears lets you mark them as bought, set a date, move them to another store or delete them. ' +
      'The arrows icon turns on reordering: drag the handle at the right of an item to put it where you want it.',
  },
  {
    id: 'reuse',
    category: 'features',
    question: 'How do I quickly repeat an earlier shop?',
    answer:
      'Tap the **list-with-plus icon** above the list ("Add from a previous trip"). It shows your earlier shopping days. Tick a whole day, several days, or single items, then **Add to the list**. ' +
      'Quantities come along; items already on the list are skipped. The old price is only kept (as an estimate) when the item stays in the same store.\n\n' +
      'In **History**, **Select** does the same: tap items or a day heading, then **Add to list**. On the shopping page you can also select bought items and tap **Buy again**.',
  },
  {
    id: 'pastDate',
    category: 'features',
    question: 'How do I record something I bought on another day?',
    answer:
      'Select the items with the squares in front of them and tap **Date** in the bar. Pick Today, Yesterday or any earlier day. ' +
      'To log a whole shop you did before, use the **list-with-plus icon** to copy a similar earlier trip, then set the date the same way. You can also change the **Bought on** date of a single item when you open it.',
  },
  {
    id: 'prices',
    category: 'features',
    question: 'Do I have to track prices?',
    answer:
      'No. Price tracking is optional and can be switched off per group in **Groups** (open the group, then "Keep track of prices"). ' +
      'With it off you get a clean list, without price fields, totals or spending insights.\n\n' +
      'With it on, you can add a price to each item. The list shows the total of what is still to buy per store (and of the items you have selected), **History** shows what you paid, and the **Home** page shows spending per month and where you shopped.',
  },
  {
    id: 'foreign',
    category: 'features',
    question: 'What about shopping abroad or in another currency?',
    answer:
      'Prices are always stored in your group\'s **base currency**, so totals add up. When you buy in another currency, enter the price in that currency and Valu converts it using the exchange rate of the purchase date.\n\n' +
      'In the item form, "Paid in" picks the currency; tap **Convert from ...**, type the price, and the converted amount is filled in. The original amount is kept with the item, so the list shows what you paid (for example 3.50 EUR) with the converted amount underneath.\n\nWhen you mark a single item as bought, a small box offers to type the price right away, in the store\'s currency.\n\n' +
      'If a store always uses another currency (say a shop in Paris), set that currency on the store and the conversion starts automatically. If the rate service is unreachable, the fallback rates from the group settings are used.',
  },
  {
    id: 'share',
    category: 'features',
    question: 'Can we share a list?',
    answer:
      'Yes. Open Google Drive, find the spreadsheet named **Valu Groceries: [Group]**, and share it with the other person. They tap **Groups**, then **Open shared group**, and pick it.\n\n' +
      'Changes from either phone show up on the other within about twenty seconds, or right away when the app is reopened.',
  },
  {
    id: 'history',
    category: 'features',
    question: 'What are the Home page and History?',
    answer:
      'The **Home** page is your dashboard: what is left to buy, how much you spend per month, which stores cost the most, and the items you buy most often. Open the list itself from the **Groceries** tab.\n\n' +
      '**History** lists everything you marked as bought. Pick a period (all time, a year, a month, a day or a date range), search by item, note, store or city, filter on one or more stores and sort by date, price, name or store. ' +
      'Tap a purchase to correct it (price, date, store, notes) or to put it on your list again. **Products** shows each product once: how often you bought it, its average, lowest and highest price, and where it was cheapest. Because a price is for the whole line, stores are compared on the price of one unit: per 100 g (or 100 ml) when the amount is known, per piece otherwise, so a big pack is not judged against a small one. Amounts come from the quantity, and from the Nutrition data of the product when it has any (a piece weight, millilitres, non-food counted in pieces). A product logged both ways (6 bananas at one store, 1000 g at another) is converted with the piece weight from Nutrition and marked approximate; purchases that cannot be converted are left out, and a note says how to fix them. Use the refresh button to load changes made on another device.\n\n' +
      'You can choose what the Home page shows, and in which order, under **Settings, Home layout**: the shopping list, spending (months with stores under each month), shopping days and items, nutrition, and the items you buy most. Spending starts with the period (last 12 months or a year); tap a month to open where you shopped that month. **Bought most often** can be this month, the last 12 months or all time. This is remembered on the device you set it on. Under **Settings, Start page** you can also choose which page the app opens on (Dashboard, Groceries, History, Nutrition or Stores), also per device. A page you open from a link or bookmark is always shown as is.\n\n' +
      '**Select** works on several purchases at once: add them to the list, change their date, move them to another store, delete them, or **Copy** them. Copy lets you choose which fields to include (date, item, quantity, store, city, price, paid, notes) and whether to paste into a spreadsheet or as CSV. The text only goes to your clipboard; nothing is sent anywhere.',
  },
  {
    id: 'nutrition',
    category: 'features',
    question: 'How does the Nutrition page work?',
    answer:
      '**Nutrition** turns what you buy into calories, protein, carbs and fat: per day, how the calories split over protein, carbs and fat, which food groups they come from, how it changes per month, and which products add the most. Pick this month, last month, 3 or 12 months, or look further back: **All time** and one chip per year appear once you have more than one year of history. All time shows one bar per year; a year shows its twelve months, and tapping a bar zooms in on that month or year.\n\n' +
      'The numbers come from a **Nutrition** tab in this group\'s sheet, with values per 100 g or 100 ml. Common groceries are filled in automatically from a table built into the app, which stays on your device. ' +
      'Products that are not in that table appear under **Not counted yet**. Tap **Fill in** to get help from an AI assistant: pick the products, copy the request, paste it into ChatGPT, Gemini, Claude or whichever assistant you prefer, then paste its answer back. ' +
      'The answer is checked (impossible values are rejected, doubtful ones are flagged) before anything is saved. You can also add or correct any product by hand.\n\n' +
      'It is an estimate of what you **bought**, not of what you ate. Quantities count as grams or millilitres from 10 upwards; for small numbers like 4, give the product a weight per piece.\n\n' +
      '**Privacy:** the app never sends your products anywhere. Only the names you choose go into the text you copy, and you decide where to paste it. Untick anything you would rather not share.\n\n' +
      'A group can turn Nutrition off under **Groups** (off for everyone sharing that sheet). When it is on, **Settings, Nutrition** on this device can hide the page, its Home widget and the start-page option; other people in the group still see it. History still uses the data for per-100 g prices when the group has Nutrition on.',
  },
  {
    id: 'nutri',
    category: 'setup',
    question: 'Can I bring my data over from Nutri?',
    answer:
      'Yes. Open **Groups**, tap the group you want, and use **Import from Nutri**. Pick your old Nutri sheet and your stores, items, history and your Nutrition data (calories and macros per product) are copied in. ' +
      'The old sheet is never changed, and importing twice does not create duplicates. A second import also corrects purchase dates so they use the same calendar day Nutri showed (and Valu Finance used). Nutrition entries you already have in this group are kept, not overwritten; rows with impossible values are left out and you are told how many.\n\n' +
      'Nutri had no currencies, so imported prices are taken to be in the group\'s base currency.',
  },
  {
    id: 'storage',
    category: 'data',
    question: 'Where is my data stored?',
    answer:
      'In Google Sheets on your own Google Drive. Valu Groceries never sends your lists to any other server. ' +
      'The only outside service it contacts for data is the exchange-rate service, which receives a currency pair and a date, nothing about you or your items.',
  },
  {
    id: 'permission',
    category: 'data',
    question: 'What access does the app ask for?',
    answer:
      'Only access to the spreadsheets it creates for you, or that you pick yourself (for example a shared list). It cannot see the rest of your Drive.',
  },
  {
    id: 'stayIn',
    category: 'data',
    question: 'Do I have to sign in again and again?',
    answer:
      'No. After you connect once, the app keeps you signed in on that device and refreshes access in the background, also after closing the app or restarting your phone.\n\n' +
      'If you ever see "Session expired", tap **Reconnect**. On a shared or borrowed device, use **Settings > Sign out & forget this device** when you are done.',
  },
  {
    id: 'install',
    category: 'setup',
    question: 'How do I install the app on my phone?',
    answer:
      'Open the app in your browser, then open **Activity** from the side menu and tap **Install**. On an iPhone, tap the Share button in Safari and choose "Add to Home Screen".\n\n' +
      'Once installed it opens full screen like any other app.',
  },
  {
    id: 'currencyChange',
    category: 'setup',
    question: 'What happens if I change the base currency?',
    answer:
      'New prices will be stored in the new currency. Prices you already saved are not converted, so change it early, or create a new group if you move to another country.',
  },
];

export function getFaqsByCategory(categoryId) {
  return FAQ_ENTRIES.filter((e) => e.category === categoryId);
}
