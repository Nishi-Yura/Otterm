/**
 * One mod's Web Worker: starts QuickJS (WASM), evaluates the SDK (sdk.js) and then the mod's
 * bundle inside it, and relays messages between the sandbox and the host (host.ts). Decision C2:
 * the Worker is the first sandbox, QuickJS the second; the mod sees only `otterm`'s globals and
 * the four timer functions (decision M1).
 */
import { FluentBundle, FluentResource } from "@fluent/bundle";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { HostToWorker, ModInit, WorkerToHost } from "./protocol";
import sdkSource from "./sdk.js?raw";

/** Heap a mod may use. */
const MEMORY_LIMIT = 64 * 1024 * 1024;
const STACK_LIMIT = 1024 * 1024;

const send = (msg: WorkerToHost) => postMessage(msg);

let modulePromise: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
};

class Sandbox {
  private vm!: QuickJSContext;
  private runtime!: QuickJSRuntime;
  private api!: QuickJSHandle;
  /** Host calls awaiting a reply, by id. */
  private readonly pending = new Map<number, QuickJSDeferredPromise>();
  private nextCall = 1;
  /** Live timers: the callback handle and the real timer. */
  private readonly timers = new Map<number, { handle: QuickJSHandle; timer: ReturnType<typeof setTimeout> }>();
  private nextTimer = 1;
  private deadline = Number.POSITIVE_INFINITY;
  private dead = false;
  private bundles: FluentBundle[] = [];

  constructor(private readonly init: ModInit) {}

  async start() {
    const started = performance.now();
    const module = await quickjs();
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(MEMORY_LIMIT);
    this.runtime.setMaxStackSize(STACK_LIMIT);
    // A callback that runs past its deadline is interrupted (docs/05 §4: unresponsive for 5 s).
    this.runtime.setInterruptHandler(() => Date.now() > this.deadline);
    this.vm = this.runtime.newContext();
    this.bundles = loadLocales(this.init);
    this.installHost();
    this.enter(() => {
      this.vm.unwrapResult(this.vm.evalCode(sdkSource, "otterm-sdk.js", { type: "global" })).dispose();
      this.api = this.vm.getProp(this.vm.global, "__otterm");
      // The glue keeps its handle; the mod's code, evaluated next, must not reach `init` or `activate`.
      this.vm.unwrapResult(this.vm.evalCode("delete globalThis.__otterm", "otterm-sdk-hide.js")).dispose();
      this.callApi("init", this.vm.newString(JSON.stringify(this.init))).dispose();
    });
    if (this.dead) return;
    // The entry is one ESM file (docs/05 §3); its namespace holds activate / deactivate.
    const evaluated = this.enter(() =>
      this.vm.unwrapResult(this.vm.evalCode(this.init.source, `/${this.init.modId}/main.js`, { type: "module" })),
    );
    if (!evaluated || this.dead) return;
    const ns = await this.settle(evaluated);
    if (!ns || this.dead) return;
    // `callApi` disposes its arguments, `ns` included.
    const activated = this.enter(() => this.callApi("activate", ns));
    if (!activated || this.dead) return;
    const done = await this.settle(activated);
    done?.dispose();
    if (!this.dead) send({ t: "activated", ms: Math.round(performance.now() - started) });
  }

