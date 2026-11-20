/*
 * Shared product theme state.
 *
 * This file is intentionally dependency-free because it is embedded into both
 * client factories by scripts/build-client.mjs. Keep the browser guards here:
 * the settings shell can be rendered by host test doubles and in restricted
 * webviews where localStorage, MutationObserver, or matchMedia is unavailable.
 */
const PRODUCT_THEME_KEY = "pi-purge-ui-theme";
const PRODUCT_THEME_EVENT = "pi-purge-ui-theme-change";
const PRODUCT_THEME_MODES = Object.freeze(["dusk", "white", "system"]);
const PRODUCT_THEME_DEFAULT = "system";

function productThemeWindow(options) {
	if (options && Object.prototype.hasOwnProperty.call(options, "window")) return options.window;
	return typeof window !== "undefined" ? window : undefined;
}

function productThemeDocument(options, win) {
	if (options && Object.prototype.hasOwnProperty.call(options, "document")) return options.document;
	return typeof document !== "undefined" ? document : win && win.document;
}

function productThemeStorage(options, win) {
	if (options && Object.prototype.hasOwnProperty.call(options, "storage")) return options.storage;
	try { return win && win.localStorage; } catch { return undefined; }
}

function productThemeMode(value) {
	return PRODUCT_THEME_MODES.includes(value) ? value : "";
}

function productThemeMedia(options = {}) {
	const win = productThemeWindow(options);
	try {
		if (!win || typeof win.matchMedia !== "function") return "";
		const media = win.matchMedia("(prefers-color-scheme: dark)");
		if (!media || typeof media.matches !== "boolean") return "";
		return media.matches ? "dusk" : "white";
	} catch { /* restricted webviews may throw */ }
	return "";
}

function productThemeBooleanAttribute(target, name) {
	if (!target || !target.hasAttribute?.(name)) return false;
	const value = String(target.getAttribute?.(name) ?? "").trim().toLowerCase();
	return !["false", "0", "off", "no"].includes(value);
}

function productThemeHost(options = {}) {
	const win = productThemeWindow(options);
	const doc = productThemeDocument(options, win);
	const targets = [doc && doc.body, doc && doc.documentElement];
	try {
		for (const target of targets) {
			if (!target) continue;
			if (productThemeBooleanAttribute(target, "data-ds-dark-theme") || productThemeBooleanAttribute(target, "dark")) return "dusk";
			const attr = String(target.getAttribute?.("data-theme") || "").toLowerCase();
			if (attr === "dusk" || attr === "dark") return "dusk";
			if (attr === "white" || attr === "light") return "white";
		}

		const root = doc && doc.documentElement;
		const view = (doc && doc.defaultView) || win;
		const computed = typeof options.getComputedStyle === "function"
			? options.getComputedStyle(root)
			: (view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(root) : null);
		const scheme = String(
			(root && root.style && root.style.colorScheme)
			|| (computed && (computed.colorScheme || computed.getPropertyValue?.("color-scheme")))
			|| "",
		).toLowerCase();
		const schemes = scheme.split(/\s+/).filter(Boolean);
		if (schemes.includes("dark") && schemes.includes("light")) {
			const media = productThemeMedia({ ...options, window: win, document: doc });
			if (media) return media;
			return schemes[0] === "dark" ? "dusk" : "white";
		}
		if (schemes.includes("dark")) return "dusk";
		if (schemes.includes("light")) return "white";
	} catch { /* host inspection is best effort */ }

	const media = productThemeMedia({ ...options, window: win, document: doc });
	if (media) return media;
	return "white";
}

