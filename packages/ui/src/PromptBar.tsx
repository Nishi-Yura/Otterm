import { For, onMount, Show } from "solid-js";
import { Icon } from "./icons";

export interface PromptButton {
  label: string;
  action: () => void;
  /** `danger` for the choice that does the risky thing, `primary` for the suggested one. */
  kind?: "danger" | "primary";
}

export interface PromptProps {
  title: string;
  body?: string;
  /** Text shown as it will be sent (for example the start of a paste). */
  preview?: string;
  /** Escape picks `cancel`. */
  buttons: PromptButton[];
  /** Index of the button that gets the focus (the safe choice); default 0. */
  focus?: number;
  cancel: () => void;
  /** `danger` marks a risky command (an icon and a striped edge, not only color: decision I15). */
  tone?: "danger";
}

/** A question about the terminal, above its bottom edge: paste confirmation, clipboard requests. */
export function PromptBar(props: PromptProps) {
  let bar!: HTMLDivElement;
  onMount(() => (bar.querySelectorAll("button")[props.focus ?? 0] as HTMLButtonElement | undefined)?.focus());
  const onKeyDown = (e: KeyboardEvent) => {
    // Keys here answer the question; none of them go to the terminal.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.cancel();
    }
  };
  return (
    <div
      ref={bar}
      class="prompt"
      classList={{ danger: props.tone === "danger" }}
      role="alertdialog"
      aria-label={props.title}
      data-ot="prompt"
      onKeyDown={onKeyDown}
    >
      <div class="prompt-title">
        <Show when={props.tone === "danger"}>
          <Icon name="alert-triangle" class="prompt-icon" />
        </Show>
        {props.title}
      </div>
      <Show when={props.body}>
        <div class="prompt-body">{props.body}</div>
      </Show>
      <Show when={props.preview}>
        <pre class="prompt-preview">{props.preview}</pre>
      </Show>
      <div class="prompt-buttons">
        <For each={props.buttons}>
          {(b) => (
            <button
              type="button"
              class="prompt-button"
              classList={{ danger: b.kind === "danger", primary: b.kind === "primary" }}
              data-ot="prompt-button"
              onClick={() => b.action()}
            >
              {b.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
