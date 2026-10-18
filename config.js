/**
 * Deployment settings for Valu Groceries - the only file you should need to edit to point the app at
 * your own Google Cloud project and auth worker. See README.md ("Setup") for the checklist.
 *
 * None of these values is a secret: the OAuth client ID and the (referrer-restricted) API key are
 * public by design. The client SECRET lives only in the Cloudflare Worker.
 */

/** Google OAuth "Web application" client ID. */
const CLIENT_ID = '399400088485-h2nrjmo500qj4s7qrvfaog2tsqet3huo.apps.googleusercontent.com';

/**
 * Browser API key used only by the Google Picker. Restrict it to "Websites" (HTTP referrers) and to
 * the Google Picker API, and add this app's address to the allowed referrers.
 */
const API_KEY = 'AIzaSyBdC9q6tLx1vLOFyUF-8Jeuy4gpuTYiaPs';

/**
 * Auth worker (token exchange + silent refresh): the deployment of `cloudflare-worker/`. It only accepts the
 * origins listed in its ALLOWED_ORIGINS (groceries.valu-app.com and localhost for testing).
 */
const WORKER_URL = 'https://valu-groceries-auth.valu.workers.dev';

/** PKCE for the sign-in code flow. Requires the hardened worker in `cloudflare-worker/`. */
const USE_PKCE = true;

/** Spreadsheet names start with this, so the app (and the Picker) never mixes them up with Valu Finance sheets. */
const SHEET_PREFIX = 'Valu Groceries: ';

/** Prefix for every localStorage key, so this app never collides with Valu Finance on the same origin (e.g. localhost). */
const STORAGE_PREFIX = 'vg_';

export { CLIENT_ID, API_KEY, WORKER_URL, USE_PKCE, SHEET_PREFIX, STORAGE_PREFIX };