  handle(msg: HostToWorker) {
    if (this.dead) return;
    switch (msg.t) {
      case "event": {
        const r = this.enter(() => this.callApi("dispatch", this.vm.newString(msg.name), this.json(msg.payload)));
        const id = msg.id;
        if (!r) {
          if (id !== undefined) send({ t: "result", id, ok: false, error: "the mod crashed" });
          break;
        }
        if (id === undefined) {
          // Handlers run on their own; a rejection surfaces as a crash through `settle`.
          void this.settle(r).then((v) => v?.dispose());
          break;
        }
        void this.settle(r, (e) => send({ t: "result", id, ok: false, error: e })).then((v) => {
          if (!v) return;
          const value = this.vm.typeof(v) === "string" ? JSON.parse(this.vm.getString(v)) : undefined;
          v.dispose();
          send({ t: "result", id, ok: true, value });
        });
        break;
      }
      case "guide":
        this.enter(() => this.callApi("guide", this.vm.newNumber(msg.level)).dispose());
        break;
      case "hostSetting":
        this.enter(() => this.callApi("hostSetting", this.vm.newString(msg.key), this.json(msg.value)).dispose());
        break;
      case "invoke": {
        const r = this.enter(() => this.callApi("invoke", this.vm.newNumber(msg.fn), this.json(msg.args)));
        if (!r) {
          send({ t: "result", id: msg.id, ok: false, error: "the mod crashed" });
          break;
        }
        void this.settle(r, (e) => send({ t: "result", id: msg.id, ok: false, error: e })).then((v) => {
          if (!v) return;
          const value = this.vm.typeof(v) === "string" ? JSON.parse(this.vm.getString(v)) : undefined;
          v.dispose();
          send({ t: "result", id: msg.id, ok: true, value });
        });
        break;
      }
      case "signal":
        this.enter(() => this.callApi("setSignal", this.vm.newNumber(msg.sig), this.json(msg.value)).dispose());
        break;
      case "reply": {
        const deferred = this.pending.get(msg.id);
        if (!deferred) break;
        this.pending.delete(msg.id);
        this.enter(() => {
          if (msg.ok) {
            const h = msg.value === undefined ? this.vm.undefined : this.vm.newString(JSON.stringify(msg.value));
            deferred.resolve(h);
            if (h !== this.vm.undefined) h.dispose();
          } else {
            const e = this.vm.newError(msg.error ?? "error");
            deferred.reject(e);
            e.dispose();
          }
          deferred.dispose();
        });
        break;
      }
      case "settings":
        this.enter(() => this.callApi("settings", this.json(msg.settings), this.json(msg.changed)).dispose());
        break;
      case "theme":
        this.enter(() => this.callApi("theme", this.json(msg.theme)).dispose());
        break;
      case "deactivate": {
        const r = this.enter(() => this.callApi("deactivate"));
        const finish = () => {
          this.stopTimers();
          send({ t: "deactivated" });
          this.dead = true;
        };
        if (r) {
          void this.settle(r, finish).then((v) => {
            v?.dispose();
            finish();
          });
        } else finish();
        break;
      }
      case "ping":
        send({ t: "pong", id: msg.id });
        break;
      case "init":
        break;
    }
  }

  /** Functions the SDK (not the mod) calls: `__host.*`, and the timers as globals. */
  private installHost() {
    const vm = this.vm;
    const host = vm.newObject();
    const fn = (name: string, f: (...args: QuickJSHandle[]) => QuickJSHandle | undefined) => {
      const h = vm.newFunction(name, (...args) => f(...args) ?? vm.undefined);
      vm.setProp(host, name, h);
      h.dispose();
    };
    fn("post", (json) => {
      send(JSON.parse(vm.getString(json)) as WorkerToHost);
      return undefined;
    });
    fn("log", (level, json) => {
      send({ t: "log", level: vm.getString(level) as "info", args: JSON.parse(vm.getString(json)) });
      return undefined;
    });
    fn("call", (method, json) => {
      const id = this.nextCall++;
      const deferred = vm.newPromise();
      this.pending.set(id, deferred);
      send({ t: "call", id, method: vm.getString(method), args: JSON.parse(vm.getString(json)) });
      return deferred.handle.dup();
    });
    fn("t", (id, json) => {
      const text = this.translate(vm.getString(id), JSON.parse(vm.getString(json)));
      return text === undefined ? undefined : vm.newString(text);
    });
    fn("schedule", () => {
      setTimeout(() => {
        if (!this.dead) this.enter(() => this.callApi("render").dispose());
      });
      return undefined;
    });
    vm.setProp(vm.global, "__host", host);
    host.dispose();

    const timer = (name: string, repeat: boolean) => {
      const h = vm.newFunction(name, (cb, ms) => {
        const id = this.nextTimer++;
        const delay = ms ? vm.getNumber(ms) : 0;
        const handle = cb.dup();
        const fire = () => {
          if (this.dead) return;
          if (!repeat) this.timers.delete(id);
          this.enter(() => vm.unwrapResult(vm.callFunction(handle, vm.undefined)).dispose());
          if (!repeat) handle.dispose();
        };
        const t = repeat ? setInterval(fire, delay) : setTimeout(fire, delay);
        this.timers.set(id, { handle, timer: t });
        return vm.newNumber(id);
      });
      vm.setProp(vm.global, name, h);
      h.dispose();
    };
    const clear = (name: string) => {
      const h = vm.newFunction(name, (id) => {
        const t = this.timers.get(vm.getNumber(id));
        if (!t) return vm.undefined;
        this.timers.delete(vm.getNumber(id));
        clearTimeout(t.timer);
        clearInterval(t.timer);
        t.handle.dispose();
        return vm.undefined;
      });
      vm.setProp(vm.global, name, h);
      h.dispose();
    };
    timer("setTimeout", false);
    timer("setInterval", true);
    clear("clearTimeout");
    clear("clearInterval");
  }

