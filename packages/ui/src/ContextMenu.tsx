import { For, onCleanup, onMount } from "solid-js";

export interface MenuItem {
  label: string;
  /** Shown on the right, e.g. the keyboard shortcut. */
  hint?: string;
  disabled?: boolean;
  action: () => void;
}

export interface ContextMenuProps {
  /** Position in CSS pixels relative to the terminal. */
  x: number;
  y: number;
  items: MenuItem[];
  close: () => void;
}

/** The terminal's right-click menu (decision I1). Closes on Escape, a click elsewhere, or blur. */
export function ContextMenu(props: ContextMenuProps) {
  let menu!: HTMLDivElement;

  const onPointerDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) props.close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.close();
    }
  };
  onMount(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", props.close);
    // Keep the menu inside the window.
    const r = menu.getBoundingClientRect();
    const parent = menu.offsetParent?.getBoundingClientRect();
    if (parent) {
      if (r.right > parent.right) menu.style.left = `${Math.max(0, props.x - r.width)}px`;
      if (r.bottom > parent.bottom) menu.style.top = `${Math.max(0, props.y - r.height)}px`;
    }
    (menu.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus();
  });
  onCleanup(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", props.close);
  });

  return (
    <div
      ref={menu}
      class="menu"
      role="menu"
      data-ot="context-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-ot="menu-item"
            disabled={item.disabled}
            onClick={() => {
              props.close();
              item.action();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span class="menu-hint">{item.hint}</span>}
          </button>
        )}
      </For>
    </div>
  );
}
