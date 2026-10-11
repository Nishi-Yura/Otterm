// The mod runtime inside the QuickJS sandbox: builds `ctx` (`@otterm/api`'s ModContext) for one
// mod and talks to the Worker glue (worker.ts) through `__host`. Plain ES2022, evaluated as global
// code before the mod's module. Everything that crosses to the glue is a JSON string.
//
// Capability-gated namespaces are simply not created when the manifest lacks the permission
// (docs/05 §6.1): the mod cannot call what does not exist, and the host checks again anyway.
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;

  let init;
  let modNs;
  let active = false;
  /** Everything to undo on deactivate: dispose functions in registration order. */
  let disposables = [];
  /** Callbacks the host may invoke by id. Rendered trees get fresh ids each render; generations
   * older than the last three are dropped so a click on a stale tree still finds its handler. */
  const fns = new Map();
  let nextFn = 1;
  const generations = [];
  let current = new Set();
  const persistent = new Set();
  /** Signals by id, for edits coming back from the UI. */
  const signals = new Map();
  let nextSig = 1;
  let renderScheduled = false;
  const warned = new Set();

  const HANDLERS = new Set([
    "onClick",
    "onSubmit",
    "onSelect",
    "onRowClick",
    "onDoubleClick",
    "onMessage",
    "loadChildren",
    "ref",
    "onShow",
    "onHide",
  ]);
  const LOCALIZED = new Set(["text", "tooltip", "secondary", "placeholder", "label", "title", "emptyText", "purpose"]);

  const post = (msg) => host.post(JSON.stringify(msg));
  const call = (method, ...args) =>
    host.call(method, JSON.stringify(args)).then((s) => (s === undefined || s === "" ? undefined : JSON.parse(s)));
  const safe = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === "function") return "[function]";
    if (typeof v === "bigint") return v.toString();
    return v;
  };
  const log = (level, args) => host.log(level, JSON.stringify(args.map(safe)));
  const warnOnce = (key, text) => {
    if (warned.has(key)) return;
    warned.add(key);
    log("warn", [text]);
  };
  const disposable = (f) => {
    let done = false;
    const d = {
      dispose() {
        if (done) return;
        done = true;
        disposables = disposables.filter((x) => x !== d);
        f();
      },
    };
    disposables.push(d);
    return d;
  };
  const noop = () => disposable(() => {});
  const later = (key, text) => {
    warnOnce(key, text);
    return noop();
  };

  // --- callbacks and signals -------------------------------------------------------------------

  const ref = (fn, keep) => {
    const id = nextFn++;
    fns.set(id, fn);
    if (keep) persistent.add(id);
    else current.add(id);
    return { $fn: id };
  };
  const rotate = () => {
    generations.push(current);
    current = new Set();
    while (generations.length > 3) {
      for (const id of generations.shift()) if (!persistent.has(id)) fns.delete(id);
    }
  };
  const schedule = () => {
    if (renderScheduled || !active) return;
    renderScheduled = true;
    host.schedule();
  };
  const signal = (initial) => {
    const id = nextSig++;
    let value = initial;
    const s = {
      __sig: id,
      get: () => value,
      set(v) {
        if (Object.is(v, value)) return;
        value = v;
        schedule();
      },
      update(f) {
        s.set(f(value));
      },
    };
    signals.set(id, s);
    return s;
  };
  const isSignal = (v) => v !== null && typeof v === "object" && typeof v.__sig === "number";
  const isLocalized = (v) =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !("type" in v) &&
    Object.values(v).every((x) => typeof x === "string");
  const resolve = (v) => {
    if (typeof v === "string") return v;
    if (v === null || typeof v !== "object") return String(v);
    return v[init.locale] ?? v.en ?? Object.values(v)[0] ?? "";
  };
  /** Resolve getters, signals and translations; swap functions for ids. */
  const ser = (v, key) => {
    if (typeof v === "function") return HANDLERS.has(key) ? ref(v, false) : ser(v(), key);
    if (v === null || typeof v !== "object") return v;
    if (isSignal(v)) return { $sig: v.__sig, value: ser(v.get(), key) };
    if (v instanceof Set) return [...v];
    if (v instanceof RegExp) return v.source;
    if (Array.isArray(v)) return v.map((x) => ser(x, key));
    if (LOCALIZED.has(key) && isLocalized(v)) return resolve(v);
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      out[k] = ser(x, k);
    }
    return out;
  };
  const serMenu = (items) =>
    (typeof items === "function" ? items() : items).map((m) => ({
      label: resolve(m.label),
      icon: m.icon,
      fn: ref(m.onClick, false).$fn,
      enabled: m.enabled,
      children: m.children ? serMenu(m.children) : undefined,
    }));

  // --- UI registrations ---------------------------------------------------------------------------

  let nextReg = 1;
  const slotItems = new Map();
  const panels = new Map();
  const menus = new Map();

  /** Open dialogs whose body is a function, by registration. */
  const dialogBodies = new Map();
  const render = () => {
    renderScheduled = false;
    if (!active) return;
    rotate();
    const items = [];
    for (const [reg, it] of slotItems) {
      items.push({ reg, slot: it.slot, order: it.order, node: ser(it.component, "content") });
    }
    const ps = [];
    for (const [reg, def] of panels) {
      const badge = def.badge === undefined ? undefined : ser(def.badge, "badge");
      ps.push({
        reg,
        id: def.id,
        title: resolve(def.title),
        icon: def.icon,
        slot: def.slot,
        badge: badge === undefined || badge === null ? undefined : String(badge),
        node: ser(def.content, "content"),
      });
    }
    // Dialog bodies given as a function re-render like panels while the dialog is open.
    const ds = [];
    for (const [reg, f] of dialogBodies) ds.push({ reg, node: ser(f(), "content") });
    post({ t: "ui", items, panels: ps, dialogs: ds });
    for (const [reg, m] of menus) post({ t: "contextMenu", target: m.target, reg, items: serMenu(m.items) });
  };

  const ui = {
    slot(name) {
      return {
        add(component, opts) {
          const reg = nextReg++;
          slotItems.set(reg, { slot: name, order: opts?.order ?? 100, component });
          schedule();
          return disposable(() => {
            slotItems.delete(reg);
            schedule();
          });
        },
      };
    },
    panel(def) {
      const reg = nextReg++;
      panels.set(reg, def);
      schedule();
      return disposable(() => {
        panels.delete(reg);
        schedule();
      });
    },
    toast(opts) {
      const actions = (opts.actions ?? []).map((a) => ({
        label: resolve(a.label),
        variant: a.variant,
        fn: ref(a.onClick, true).$fn,
      }));
      return call("ui.toast", { text: resolve(opts.text), kind: opts.kind, durationMs: opts.durationMs, actions });
    },
    dialog(opts) {
      const plain = opts.body === undefined || typeof opts.body === "string" || isLocalized(opts.body);
      const body = opts.body === undefined ? undefined : plain ? resolve(opts.body) : ser(opts.body, "content");
      const live = typeof opts.body === "function";
      const reg = live ? nextReg++ : undefined;
      if (live) dialogBodies.set(reg, opts.body);
      return call("ui.dialog", {
        title: resolve(opts.title),
        body,
        buttons: opts.buttons.map((b) => ({ id: b.id, label: resolve(b.label), variant: b.variant })),
        cancelId: opts.cancelId,
        reg,
      }).finally(() => {
        if (live) dialogBodies.delete(reg);
      });
    },
    pickPath(opts) {
      return call("ui.pickPath", { ...opts, title: opts.title === undefined ? undefined : resolve(opts.title) });
    },
    contextMenu(target, items) {
      const reg = nextReg++;
      menus.set(reg, { target, items });
      schedule();
      return disposable(() => {
        menus.delete(reg);
        post({ t: "contextMenu", target, reg, items: null });
      });
    },
    refresh: schedule,
  };

  // --- events -------------------------------------------------------------------------------------

  /** Whether Kotsume shows; the host updates it with a `mascot-visible` event. Subscribed on first
   * use: this file runs while the VM is still being set up, too early to talk to the host. */
  const mascotVisible = signal(true);
  let watchingMascot = false;
  const watchMascotVisible = () => {
    if (!watchingMascot) {
      watchingMascot = true;
      on("mascot-visible", (v) => mascotVisible.set(v !== false));
    }
    return mascotVisible;
  };
  const subs = new Map();
  const on = (name, cb) => {
    let set = subs.get(name);
    if (!set) {
      set = new Set();
      subs.set(name, set);
      post({ t: "subscribe", event: name });
    }
    set.add(cb);
    return disposable(() => {
      set.delete(cb);
      if (set.size === 0) {
        subs.delete(name);
        post({ t: "unsubscribe", event: name });
      }
    });
  };
  /** Calls the handlers; returns their results (for before-execute the host waits for them). */
  const dispatch = (name, payload) => {
    const set = subs.get(name);
    if (!set) return [];
    // An exception here is the mod's own: it reaches the glue, which reports a crash (docs/05 §4).
    const out = [];
    for (const cb of [...set]) {
      if (name.startsWith("custom:")) out.push(cb(payload.payload, payload.from));
      else out.push(cb(payload));
    }
    return out;
  };
  /** A provider registration: the host calls `fn` with the provider's arguments. */
  const provider = (kind, p, method, extra) => {
    const reg = nextReg++;
    const fn = ref((...args) => p[method](...args), true);
    post({ t: "provider", kind, reg, fn: fn.$fn, ...extra });
    return disposable(() => {
      fns.delete(fn.$fn);
      post({ t: "unprovide", reg });
    });
  };

  // --- the context --------------------------------------------------------------------------------

  const build = () => {
    const p = init.manifest.permissions;
    const settings = { ...init.settings };
    const settingSubs = new Set();
    let theme = init.theme;
    const themeSubs = new Set();
    const guideLevel = signal(init.guideLevel ?? 2);
    const hostSubs = new Set();
    // Namespaced already when it starts with this mod's id or looks like `<namespace>.<mod>.<name>`.
    const full = (id) => (id.startsWith(`${init.modId}.`) || id.split(".").length >= 3 ? id : `${init.modId}.${id}`);

    const ctx = {
      modId: init.modId,
      modPath: init.modPath,
      host: init.host,
      ui,
      signal,
      commands: {
        register(id, handler, meta) {
          const fn = ref((args) => handler(args), true);
          post({
            t: "command",
            id: full(id),
            title: resolve(meta.title),
            description: meta.description === undefined ? undefined : resolve(meta.description),
            icon: meta.icon,
            hidden: !!meta.hidden,
            fn: fn.$fn,
          });
          return disposable(() => {
            fns.delete(fn.$fn);
            post({ t: "unregister", kind: "command", id: full(id) });
          });
        },
        run: (id, args) => call("commands.run", full(id), args),
      },
      keybindings: {
        suggest(command, key, when) {
          post({ t: "keybinding", command: full(command), key, when });
          return noop();
        },
      },
      session: {
        current: () => call("session.current"),
        get: (id) => call("session.get", id),
        list: () => call("session.list"),
        onCwdChanged: (cb) => on("cwd-changed", cb),
        onCreated: (cb) => on("session-created", cb),
        onClosed: (cb) => on("session-closed", cb),
        onFocusChanged: (cb) => on("focus-changed", cb),
      },
      terminal: {
        insert: (text, opts) => call("terminal.insert", text, opts),
      },
      settings: {
        get: (key) => Promise.resolve(settings[key]),
        set(key, value) {
          settings[key] = value;
          return call("settings.set", key, value);
        },
        onChange(cb) {
          settingSubs.add(cb);
          return disposable(() => settingSubs.delete(cb));
        },
        host: {
          get: (key) => call("settings.host", key),
          set: (key, value) => call("settings.hostSet", key, value),
          onChange(cb) {
            hostSubs.add(cb);
            return disposable(() => hostSubs.delete(cb));
          },
        },
      },
      storage: {
        get: (key) => call("storage.get", key),
        set: (key, value) => call("storage.set", key, value),
        delete: (key) => call("storage.delete", key),
        keys: (prefix) => call("storage.keys", prefix),
        usage: () => call("storage.usage"),
      },
      theme: {
        current: () => Promise.resolve(theme),
        onChange(cb) {
          themeSubs.add(cb);
          return disposable(() => themeSubs.delete(cb));
        },
      },
      i18n: {
        t: (id, vars) => host.t(id, JSON.stringify(vars ?? {})) ?? id,
        locale: init.locale,
        resolve,
      },
      log: {
        debug: (...a) => log("debug", a),
        info: (...a) => log("info", a),
        warn: (...a) => log("warn", a),
        error: (...a) => log("error", a),
      },
      events: {
        emit: (name, payload) => void call("events.emit", name, payload),
        on: (name, cb) => on(`custom:${name}`, cb),
        onTitleChanged: (cb) => on("title-changed", cb),
      },
      // Input assist (docs/03 §8): the host owns the parser, the rule set and the dictionary;
      // providers are callbacks it invokes.
      assist: {
        parse: (line, opts) => call("assist.parse", line, opts),
        completions: { provide: (p) => provider("completion", p, "provide", { commands: p.commands }) },
        explain: { provide: (p) => provider("explain", p, "provide", { commands: p.commands }) },
        danger: {
          addRules(rules) {
            const reg = nextReg++;
            post({ t: "rules", reg, rules: ser(rules, "rules") });
            return disposable(() => post({ t: "rules", reg, rules: null }));
          },
          evaluate: (parsed) => call("assist.evaluate", parsed),
        },
        errorHints: { provide: (p) => provider("errorHint", p, "provide", {}) },
        dictionary: {
          add(entries) {
            const reg = nextReg++;
            post({ t: "dictionary", reg, entries: ser(entries, "entries") });
            return disposable(() => post({ t: "dictionary", reg, entries: null }));
          },
          lookup: (command) => call("assist.lookup", command),
        },
        guideLevel,
      },
      links: { addDetector: () => later("links", "links.addDetector does nothing until M4") },
      // Kotsume (docs/08 §6.3). At guide level 0 the host turns `say` into a toast by itself.
      mascot: {
        say: (text, opts) =>
          call("mascot.say", {
            text: resolve(text),
            mood: opts?.mood,
            duration: opts?.duration,
            urgent: opts?.urgent,
            // Buttons run the mod's own code; there is no "run in the terminal" button (§6.3).
            actions: (opts?.actions ?? []).map((a) => ({ label: resolve(a.label), fn: ref(a.onClick, true).$fn })),
          }),
        setMood: (mood, opts) => call("mascot.setMood", { mood, for: opts?.for }),
        onMoodChanged: (cb) => on("mascot-mood", (m) => cb(m)),
        get visible() {
          return watchMascotVisible();
        },
        reactions: {
          // Rules run here, in the mod's Worker: `when` is the mod's own function. The events reach
          // the mod only with the permissions the manifest declares (block events: terminal.read).
          add(rule) {
            const day = () => new Date().toDateString();
            let fired;
            return on(rule.on, (payload) => {
              if (rule.once === "per-session" && fired) return;
              if (rule.once === "per-day" && fired === day()) return;
              if (rule.once === "never" && fired) return;
              try {
                if (rule.when && !rule.when(payload)) return;
              } catch (e) {
                console.warn("mascot reaction failed", e);
                return;
              }
              fired = rule.once === "per-day" ? day() : true;
              if (rule.say) void call("mascot.say", { text: resolve(rule.say), mood: rule.mood, actions: [] });
              else if (rule.mood) void call("mascot.setMood", { mood: rule.mood, for: 3000 });
            });
          },
        },
        outfits: {
          // Outfits come from `outfit` mods (otmod.toml [outfit]); code cannot add one.
          register: () => later("outfits.register", "mascot.outfits.register: outfits are outfit mods (docs/08 §6.4)"),
          current: () => call("mascot.outfit"),
          list: () => call("mascot.outfits"),
        },
      },
      workspace: { current: () => Promise.resolve(undefined), onChanged: () => noop() },
    };

    if (p.terminalRead) {
      Object.assign(ctx.terminal, {
        onInputChange: (cb) => on("input-changed", cb),
        onBeforeExecute: (cb) => on("before-execute", cb),
        onBlockStart: (cb) => on("block-start", cb),
        onBlockEnd: (cb) => on("block-end", cb),
        screen: (id) => call("terminal.screen", id),
        blocks: (id, opts) => call("terminal.blocks", id, opts),
        selection: (id) => call("terminal.selection", id),
      });
      if (p.events.includes("output")) ctx.terminal.onOutput = (cb) => on("output", cb);
    }
    if (p.terminalWrite) ctx.terminal.write = (id, text) => call("terminal.write", id, text);
    // The user's AI provider (docs/10 §7). Keys, the preview and the log stay with the host.
    if (p.ai) {
      const plain = (req) => ({
        purpose: resolve(req.purpose),
        prompt: String(req.prompt ?? ""),
        system: req.system,
        context: req.context,
        maxTokens: req.maxTokens,
        json: !!req.json,
      });
      ctx.ai = {
        complete: (req) => call("ai.complete", plain(req), null),
        stream: (req, onChunk) => call("ai.complete", plain(req), ref(onChunk, true).$fn),
        available: () => call("ai.available"),
      };
    }
    if (p.fsRead.length > 0 || p.fsWrite.length > 0) {
      ctx.fs = {
        readText: (path, opts) => call("fs.readText", path, opts?.maxBytes),
        readBytes: (path, opts) => call("fs.readBytes", path, opts?.maxBytes).then(fromBase64),
        readDir: (path, opts) => call("fs.readDir", path, !!opts?.includeHidden),
        stat: (path) => call("fs.stat", path),
        exists: (path) => call("fs.exists", path),
        watch: () => later("fs.watch", "fs.watch is not available yet"),
        resolve: (template, sessionId) => call("fs.resolve", template, sessionId),
      };
      if (p.fsWrite.length > 0) ctx.fs.trash = (path) => call("fs.trash", path);
      if (p.fsWrite.length > 0) {
        Object.assign(ctx.fs, {
          writeText: (path, text) => call("fs.writeText", path, text),
          writeBytes: (path, data) => call("fs.writeBytes", path, toBase64(data)),
          mkdir: (path) => call("fs.mkdir", path),
          rename: (from, to) => call("fs.rename", from, to),
        });
      }
    }
    if (p.process.length > 0) {
      ctx.process = {
        run: (cmd, args, opts) => call("process.run", cmd, args, opts),
        spawn: () => Promise.reject(new Error("process.spawn is not available yet; use process.run")),
      };
    }
    if (p.network.length > 0) {
      ctx.http = {
        fetch: (url, opts) => {
          const body = opts?.body instanceof Uint8Array ? toBase64(opts.body) : opts?.body;
          return call("http.fetch", url, { ...opts, body, binary: opts?.body instanceof Uint8Array }).then((r) => {
            const bytes = fromBase64(r.body);
            const text = () => Promise.resolve(utf8(bytes));
            return {
              status: r.status,
              headers: r.headers,
              text,
              json: () => text().then(JSON.parse),
              bytes: () => Promise.resolve(bytes),
            };
          });
        },
      };
    }
    if (p.clipboard) {
      ctx.clipboard = { read: () => call("clipboard.read"), write: (text) => call("clipboard.write", text) };
    }

    ctx.__settings = (next, changed) => {
      Object.assign(settings, next);
      for (const key of changed) for (const cb of settingSubs) cb({ key, value: settings[key] });
    };
    ctx.__theme = (t) => {
      theme = t;
      for (const cb of themeSubs) cb(t);
    };
    ctx.__guide = (level) => guideLevel.set(level);
    ctx.__hostSetting = (key, value) => {
      if (key === "general.guide_level") guideLevel.set(value);
      for (const cb of hostSubs) cb({ key, value });
    };
    return ctx;
  };

  // --- base64 and UTF-8 (QuickJS has no atob or TextDecoder) ------------------------------------

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const toBase64 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63];
      out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
      out += i + 2 < bytes.length ? B64[n & 63] : "=";
    }
    return out;
  };
  const fromBase64 = (s) => {
    const clean = (s ?? "").replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let acc = 0;
    let bits = 0;
    let j = 0;
    for (const c of clean) {
      acc = ((acc << 6) | B64.indexOf(c)) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[j++] = (acc >> bits) & 255;
      }
    }
    return out.subarray(0, j);
  };
  const utf8 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++];
      let cp;
      if (b < 0x80) cp = b;
      else if (b < 0xe0) cp = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) cp = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      s += String.fromCodePoint(cp);
    }
    return s;
  };

  // --- what the glue calls ------------------------------------------------------------------------

  let ctx;
  globalThis.console = {
    log: (...a) => log("info", a),
    info: (...a) => log("info", a),
    debug: (...a) => log("debug", a),
    warn: (...a) => log("warn", a),
    error: (...a) => log("error", a),
  };
  globalThis.__otterm = {
    init(json) {
      init = JSON.parse(json);
      // Ids continue from the host's base for this Worker (host.ts `idBase`).
      nextFn = init.idBase ?? nextFn;
      nextSig = init.idBase ?? nextSig;
      ctx = build();
    },
    async activate(ns) {
      modNs = ns;
      if (typeof ns.activate !== "function") throw new Error("the entry module exports no activate()");
      active = true;
      await ns.activate(ctx);
      schedule();
    },
    async deactivate() {
      active = false;
      try {
        if (modNs && typeof modNs.deactivate === "function") await modNs.deactivate();
      } finally {
        for (const d of [...disposables].reverse()) d.dispose();
        disposables = [];
      }
    },
    /** Runs a callback; resolves to its (serialized) result as JSON, or undefined. */
    invoke(id, json) {
      const fn = fns.get(id);
      if (!fn) throw new Error(`no handler ${id}`);
      return Promise.resolve(fn(...JSON.parse(json))).then((r) =>
        r === undefined ? undefined : JSON.stringify(ser(r, "result")),
      );
    },
    /** Resolves to the handlers' (serialized) results as JSON. */
    dispatch(name, json) {
      return Promise.all(dispatch(name, JSON.parse(json))).then((r) => JSON.stringify(ser(r, "result")));
    },
    guide(level) {
      ctx.__guide(level);
    },
    hostSetting(key, json) {
      ctx.__hostSetting(key, JSON.parse(json));
    },
    setSignal(id, json) {
      signals.get(id)?.set(JSON.parse(json));
    },
    render,
    settings(json, changedJson) {
      ctx.__settings(JSON.parse(json), JSON.parse(changedJson));
    },
    theme(json) {
      ctx.__theme(JSON.parse(json));
    },
  };
})();
