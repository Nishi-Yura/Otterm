import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { benchMode, runIpcBench } from "./bench";
import { keyToInput } from "./keys";
import { appendWithBackspace, CURSOR_POSITION_QUERY, toPlainText } from "./rawText";
import { createSession, type Session } from "./session";
import "./style.css";

// M0: no grid yet, so the PTY keeps a fixed size.
const COLS = 120;
const ROWS = 30;
// Keep the DOM small until scrollback exists (M1).
const MAX_CHARS = 200_000;

function App() {
  const [screen, setScreen] = createSignal("");
  const [exited, setExited] = createSignal<string>();
  let view!: HTMLPreElement;
  let session: Session | undefined;

  onMount(async () => {
    if ((await benchMode()) === "ipc") {
      await runIpcBench((line) =>
        setScreen(
          (s) => `${s}${line}
`,
        ),
      );
      return;
    }
    const decoder = new TextDecoder();
    try {
      session = await createSession(COLS, ROWS, {
        onOutput(bytes) {
          const text = decoder.decode(bytes, { stream: true });
          if (text.includes(CURSOR_POSITION_QUERY)) void session?.write("\x1b[1;1R");
          setScreen((s) => appendWithBackspace(s, toPlainText(text)).slice(-MAX_CHARS));
          view.scrollTop = view.scrollHeight;
        },
        onExit(code) {
          setExited(`[process exited${code === null ? "" : ` with code ${code}`}]`);
        },
      });
    } catch (e) {
      setExited(`[failed to start shell: ${String(e)}]`);
    }
    view.focus();
  });

  onCleanup(() => void session?.close());

  const onKeyDown = (e: KeyboardEvent) => {
    const input = keyToInput(e);
    if (input === undefined || !session) return;
    e.preventDefault();
    void session.write(input);
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || !session) return;
    e.preventDefault();
    void session.write(text.replace(/\r?\n/g, "\r"));
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the terminal surface takes keyboard input; screen reader support is M5.
    <pre ref={view} class="screen" tabIndex={0} onKeyDown={onKeyDown} onPaste={onPaste}>
      {screen()}
      <span class="cursor"> </span>
      {exited() && <div class="exited">{exited()}</div>}
    </pre>
  );
}

const root = document.getElementById("root");
if (root) render(() => <App />, root);