  /** Timers left running when a mod is deactivated are stopped for it (decision M1). */
  private stopTimers() {
    for (const t of this.timers.values()) {
      clearTimeout(t.timer);
      clearInterval(t.timer);
      t.handle.dispose();
    }
    this.timers.clear();
  }

  private callApi(name: string, ...args: QuickJSHandle[]): QuickJSHandle {
    const f = this.vm.getProp(this.api, name);
    try {
      return this.vm.unwrapResult(this.vm.callFunction(f, this.api, ...args));
    } finally {
      f.dispose();
      for (const a of args) if (a !== this.vm.undefined) a.dispose();
    }
  }

  private json(value: unknown): QuickJSHandle {
    return this.vm.newString(JSON.stringify(value === undefined ? null : value));
  }

  /**
   * Run sandbox code with the deadline armed, then the jobs it queued. Any exception, including
   * an interrupt, is a crash of the mod: the host deactivates it (docs/05 §4).
   */
  private enter<T>(f: () => T): T | undefined {
    if (this.dead) return undefined;
    this.deadline = Date.now() + this.init.deadlineMs;
    try {
      const r = f();
      this.drain();
      return r;
    } catch (e) {
      this.crash(e);
      return undefined;
    } finally {
      this.deadline = Number.POSITIVE_INFINITY;
    }
  }

  private drain() {
    const r = this.runtime.executePendingJobs();
    if (r.error) {
      const e = this.vm.dump(r.error);
      r.error.dispose();
      throw e;
    }
  }

  /** A native promise for a sandbox value (a promise or not). `onError` runs if it rejects. */
  private async settle(handle: QuickJSHandle, onError?: (e: string) => void): Promise<QuickJSHandle | undefined> {
    const p = this.vm.resolvePromise(handle);
    handle.dispose();
    // The jobs that settle it may have queued after `enter` drained.
    this.enter(() => undefined);
    const r = await p;
    if (this.dead) return undefined;
    if (r.error) {
      const e = describe(this.vm.dump(r.error));
      r.error.dispose();
      if (onError) onError(e);
      else this.crash(e);
      return undefined;
    }
    return r.value;
  }

  private crash(e: unknown) {
    if (this.dead) return;
    this.dead = true;
    this.stopTimers();
    send({ t: "crash", message: describe(e) });
  }

  private translate(id: string, vars: Record<string, string | number>): string | undefined {
    for (const b of this.bundles) {
      const m = b.getMessage(id);
      if (m?.value) return b.formatPattern(m.value, vars);
    }
    return undefined;
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.stack ? `${e.message}\n${e.stack}` : e.message;
  if (e && typeof e === "object") {
    const o = e as { name?: string; message?: string; stack?: string };
    const head = o.name && o.message ? `${o.name}: ${o.message}` : (o.message ?? JSON.stringify(e));
    return o.stack ? `${head}\n${o.stack}` : head;
  }
  return String(e);
}

/** The mod's Fluent bundles: the UI locale first, then English (docs/05 §3, decision C7). */
function loadLocales(init: ModInit): FluentBundle[] {
  const order = [init.locale, "en"].filter((l, i, a) => a.indexOf(l) === i);
  const bundles: FluentBundle[] = [];
  for (const lang of order) {
    const src = init.locales[lang];
    if (!src) continue;
    const b = new FluentBundle(lang, { useIsolating: false });
    b.addResource(new FluentResource(src));
    bundles.push(b);
  }
  return bundles;
}

let sandbox: Sandbox | undefined;
addEventListener("message", (e: MessageEvent<HostToWorker>) => {
  const msg = e.data;
  if (msg.t === "init") {
    sandbox = new Sandbox(msg.init);
    sandbox.start().catch((err) => send({ t: "crash", message: describe(err) }));
    return;
  }
  sandbox?.handle(msg);
});
send({ t: "ready" });
