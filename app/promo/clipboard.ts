/**
 * Copies text from a tap handler; call it before any await so the browser still counts the tap.
 * With the Clipboard API it uses writeText and reports a rejection as false (an execCommand
 * after an await would no longer be inside the tap). Without it (older iOS Safari, plain http
 * on a LAN address) it selects a hidden textarea and runs execCommand("copy") synchronously.
 */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // 16px so iOS does not zoom; off-screen but still selectable.
  Object.assign(area.style, { position: "fixed", top: "0", left: "-9999px", fontSize: "16px", opacity: "0" });
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  // Focus is not handed back: on iOS that would pop the keyboard up again.
  area.remove();
  return ok;
}
