"use strict";

// The plugin's settings page (homebridge-ui/public/index.html + index.js),
// run for real in a VM against a small stand-in DOM, because jsdom is not a
// dependency here. Every element the page looks up exists with the id the
// shipped HTML gives it; a <select> carries the shipped HTML's own <option>s
// and follows the HTML rule that matters for settings: setting `.value` to a
// value no option has selects nothing, and `.value` then reads "".
//
// `window.homebridge` is Homebridge UI's plugin API as the page uses it: the
// saved config, the save calls and `request` to the plugin's UI server.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const UI = path.join(__dirname, "..", "homebridge-ui", "public");

function classList() {
  const names = new Set();
  return {
    add: (...n) => n.forEach((x) => names.add(x)),
    remove: (...n) => n.forEach((x) => names.delete(x)),
    toggle: (n, on) => {
      const want = on === undefined ? !names.has(n) : Boolean(on);
      if (want) names.add(n);
      else names.delete(n);
      return want;
    },
    contains: (n) => names.has(n),
    [Symbol.iterator]: () => names[Symbol.iterator](),
  };
}

function element(tag, id) {
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    disabled: false,
    readOnly: false,
    open: false,
    textContent: "",
    innerHTML: "",
    dataset: {},
    style: {},
    children: [],
    classList: classList(),
    parentElement: null,
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    dispatch(type) {
      for (const handler of listeners.get(type) || []) handler({ target: el });
    },
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    remove() {},
    focus() {},
    setAttribute(name, value) {
      el[name] = value;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  // Like the DOM: an input's value is always a string, checked a boolean.
  let value = "";
  let checked = false;
  Object.defineProperty(el, "value", {
    get: () => value,
    set: (next) => {
      value = next === null || next === undefined ? "" : String(next);
    },
    configurable: true,
  });
  Object.defineProperty(el, "checked", {
    get: () => checked,
    set: (next) => {
      checked = Boolean(next);
    },
  });
  return el;
}

/** A <select> with the shipped options and HTML's value semantics. */
function select(id, optionValues) {
  const el = element("select", id);
  const options = optionValues.map((value) => ({ value, textContent: value }));
  let selectedIndex = options.length > 0 ? 0 : -1;
  Object.defineProperty(el, "options", { get: () => options });
  Object.defineProperty(el, "value", {
    get: () => (selectedIndex >= 0 ? options[selectedIndex].value : ""),
    set: (value) => {
      selectedIndex = options.findIndex((o) => o.value === String(value));
    },
  });
  el.appendChild = (child) => {
    options.push(child);
    child.parentElement = el;
    return child;
  };
  el.add = el.appendChild;
  return el;
}

/**
 * @param {Record<string, unknown> | null} savedConfig the plugin's block
 * @param {{request?: (route: string, body: unknown) => Promise<unknown>}} [options]
 */
function loadSettingsPage(savedConfig, { request } = {}) {
  const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(UI, "index.js"), "utf8");

  const elements = new Map();
  for (const match of html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) {
    const [, tag, id] = match;
    if (tag === "select") {
      const start = match.index;
      const body = html.slice(start, html.indexOf("</select>", start));
      const values = [...body.matchAll(/<option[^>]*value="([^"]*)"/g)].map(
        (m) => m[1]
      );
      const el = select(id, values);
      el.parentElement = element("label", `${id}-parent`);
      elements.set(id, el);
    } else {
      const el = element(tag, id);
      el.parentElement = element("label", `${id}-parent`);
      elements.set(id, el);
    }
  }

  const configs = savedConfig
    ? [{ platform: "RoborockVacuumPlatform", ...savedConfig }]
    : [];
  const homebridge = {
    saved: configs,
    toasts: [],
    getPluginConfig: async () => JSON.parse(JSON.stringify(homebridge.saved)),
    updatePluginConfig: async (next) => {
      homebridge.saved = JSON.parse(JSON.stringify(next));
    },
    savePluginConfig: async () => undefined,
    request: request || (async () => ({ ok: false, message: "offline" })),
    toast: new Proxy(
      {},
      {
        get: (_target, type) => (message) =>
          homebridge.toasts.push({ type, message }),
      }
    ),
    addEventListener: () => undefined,
  };

  const document = {
    body: { classList: classList() },
    documentElement: { dataset: {} },
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => element(tag),
    addEventListener: () => undefined,
    querySelectorAll: () => [],
  };

  const context = vm.createContext({
    window: { homebridge, matchMedia: undefined },
    document,
    navigator: {},
    console,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    MutationObserver: class {
      observe() {}
    },
    URL,
    URLSearchParams,
  });
  vm.runInContext(js, context, { filename: "index.js" });

  return {
    homebridge,
    elements,
    element: (id) => elements.get(id),
    /** Evaluate an expression inside the page's own scope. */
    run: (code) => vm.runInContext(code, context),
    savedConfig: () =>
      homebridge.saved.find((c) => c.platform === "RoborockVacuumPlatform"),
  };
}

module.exports = { loadSettingsPage };
