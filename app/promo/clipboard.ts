/**
 * Copies text from a tap handler. The Clipboard API first; older iOS Safari (and http on a LAN
 * address, where the API is missing) falls back to selecting a hidden textarea. Call it before
 * any await in the handler, or Safari no longer counts it as a user gesture.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // 16px so iOS does not zoom; off-screen but still selectable.
  Object.assign(area.style, { position: "fixed", top: "0", left: "-9999px", fontSize: "16px", opacity: "0" });
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}
