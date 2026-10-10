import { For, onMount, Show } from "solid-js";

export interface PromptButton {
  label: string;
  action: () => void;
}

export interface PromptProps {
  title: string;
  body?: string;
  /** Text shown as it will be sent (for example the start of a paste). */
  preview?: string;
  /** The first button gets the focus; Escape picks `cancel`. */
  buttons: PromptButton[];
  cancel: () => void;
}

/** A question about the terminal, above its bottom edge: paste confirmation, clipboard requests. */
export function PromptBar(props: PromptProps) {
  let bar!: HTMLDivElement;
  onMount(() => (bar.querySelector("button") as HTMLButtonElement | null)?.focus());
  const onKeyDown = (e: KeyboardEvent) => {
    // Keys here answer the question; none of them go to the terminal.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.cancel();
    }
  };
  return (
    <div ref={bar} class="prompt" role="alertdialog" aria-label={props.title} data-ot="prompt" onKeyDown={onKeyDown}>
      <div class="prompt-title">{props.title}</div>
      <Show when={props.body}>
        <div class="prompt-body">{props.body}</div>
      </Show>
      <Show when={props.preview}>
        <pre class="prompt-preview">{props.preview}</pre>
      </Show>
      <div class="prompt-buttons">
        <For each={props.buttons}>
          {(b) => (
            <button type="button" class="prompt-button" onClick={() => b.action()}>
              {b.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
