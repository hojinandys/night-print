// Keep keyboard navigation within the artwork in both native fullscreen and
// the fixed-position fallback. Restore the page exactly when leaving.
export function createImmersiveFocus(artwork, trigger) {
  const document = artwork.ownerDocument;
  const window = document.defaultView;
  const selector = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,iframe,audio[controls],video[controls],[tabindex],[contenteditable="true"]';
  let active = false;
  let previousFocus = null;
  let previousTabIndex = null;
  let background = [];
  let dialogs = [];

  function visible(element) {
    if (!element?.isConnected || typeof element.focus !== 'function') return false;
    if (element.closest('[hidden],[inert],[aria-hidden="true"]') || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
    if (!element.getClientRects().length) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }

  function focusableElements() {
    return Array.from(artwork.querySelectorAll(selector)).filter((element) => element.tabIndex >= 0 && visible(element));
  }

  function focusInside() {
    const target = visible(trigger) ? trigger : focusableElements()[0] || artwork;
    target.focus();
  }

  function hasOpenDialog() {
    // showModal() already supplies its own focus containment. In fullscreen,
    // the dialogs live inside the fullscreen element so they remain visible.
    return !!document.querySelector('dialog[open]');
  }

  function onFocus(event) {
    if (!active || hasOpenDialog() || artwork.contains(event.target)) return;
    focusInside();
  }

  function onKey(event) {
    if (!active || event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || hasOpenDialog()) return;
    const elements = focusableElements();
    if (!elements.length) {
      event.preventDefault();
      artwork.focus();
      return;
    }
    const first = elements[0], last = elements[elements.length - 1], focused = document.activeElement;
    if (!artwork.contains(focused) || focused === artwork || !elements.includes(focused)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && focused === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function activate() {
    if (active) return;
    active = true;
    previousFocus = document.activeElement;
    previousTabIndex = artwork.getAttribute('tabindex');
    if (previousTabIndex === null) artwork.setAttribute('tabindex', '-1');

    // A dialog outside the native fullscreen element may be obscured even
    // though it is in the top layer. Reparent only while the artwork is open.
    dialogs = Array.from(document.querySelectorAll('dialog')).filter((dialog) => !artwork.contains(dialog)).map((dialog) => ({
      element: dialog, parent: dialog.parentNode, next: dialog.nextSibling,
    }));
    for (const { element } of dialogs) artwork.append(element);

    background = [];
    for (let branch = artwork; branch && branch !== document.body; branch = branch.parentElement) {
      const parent = branch.parentElement;
      if (!parent) break;
      for (const element of parent.children) {
        if (element === branch || element.id === 'announcer' || /^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/.test(element.tagName)) continue;
        background.push({ element, inert: element.inert, attribute: element.getAttribute('inert') });
        element.inert = true;
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    if (!artwork.contains(document.activeElement)) focusInside();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocus, true);
    for (const dialog of artwork.querySelectorAll('dialog[open]')) dialog.close();
    for (const { element, inert, attribute } of background) {
      element.inert = inert;
      if (attribute === null) element.removeAttribute('inert');
      else element.setAttribute('inert', attribute);
    }
    // Reverse order also preserves order when two dialogs were adjacent.
    for (const { element, parent, next } of [...dialogs].reverse()) {
      parent.insertBefore(element, next?.parentNode === parent ? next : null);
    }
    if (previousTabIndex === null) artwork.removeAttribute('tabindex');
    else artwork.setAttribute('tabindex', previousTabIndex);
    background = [];
    dialogs = [];
    const target = visible(trigger) ? trigger : visible(previousFocus) ? previousFocus : null;
    target?.focus({ preventScroll: true });
    previousFocus = null;
  }

  return { activate, deactivate };
}
