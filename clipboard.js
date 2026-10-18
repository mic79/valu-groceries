/** Puts text on the clipboard; falls back to a hidden textarea where the clipboard API is not available. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* try the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Reads text from the clipboard (needs the user's permission); '' when that is not possible. */
export async function readClipboardText() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}