function createProductTheme(options = {}) {
	const win = productThemeWindow(options);
	const doc = productThemeDocument(options, win);
	const storage = productThemeStorage(options, win);
	const listeners = new Set();
	let volatileMode = "";
	let storageUnavailable = !storage;
	let teardown = null;

	const readStoredMode = () => {
		if (!storage || typeof storage.getItem !== "function") {
			storageUnavailable = true;
			return "";
		}
		try {
			const stored = productThemeMode(storage.getItem(PRODUCT_THEME_KEY));
			storageUnavailable = false;
			return stored;
		} catch {
			storageUnavailable = true;
			return "";
		}
	};

	const mode = () => {
		if (volatileMode) return volatileMode;
		const stored = readStoredMode();
		if (stored) return stored;
		return PRODUCT_THEME_DEFAULT;
	};

	const host = () => productThemeHost({ ...options, window: win, document: doc });
	const system = () => productThemeMedia({ ...options, window: win, document: doc }) || host();
	const read = () => {
		const selected = mode();
		return selected === "system" ? system() : selected;
	};

	const notify = () => {
		const resolved = read();
		const selected = mode();
		for (const listener of [...listeners]) {
			try { listener(resolved, selected); } catch { /* one subscriber cannot break the others */ }
		}
	};

	const dispatch = () => {
		if (!win || typeof win.dispatchEvent !== "function") {
			notify();
			return;
		}
		try {
			const EventCtor = win.CustomEvent
				|| (typeof CustomEvent !== "undefined" ? CustomEvent : undefined)
				|| (typeof Event !== "undefined" ? Event : undefined);
			if (typeof EventCtor === "function") {
				win.dispatchEvent(new EventCtor(PRODUCT_THEME_EVENT, { detail: { mode: mode() } }));
				return;
			}
		} catch { /* fall through to direct notification */ }
		notify();
	};

	const start = () => {
		if (teardown) return;
		const cleanups = [];
		const onThemeEvent = (event) => {
			const selected = productThemeMode(event && event.detail && event.detail.mode);
			if (selected) volatileMode = selected;
			notify();
		};
		const onStorage = (event) => {
			if (!event || event.key === PRODUCT_THEME_KEY || event.key === null) {
				volatileMode = "";
				notify();
			}
		};
		const add = (target, type, listener, optionsArg) => {
			if (!target || typeof target.addEventListener !== "function") return false;
			try {
				target.addEventListener(type, listener, optionsArg);
				cleanups.push(() => {
					try { target.removeEventListener?.(type, listener, optionsArg); } catch { /* ignore */ }
				});
				return true;
			} catch { return false; }
		};

		add(win, PRODUCT_THEME_EVENT, onThemeEvent);
		add(win, "storage", onStorage);

		let media;
		try {
			media = win && typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
			if (media) {
				const onMedia = () => notify();
				if (typeof media.addEventListener === "function") {
					media.addEventListener("change", onMedia);
					cleanups.push(() => { try { media.removeEventListener?.("change", onMedia); } catch { /* ignore */ } });
				} else if (typeof media.addListener === "function") {
					media.addListener(onMedia);
					cleanups.push(() => { try { media.removeListener?.(onMedia); } catch { /* ignore */ } });
				}
			}
		} catch { /* matchMedia is optional */ }

		const Observer = (options && options.MutationObserver)
			|| (win && win.MutationObserver)
			|| (doc && doc.MutationObserver)
			|| (typeof MutationObserver !== "undefined" ? MutationObserver : undefined);
		try {
			if (Observer && doc) {
				const observer = new Observer(() => notify());
				const config = { attributes: true, attributeFilter: ["data-ds-dark-theme", "data-theme", "dark", "class", "style"] };
				if (doc.body) observer.observe(doc.body, config);
				if (doc.documentElement) observer.observe(doc.documentElement, config);
				cleanups.push(() => { try { observer.disconnect?.(); } catch { /* ignore */ } });
			}
		} catch { /* MutationObserver is optional */ }

		teardown = () => {
			for (const cleanup of cleanups.splice(0)) cleanup();
			teardown = null;
		};
	};

	const subscribe = (listener) => {
		if (typeof listener !== "function") return () => {};
		listeners.add(listener);
		start();
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && teardown) teardown();
		};
	};

	const set = (next) => {
		const selected = productThemeMode(next);
		if (!selected) return read();
		let persisted = false;
		if (storage && typeof storage.setItem === "function") {
			try {
				storage.setItem(PRODUCT_THEME_KEY, selected);
				storageUnavailable = false;
				persisted = true;
			} catch { storageUnavailable = true; }
		}
		volatileMode = persisted ? "" : selected;
		dispatch();
		return read();
	};

	return Object.freeze({
		key: PRODUCT_THEME_KEY,
		event: PRODUCT_THEME_EVENT,
		modes: PRODUCT_THEME_MODES,
		defaultMode: PRODUCT_THEME_DEFAULT,
		mode,
		read,
		set,
		subscribe,
		host,
	});
}

const productTheme = createProductTheme();

export { createProductTheme, productTheme };
