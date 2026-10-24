// Small shared hooks for the UI kit. No dependencies beyond React.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

function subscribeMedia(query, callback) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const list = window.matchMedia(query);
  list.addEventListener("change", callback);
  return () => list.removeEventListener("change", callback);
}

/** Live boolean for a CSS media query. */
export function useMediaQuery(query) {
  return useSyncExternalStore(
    callback => subscribeMedia(query, callback),
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Layout class used by WorkshopLayout / PlayHUD: phone < 900px <= tablet < 1200px <= desktop. */
export function useLayoutSize() {
  const phone = useMediaQuery("(max-width: 899px)");
  const tablet = useMediaQuery("(max-width: 1199px)");
  return phone ? "phone" : tablet ? "tablet" : "desktop";
}

/** True when the OS asks for less motion, or the root forces data-motion="reduce". */
export function useReducedMotion() {
  const os = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [forced, setForced] = useState(false);
  useEffect(() => {
    const root = document.querySelector(".cl-root");
    if (!root) return undefined;
    const read = () => setForced(root.getAttribute("data-motion") === "reduce");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-motion"] });
    return () => observer.disconnect();
  }, []);
  return os || forced;
}

/** True on touch-first devices (no fine pointer). */
export function useCoarsePointer() {
  return useMediaQuery("(pointer: coarse)");
}

/** Ref that always holds the latest value (for callbacks inside effects). */
export function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Remember the previous value of something across renders. */
export function usePrevious(value) {
  const ref = useRef(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

/**
 * Roving focus for a horizontal or vertical group of elements (tabs, toolbars).
 * Returns an onKeyDown handler for the container.
 */
export function rovingKeyDown(event, { orientation = "horizontal", selector = "[data-roving]" } = {}) {
  const keys = orientation === "vertical" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (![...keys, "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll(selector)].filter(el => !el.disabled);
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  let next = index;
  if (event.key === keys[0]) next = index <= 0 ? items.length - 1 : index - 1;
  else if (event.key === keys[1]) next = index >= items.length - 1 ? 0 : index + 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  event.preventDefault();
  items[next].focus();
  return items[next];
}
