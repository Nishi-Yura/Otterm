/**
 * Kotsume on screen (docs/08 §6.1, §6.2): the sprite with a 300 ms crossfade between moods, the
 * speech line, and the three places it can live — the assist bar (default, decision E4), the
 * status bar, or floating at the bottom right.
 */
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../i18n";
import "./mascot.css";
import { type Mood, type OutfitInfo, sprite } from "./sprite";
import type { MascotStore } from "./store";

const FADE_MS = 300;

/** The sprite at a whole-number scale of 16 px. Thinking rolls the pebble; `busy` juggles it. */
export function MascotSprite(props: { mood: Mood; size: number; outfit?: OutfitInfo; busy?: boolean }) {
  const [shown, setShown] = createSignal<Mood>(props.mood);
  const [leaving, setLeaving] = createSignal<Mood>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => props.mood,
      (mood, prev) => {
        if (prev === undefined || mood === prev) return;
        setLeaving(prev);
        setShown(mood);
        clearTimeout(timer);
        timer = setTimeout(() => setLeaving(undefined), FADE_MS);
      },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <span
      class="mascot-sprite"
      classList={{ thinking: shown() === "thinking", busy: !!props.busy }}
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
    >
      <Show when={leaving()} keyed>
        {(m) => <span class="mascot-frame leaving" innerHTML={sprite(m, props.outfit)} />}
      </Show>
      <Show when={shown()} keyed>
        {(m) => <span class="mascot-frame" innerHTML={sprite(m, props.outfit)} />}
      </Show>
    </span>
  );
}

export interface MascotProps {
  store: MascotStore;
  outfit?: OutfitInfo;
  /** A command is running long: the pebble juggles. */
  busy: boolean;
  onClick: () => void;
}

/** The current line with its buttons, inside the assist bar (§5.1: bar text, not a bubble). */
function SpeechLine(props: { store: MascotStore }) {
  return (
    <Show when={props.store.current()} keyed>
      {(s) => (
        <span class="mascot-speech" classList={{ alert: s.kind === "alert" }} data-ot="mascot-speech">
          <span class="mascot-speech-text">{s.text}</span>
          <For each={s.actions ?? []}>
            {(a) => (
              <button
                type="button"
                class="mt-button mt-button-small"
                classList={{ "mt-button-primary": !!a.primary }}
                onClick={() => {
                  a.run();
                  props.store.close(s.id);
                }}
              >
                {a.label}
              </button>
            )}
          </For>
          <button
            type="button"
            class="assist-close"
            title={t("action-close")}
            aria-label={t("action-close")}
            onClick={() => props.store.close(s.id)}
          >
            ×
          </button>
        </span>
      )}
    </Show>
  );
}

/** Screen readers hear every line: politely, or at once for alerts (§6.5). */
export function MascotLive(props: { store: MascotStore }) {
  const s = () => props.store.current();
  return (
    <>
      <div class="sr-only" aria-live="polite" role="status">
        {s() && s()?.kind !== "alert" ? s()?.text : ""}
      </div>
      <div class="sr-only" aria-live="assertive" role="alert">
        {s()?.kind === "alert" ? s()?.text : ""}
      </div>
    </>
  );
}

/** Kotsume at the left end of the assist bar, 24 px, with the line beside it. */
export function MascotDock(props: MascotProps) {
  return (
    <span class="mascot-dock" data-ot="mascot">
      <button
        type="button"
        class="mascot-button"
        title={t("mascot-click")}
        aria-label={t("mascot-click")}
        onClick={() => props.onClick()}
      >
        <MascotSprite mood={props.store.mood()} size={24} outfit={props.outfit} busy={props.busy} />
      </button>
      <SpeechLine store={props.store} />
    </span>
  );
}

/** Kotsume in the status bar, 16 px; the line pops up above it. */
export function MascotStatus(props: MascotProps) {
  return (
    <span class="mascot-status" data-ot="mascot">
      <button
        type="button"
        class="mascot-button"
        title={t("mascot-click")}
        aria-label={t("mascot-click")}
        onClick={() => props.onClick()}
      >
        <MascotSprite mood={props.store.mood()} size={16} outfit={props.outfit} busy={props.busy} />
      </button>
      <Show when={props.store.current()}>
        <span class="mascot-pop">
          <SpeechLine store={props.store} />
        </span>
      </Show>
    </span>
  );
}

const FLOAT_KEY = "otterm.mascot.float";

/** Floating at the bottom right, 48 px, half transparent over the terminal; drag to move. */
export function MascotFloat(props: MascotProps) {
  const read = (): { right: number; bottom: number } => {
    try {
      const v = JSON.parse(localStorage.getItem(FLOAT_KEY) ?? "null");
      if (typeof v?.right === "number" && typeof v?.bottom === "number") return v;
    } catch {
      // No storage (private window, cleared data): the default place.
    }
    return { right: 24, bottom: 64 };
  };
  const [pos, setPos] = createSignal(read());
  let drag: { x: number; y: number; right: number; bottom: number; moved: boolean } | undefined;
  const down = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, ...pos(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    const right = Math.max(0, Math.min(window.innerWidth - 56, drag.right - dx));
    const bottom = Math.max(0, Math.min(window.innerHeight - 56, drag.bottom - dy));
    setPos({ right, bottom });
  };
  const up = () => {
    if (!drag) return;
    const clicked = !drag.moved;
    drag = undefined;
    try {
      localStorage.setItem(FLOAT_KEY, JSON.stringify(pos()));
    } catch {
      // Not remembered; it still works.
    }
    if (clicked) props.onClick();
  };
  return (
    <div
      class="mascot-float"
      data-ot="mascot"
      style={{ right: `${pos().right}px`, bottom: `${pos().bottom}px` }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      title={t("mascot-click")}
    >
      <Show when={props.store.current()}>
        <span class="mascot-bubble">
          <SpeechLine store={props.store} />
        </span>
      </Show>
      <MascotSprite mood={props.store.mood()} size={48} outfit={props.outfit} busy={props.busy} />
    </div>
  );
}
