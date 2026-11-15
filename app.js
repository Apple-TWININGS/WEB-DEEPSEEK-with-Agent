/* ============================================================
   DeepSeek Web · application
   Chat is the default surface. Agent is an explicit, observable mode.
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "deepseek-web.state.v1";
  var VERSION = 1;
  var DEFAULT_WALLPAPER = {
    enabled: false,
    activeId: "",
    opacity: 78,
    blur: 0,
    brightness: 100,
    scale: 106,
    glassBlur: 18,
    glassOpacity: 62,
    rotate: false,
    interval: 60
  };
  var DEFAULT_SETTINGS = {
    theme: "system",
    deepThink: false,
    webSearch: false,
    mode: "chat",
    sidebarCollapsed: false,
    bannerDismissed: false,
    wallpaper: {},
    wallpapers: []
  };

  function makeDefaultSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, {
      wallpaper: Object.assign({}, DEFAULT_WALLPAPER),
      wallpapers: []
    });
  }

  var state = {
    conversations: [],
    activeId: null,
    settings: makeDefaultSettings(),
    wallpapers: [],
    wallpaperTimer: null,
    wallpaperLayers: [],
    wallpaperLayerIndex: 0,
    currentWallpaperId: "",
    wallpaperUrls: new Map(),
    wallpaperThumbs: new Map(),
    wallpaperLoadToken: 0,
    wallpaperThumbObserver: null,
    mdWorker: null,
    mdSeq: 0,
    mdJobs: new Map(),
    mdCallbacks: new Map(),
    assetDb: null,
    server: {
      online: false,
      checking: true,
      error: null,
      key: { configured: false, hint: "", source: "未配置" },
      search: false,
      agent: false,
      version: ""
    },
    streaming: null,
    pendingConfirm: null,
    attachments: [],
    searchQuery: "",
    saveTimer: null,
    thinkTimer: null,
    auth: { required: false, authenticated: true },
    lan: { lan: false, url: "", addresses: [], authRequired: false },
    workspace: { path: "", defaultPath: "", exists: false },
    workspaceBrowsePath: "",
    fullAccess: { active: false, expiresAt: 0 },
    fullAccessTimer: null
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var escapeHtml = function (s) { return window.DSMarkdown.escapeHtml(s); };
  var escapeAttr = function (s) {
    return escapeHtml(s).replace(/`/g, "&#96;");
  };
  var icon = function (name, cls) {
    return '<svg' + (cls ? ' class="' + cls + '"' : "") + ' aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  };
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  var uid = function (prefix) {
    var rnd = "";
    if (window.crypto && crypto.randomUUID) return (prefix || "id") + "-" + crypto.randomUUID();
    rnd = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return (prefix || "id") + "-" + rnd;
  };
  var now = function () { return Date.now(); };

  var els = {};

  /* ============================================================
     Utilities
     ============================================================ */
  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function clampNumber(value, min, max, fallback) {
    var n = Number(value);
    if (!isFinite(n)) n = fallback;
    return Math.max(min, Math.min(max, n));
  }

  function fmtClock(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fmtRelative(ts) {
    if (!ts) return "";
    var diff = now() - ts;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前";
    var d = new Date(ts);
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return fmtClock(ts);
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + " 天前";
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return "";
    if (ms < 1000) return Math.max(1, Math.round(ms / 100)) / 10 + "s";
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + "s";
    var m = Math.floor(s / 60);
    return m + "m " + Math.round(s % 60) + "s";
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  function dayStart(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      var timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", function () {
          clearTimeout(timer);
          reject(abortError());
        }, { once: true });
      }
    });
  }

  function abortError() {
    try { return new DOMException("Aborted", "AbortError"); }
    catch (e) { var err = new Error("Aborted"); err.name = "AbortError"; return err; }
  }

  function isAbort(err) { return err && (err.name === "AbortError" || /aborted/i.test(err.message || "")); }

  function truncate(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function safeHref(raw) {
    var u = String(raw || "").trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (e) { return "网页"; }
  }

  function copyText(text) {
    text = String(text == null ? "" : text);
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      try {
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("复制失败"));
      } catch (e) {
        document.body.removeChild(ta);
        reject(e);
      }
    });
  }

  function downloadFile(filename, content, type) {
    var blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function safeFilename(name, fallback) {
    var s = String(name || fallback || "deepseek")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return s || "deepseek";
  }

  /* ============================================================
     Storage
     ============================================================ */
  function makeConversation(mode) {
    return {
      id: uid("conv"),
      title: "",
      mode: mode || "chat",
      createdAt: now(),
      updatedAt: now(),
      messages: [],
      draft: "",
      hasAgent: false,
      workspace: ""
    };
  }

  function sanitizeConversation(raw) {
    if (!raw || typeof raw !== "object") return null;
    var conv = {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid("conv"),
      title: typeof raw.title === "string" ? raw.title.slice(0, 120) : "",
      mode: raw.mode === "agent" ? "agent" : "chat",
      createdAt: Number(raw.createdAt) || now(),
      updatedAt: Number(raw.updatedAt) || now(),
      messages: [],
      draft: typeof raw.draft === "string" ? raw.draft.slice(0, 24000) : "",
      hasAgent: !!raw.hasAgent,
      workspace: typeof raw.workspace === "string" ? raw.workspace.slice(0, 500) : ""
    };
    if (Array.isArray(raw.messages)) {
      conv.messages = raw.messages.map(function (m) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
        var msg = {
          id: typeof m.id === "string" && m.id ? m.id : uid("msg"),
          role: m.role,
          content: typeof m.content === "string" ? m.content : "",
          reasoning: typeof m.reasoning === "string" ? m.reasoning : "",
          createdAt: Number(m.createdAt) || now(),
          endedAt: Number(m.endedAt) || 0,
          streaming: false,
          stopped: !!m.stopped,
          error: typeof m.error === "string" ? m.error : "",
          demo: !!m.demo,
          mode: m.mode === "agent" ? "agent" : "chat",
          modelLabel: typeof m.modelLabel === "string" ? m.modelLabel : "",
          feedback: m.feedback === "up" || m.feedback === "down" ? m.feedback : "",
          sources: Array.isArray(m.sources) ? m.sources.filter(function (s) { return s && safeHref(s.url); }).slice(0, 12) : [],
          attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 8).map(function (a) {
            return { id: a.id || uid("att"), name: String(a.name || "附件").slice(0, 160), size: Number(a.size) || 0, content: String(a.content || "").slice(0, 140000) };
          }) : [],
          usage: m.usage && typeof m.usage === "object" ? m.usage : null,
          agent: null
        };
        if (m.agent && typeof m.agent === "object") {
          msg.agent = {
            status: m.agent.status === "done" ? "done" : (m.agent.status === "error" ? "error" : (m.agent.status === "stopped" ? "stopped" : "running")),
            startedAt: Number(m.agent.startedAt) || msg.createdAt,
            endedAt: Number(m.agent.endedAt) || 0,
            statusText: typeof m.agent.statusText === "string" ? m.agent.statusText : "",
            open: m.agent.open !== false,
            plan: Array.isArray(m.agent.plan) ? m.agent.plan.slice(0, 20).map(String) : [],
            steps: Array.isArray(m.agent.steps) ? m.agent.steps.slice(0, 40).map(function (s) {
              s = s || {};
              var step = Object.assign({}, s, { id: s.id || uid("step") });
              if (step.status === "waiting") {
                step.status = "error";
                step.detail = "页面刷新，审批已失效，未写入文件。";
                step.confirmation = null;
              }
              return step;
            }) : [],
            sources: Array.isArray(m.agent.sources) ? m.agent.sources.slice(0, 20) : [],
            artifacts: Array.isArray(m.agent.artifacts) ? m.agent.artifacts.slice(0, 20).map(function (a) {
              a = a || {};
              var url = typeof a.url === "string" && a.url.indexOf("/api/files/") === 0 ? a.url : "";
              return {
                name: String(a.name || "产出文件").slice(0, 160),
                path: String(a.path || "").slice(0, 240),
                size: Number(a.size) || 0,
                url: url,
                demoContent: typeof a.demoContent === "string" ? a.demoContent.slice(0, 600000) : ""
              };
            }).reduce(function (acc, item) {
              var existing = acc.findIndex(function (a) { return (a.path && a.path === item.path) || a.name === item.name; });
              if (existing >= 0) acc[existing] = item;
              else acc.push(item);
              return acc;
            }, []) : [],
            runId: typeof m.agent.runId === "string" ? m.agent.runId : ""
          };
          if (msg.agent.status === "running") {
            msg.agent.status = "stopped";
            msg.agent.open = true;
            msg.agent.statusText = "页面刷新，执行已中断";
          }
        }
        if (m.streaming) {
          msg.stopped = true;
        }
        return msg;
      }).filter(Boolean);
    }
    return conv;
  }

  function loadState() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { raw = null; }
    if (raw && typeof raw === "object") {
      var savedSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
      state.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
      state.settings.wallpaper = Object.assign({}, DEFAULT_WALLPAPER, savedSettings.wallpaper || {});
      state.settings.wallpaper.opacity = clampNumber(state.settings.wallpaper.opacity, 20, 100, 78);
      state.settings.wallpaper.blur = clampNumber(state.settings.wallpaper.blur, 0, 30, 0);
      state.settings.wallpaper.brightness = clampNumber(state.settings.wallpaper.brightness, 50, 140, 100);
      state.settings.wallpaper.scale = clampNumber(state.settings.wallpaper.scale, 100, 140, 106);
      state.settings.wallpaper.glassBlur = clampNumber(state.settings.wallpaper.glassBlur, 0, 30, 18);
      state.settings.wallpaper.glassOpacity = clampNumber(state.settings.wallpaper.glassOpacity, 20, 95, 62);
      state.settings.wallpaper.interval = clampNumber(state.settings.wallpaper.interval, 15, 3600, 60);
      state.settings.wallpaper.enabled = !!state.settings.wallpaper.enabled;
      state.settings.wallpaper.rotate = !!state.settings.wallpaper.rotate;
      state.settings.wallpapers = Array.isArray(savedSettings.wallpapers)
        ? savedSettings.wallpapers.filter(function (w) { return w && typeof w.id === "string" && w.id; }).map(function (w) {
          return {
            id: w.id,
            name: typeof w.name === "string" ? w.name.slice(0, 180) : "壁纸",
            size: Number(w.size) || 0,
            addedAt: Number(w.addedAt) || now()
          };
        })
        : [];
      if (["light", "dark", "system"].indexOf(state.settings.theme) === -1) state.settings.theme = "system";
      if (state.settings.mode !== "agent") state.settings.mode = "chat";
      state.conversations = Array.isArray(raw.conversations)
        ? raw.conversations.map(sanitizeConversation).filter(Boolean)
        : [];
      state.activeId = typeof raw.activeId === "string" ? raw.activeId : null;
    }
    if (!state.conversations.length) {
      var conv = makeConversation(state.settings.mode);
      state.conversations = [conv];
      state.activeId = conv.id;
    }
    var active = state.conversations.find(function (c) { return c.id === state.activeId; });
    if (!active) {
      active = state.conversations.find(function (c) { return !c.messages.length; }) || state.conversations[0];
      state.activeId = active.id;
    }
    // Each conversation owns its mode. Empty/new conversations start in chat;
    // reopening an Agent conversation restores Agent without a toggle.
    if (!active.messages.length) active.mode = "chat";
    state.settings.mode = active.mode === "agent" ? "agent" : "chat";
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 280);
  }

  function flushSave() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: VERSION,
        activeId: state.activeId,
        settings: state.settings,
        conversations: state.conversations
      }));
    } catch (e) {
      console.warn("save failed", e);
      toast("本地存储空间不足，附件或壁纸信息可能未能保存", "error");
    }
  }

  /* ============================================================
     Wallpapers (unlimited, IndexedDB for image blobs)
     ============================================================ */
  var ASSET_DB_NAME = "deepseek-web-assets";
  var ASSET_STORE = "wallpapers";

  function openAssetDb() {
    if (state.assetDb) return Promise.resolve(state.assetDb);
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("当前浏览器不支持 IndexedDB"));
      var req = indexedDB.open(ASSET_DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(ASSET_STORE)) req.result.createObjectStore(ASSET_STORE);
      };
      req.onsuccess = function () {
        state.assetDb = req.result;
        resolve(req.result);
      };
      req.onerror = function () { reject(req.error || new Error("无法打开本地图片库")); };
    });
  }

  function idbGet(id) {
    return openAssetDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ASSET_STORE, "readonly");
        var req = tx.objectStore(ASSET_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(id, blob) {
    return openAssetDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ASSET_STORE, "readwrite");
        tx.objectStore(ASSET_STORE).put(blob, id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("写入本地图片库失败")); };
        tx.onabort = function () { reject(tx.error || new Error("写入本地图片库被中止")); };
      });
    });
  }

  function idbDelete(id) {
    return openAssetDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ASSET_STORE, "readwrite");
        tx.objectStore(ASSET_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function currentWallpaper() {
    var id = state.settings.wallpaper.activeId;
    return state.wallpapers.find(function (w) { return w.id === id; }) || null;
  }

  function wallpaperThumbKey(id) {
    return id + "::thumb";
  }

  function pruneWallpaperUrlCache() {
    while (state.wallpaperUrls.size > 6) {
      var removed = false;
      for (var entry of state.wallpaperUrls.entries()) {
        if (entry[0] !== state.settings.wallpaper.activeId) {
          URL.revokeObjectURL(entry[1]);
          state.wallpaperUrls.delete(entry[0]);
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
  }

  async function getWallpaperUrl(id) {
    if (state.wallpaperUrls.has(id)) return state.wallpaperUrls.get(id);
    var blob = await idbGet(id);
    if (!blob) throw new Error("壁纸文件不存在");
    var url = URL.createObjectURL(blob);
    state.wallpaperUrls.set(id, url);
    pruneWallpaperUrlCache();
    return url;
  }

  function createWallpaperThumbnail(file) {
    return new Promise(function (resolve) {
      var objectUrl = URL.createObjectURL(file);
      var img = new Image();
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        URL.revokeObjectURL(objectUrl);
        resolve(value);
      }
      img.onload = function () {
        try {
          var maxW = 360;
          var maxH = 240;
          var scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) { finish(blob || null); }, "image/jpeg", 0.78);
        } catch (e) {
          finish(null);
        }
      };
      img.onerror = function () { finish(null); };
      img.src = objectUrl;
    });
  }

  function loadWallpaperThumb(el) {
    var id = el && el.dataset ? el.dataset.thumbId : "";
    if (!id) return;
    if (state.wallpaperThumbs.has(id)) {
      el.style.backgroundImage = 'url("' + state.wallpaperThumbs.get(id) + '")';
      el.classList.add("is-loaded");
      return;
    }
    (async function () {
      var cached = state.wallpaperThumbs.get(id);
      if (cached) {
        el.style.backgroundImage = 'url("' + cached + '")';
        el.classList.add("is-loaded");
        return;
      }
      var blob = null;
      try {
        blob = await idbGet(wallpaperThumbKey(id));
        if (!blob) blob = await idbGet(id);
      } catch (e) {
        return;
      }
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      state.wallpaperThumbs.set(id, url);
      if (el.isConnected) {
        el.style.backgroundImage = 'url("' + url + '")';
        el.classList.add("is-loaded");
      }
    })();
  }

  function observeWallpaperThumbs() {
    if (!els.wallpaperGrid) return;
    if (state.wallpaperThumbObserver) {
      state.wallpaperThumbObserver.disconnect();
      state.wallpaperThumbObserver = null;
    }
    var thumbs = $$(".wallpaper-slot-thumb[data-thumb-id]:not(.is-loaded)", els.wallpaperGrid);
    if (!thumbs.length) return;
    if (!("IntersectionObserver" in window)) {
      thumbs.forEach(loadWallpaperThumb);
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadWallpaperThumb(entry.target);
      });
    }, { root: els.wallpaperGrid, rootMargin: "240px" });
    thumbs.forEach(function (el) { observer.observe(el); });
    state.wallpaperThumbObserver = observer;
  }

  function ensureWallpaperLayers() {
    if (!els.wallpaperSlides) return;
    if (state.wallpaperLayers.length === 2 && els.wallpaperSlides.children.length === 2) return;
    els.wallpaperSlides.innerHTML = '<div class="wallpaper-slide"></div><div class="wallpaper-slide"></div>';
    state.wallpaperLayers = $$(".wallpaper-slide", els.wallpaperSlides);
    state.wallpaperLayerIndex = 0;
    state.currentWallpaperId = "";
  }

  async function updateWallpaperImage(force) {
    ensureWallpaperLayers();
    var wp = currentWallpaper();
    if (!wp) {
      state.wallpaperLayers.forEach(function (layer) { layer.classList.remove("is-active"); });
      state.currentWallpaperId = "";
      return;
    }
    if (!force && state.currentWallpaperId === wp.id) return;
    var token = ++state.wallpaperLoadToken;
    var url;
    try {
      url = await getWallpaperUrl(wp.id);
    } catch (e) {
      if (token === state.wallpaperLoadToken) toast("无法读取壁纸文件：" + (e.message || "文件已被清理"), "error");
      return;
    }
    if (token !== state.wallpaperLoadToken) return;
    if (!state.settings.wallpaper.enabled || state.settings.wallpaper.activeId !== wp.id) return;
    var targetIndex = 1 - state.wallpaperLayerIndex;
    var target = state.wallpaperLayers[targetIndex];
    target.style.backgroundImage = 'url("' + url + '")';
    // Make sure the new image is decoded before the opacity transition starts.
    void target.offsetWidth;
    state.wallpaperLayers.forEach(function (layer, i) {
      layer.classList.toggle("is-active", i === targetIndex);
    });
    state.wallpaperLayerIndex = targetIndex;
    state.currentWallpaperId = wp.id;
  }

  function updateWallpaperIndicator() {
    var wp = state.settings.wallpaper;
    var hasImages = state.wallpapers.length > 0;
    var on = hasImages && wp.enabled;
    if (els.wallpaperBtn) {
      els.wallpaperBtn.classList.toggle("is-active", on);
      els.wallpaperBtn.title = on ? "壁纸已启用" : "壁纸与玻璃效果";
    }
    if (els.wallpaperCount) {
      els.wallpaperCount.textContent = state.wallpapers.length + " 张壁纸";
    }
    if (els.wallpaperEnabled) {
      els.wallpaperEnabled.classList.toggle("is-on", on);
      els.wallpaperEnabled.setAttribute("aria-checked", on ? "true" : "false");
      var label = els.wallpaperEnabled.querySelector("em");
      if (label) label.textContent = on ? "已启用" : "启用";
    }
    if (els.wallpaperDisable) els.wallpaperDisable.disabled = !hasImages;
  }

  function applyWallpaper() {
    var wp = state.settings.wallpaper;
    var hasImages = state.wallpapers.length > 0;
    var on = hasImages && wp.enabled;
    document.body.classList.toggle("has-wallpaper", on);
    var root = document.documentElement.style;
    root.setProperty("--wp-opacity", (clampNumber(wp.opacity, 20, 100, 78) / 100).toFixed(2));
    root.setProperty("--wp-blur", clampNumber(wp.blur, 0, 30, 0) + "px");
    root.setProperty("--wp-brightness", (clampNumber(wp.brightness, 50, 140, 100) / 100).toFixed(2));
    root.setProperty("--wp-scale", (clampNumber(wp.scale, 100, 140, 106) / 100).toFixed(2));
    root.setProperty("--glass-blur", clampNumber(wp.glassBlur, 0, 30, 18) + "px");
    root.setProperty("--glass-opacity", (clampNumber(wp.glassOpacity, 20, 95, 62) / 100).toFixed(2));
    updateWallpaperIndicator();
    if (!on) {
      state.wallpaperLoadToken++;
      state.wallpaperLayers.forEach(function (layer) { layer.classList.remove("is-active"); });
      state.currentWallpaperId = "";
      return;
    }
    updateWallpaperImage();
  }

  function syncWallpaperControls() {
    var wp = state.settings.wallpaper;
    if (!els.wpOpacity) return;
    setRangeValue("wpOpacity", wp.opacity, "wpOpacityOut", "%");
    setRangeValue("wpBlur", wp.blur, "wpBlurOut", "px");
    setRangeValue("wpBrightness", wp.brightness, "wpBrightnessOut", "%");
    setRangeValue("wpScale", wp.scale, "wpScaleOut", "%");
    setRangeValue("glassBlur", wp.glassBlur, "glassBlurOut", "px");
    setRangeValue("glassOpacity", wp.glassOpacity, "glassOpacityOut", "%");
    els.wpRotate.checked = !!wp.rotate;
    els.wpInterval.value = String(wp.interval);
    updateWallpaperIndicator();
  }

  function setRangeValue(inputId, value, outputId, suffix) {
    var input = document.getElementById(inputId);
    var output = document.getElementById(outputId);
    if (input) input.value = value;
    if (output) output.textContent = value + suffix;
  }

  function renderWallpaperSlots() {
    if (!els.wallpaperGrid) return;
    var activeId = state.settings.wallpaper.activeId;
    var html = state.wallpapers.map(function (w) {
      var active = w.id === activeId;
      var thumbUrl = state.wallpaperThumbs.get(w.id) || "";
      return '<div class="wallpaper-slot' + (active ? " is-active" : "") + '" data-wallpaper-id="' + escapeAttr(w.id) + '" role="button" tabindex="0" aria-label="使用壁纸 ' + escapeAttr(w.name) + '">' +
        '<div class="wallpaper-slot-thumb' + (thumbUrl ? " is-loaded" : "") + '" data-thumb-id="' + escapeAttr(w.id) + '"' +
        (thumbUrl ? ' style="background-image:url(&quot;' + escapeAttr(thumbUrl) + '&quot;)"' : "") + "></div>" +
        '<div class="wallpaper-slot-shade"></div>' +
        (active ? '<span class="wallpaper-slot-badge">使用中</span>' : "") +
        '<span class="wallpaper-slot-name">' + escapeHtml(w.name) + "</span>" +
        '<div class="wallpaper-slot-actions">' +
        '<button class="wallpaper-slot-action" type="button" data-wallpaper-remove="' + escapeAttr(w.id) + '" aria-label="删除这张壁纸" title="删除">' + icon("trash") + "</button>" +
        "</div></div>";
    }).join("");
    html += '<button class="wallpaper-add" type="button" data-wallpaper-add>' + icon("upload") + "<span>添加壁纸</span></button>";
    els.wallpaperGrid.innerHTML = html;
    observeWallpaperThumbs();
    updateWallpaperIndicator();
  }

  function normalizeWallpaper(file) {
    if (/^image\/gif$/i.test(file.type || "")) return Promise.resolve(file);
    return new Promise(function (resolve) {
      var objectUrl = URL.createObjectURL(file);
      var img = new Image();
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        URL.revokeObjectURL(objectUrl);
        resolve(value || file);
      }
      img.onload = function () {
        try {
          var maxW = 2560;
          var maxH = 1600;
          var scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
          var needsResize = scale < 1 || file.size > 2.5 * 1024 * 1024;
          if (!needsResize) {
            finish(file);
            return;
          }
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (blob && blob.size < file.size) finish(blob);
            else {
              canvas.toBlob(function (jpg) { finish(jpg && jpg.size < file.size ? jpg : file); }, "image/jpeg", 0.85);
            }
          }, "image/webp", 0.82);
        } catch (e) {
          finish(file);
        }
      };
      img.onerror = function () { finish(file); };
      img.src = objectUrl;
    });
  }

  async function hasWallpaperStorageRoom(bytes) {
    if (!navigator.storage || !navigator.storage.estimate) return true;
    try {
      var estimate = await navigator.storage.estimate();
      var quota = Number(estimate.quota) || 0;
      var usage = Number(estimate.usage) || 0;
      if (!quota) return true;
      if (usage + bytes > quota * 0.9) {
        toast("浏览器本地存储接近上限，请删除一些壁纸或清理站点数据", "error", 5000);
        return false;
      }
    } catch (e) {
      /* estimate is advisory */
    }
    return true;
  }

  async function updateWallpaperStorageInfo() {
    if (!els.wallpaperStorage) return;
    if (!navigator.storage || !navigator.storage.estimate) {
      els.wallpaperStorage.textContent = "浏览器未提供存储配额信息";
      return;
    }
    try {
      var estimate = await navigator.storage.estimate();
      var usage = Number(estimate.usage) || 0;
      var quota = Number(estimate.quota) || 0;
      els.wallpaperStorage.textContent = "已用 " + fmtSize(usage) + (quota ? " / 可用配额 " + fmtSize(quota) : "");
      els.wallpaperStorage.classList.toggle("is-warn", quota > 0 && usage / quota > 0.75 && usage / quota <= 0.9);
      els.wallpaperStorage.classList.toggle("is-error", quota > 0 && usage / quota > 0.9);
    } catch (e) {
      els.wallpaperStorage.textContent = "存储配额读取失败";
    }
  }

  async function addWallpapers(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var added = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!/^image\//i.test(file.type || "")) {
        toast("「" + file.name + "」不是图片文件", "error");
        continue;
      }
      if (file.size > 15 * 1024 * 1024) {
        toast("「" + file.name + "」超过 15 MB，未添加", "error");
        continue;
      }
      var id = uid("wallpaper");
      var stored = await normalizeWallpaper(file);
      if (!(await hasWallpaperStorageRoom(stored.size))) continue;
      try {
        await idbPut(id, stored);
      } catch (e) {
        toast("保存壁纸失败：" + (e.message || "本地空间不足"), "error", 5000);
        continue;
      }
      var thumb = await createWallpaperThumbnail(stored);
      if (thumb) {
        try { await idbPut(wallpaperThumbKey(id), thumb); } catch (e) { /* thumbnail is optional */ }
      }
      var meta = { id: id, name: file.name || "壁纸", size: stored.size, addedAt: now() };
      state.settings.wallpapers.push(meta);
      state.wallpapers.push(meta);
      state.wallpaperUrls.set(id, URL.createObjectURL(stored));
      added.push(meta);
    }
    els.wallpaperInput.value = "";
    if (!added.length) return;
    state.settings.wallpaper.activeId = added[added.length - 1].id;
    state.settings.wallpaper.enabled = true;
    state.currentWallpaperId = "";
    pruneWallpaperUrlCache();
    renderWallpaperSlots();
    syncWallpaperControls();
    applyWallpaper();
    startWallpaperRotation();
    scheduleSave();
    updateWallpaperStorageInfo();
    toast("已添加 " + added.length + " 张壁纸", "success");
  }

  function removeWallpaper(id) {
    var index = state.wallpapers.findIndex(function (w) { return w.id === id; });
    if (index === -1) return;
    var removed = state.wallpapers[index];
    state.wallpapers.splice(index, 1);
    state.settings.wallpapers = state.settings.wallpapers.filter(function (w) { return w.id !== id; });
    var cachedUrl = state.wallpaperUrls.get(id);
    if (cachedUrl) URL.revokeObjectURL(cachedUrl);
    state.wallpaperUrls.delete(id);
    var cachedThumb = state.wallpaperThumbs.get(id);
    if (cachedThumb) URL.revokeObjectURL(cachedThumb);
    state.wallpaperThumbs.delete(id);
    idbDelete(id).catch(function () {});
    idbDelete(wallpaperThumbKey(id)).catch(function () {});
    if (state.settings.wallpaper.activeId === id) {
      var next = state.wallpapers[Math.min(index, state.wallpapers.length - 1)];
      state.settings.wallpaper.activeId = next ? next.id : "";
      state.currentWallpaperId = "";
      if (!state.wallpapers.length) state.settings.wallpaper.enabled = false;
    }
    renderWallpaperSlots();
    syncWallpaperControls();
    applyWallpaper();
    startWallpaperRotation();
    scheduleSave();
    updateWallpaperStorageInfo();
    toast("已删除壁纸");
  }

  function setActiveWallpaper(id) {
    var wp = state.wallpapers.find(function (w) { return w.id === id; });
    if (!wp) return;
    state.settings.wallpaper.activeId = id;
    state.settings.wallpaper.enabled = true;
    state.currentWallpaperId = "";
    renderWallpaperSlots();
    syncWallpaperControls();
    applyWallpaper();
    startWallpaperRotation();
    scheduleSave();
  }

  function stopWallpaperRotation() {
    if (state.wallpaperTimer) {
      clearInterval(state.wallpaperTimer);
      state.wallpaperTimer = null;
    }
  }

  function startWallpaperRotation() {
    stopWallpaperRotation();
    var wp = state.settings.wallpaper;
    if (!wp.enabled || !wp.rotate || state.wallpapers.length < 2) return;
    var seconds = clampNumber(wp.interval, 15, 3600, 60);
    state.wallpaperTimer = setInterval(function () {
      if (!state.settings.wallpaper.enabled || state.wallpapers.length < 2) return;
      var currentId = state.settings.wallpaper.activeId;
      var idx = state.wallpapers.findIndex(function (w) { return w.id === currentId; });
      var next = state.wallpapers[(idx + 1 + state.wallpapers.length) % state.wallpapers.length];
      if (!next) return;
      state.settings.wallpaper.activeId = next.id;
      state.currentWallpaperId = "";
      applyWallpaper();
      renderWallpaperSlots();
      scheduleSave();
    }, seconds * 1000);
  }

  function initWallpapers() {
    ensureWallpaperLayers();
    var metas = Array.isArray(state.settings.wallpapers) ? state.settings.wallpapers : [];
    state.wallpapers = metas.map(function (w) {
      return { id: w.id, name: w.name || "壁纸", size: w.size || 0, addedAt: w.addedAt || now() };
    });
    var wp = state.settings.wallpaper;
    if (!state.wallpapers.length) {
      wp.enabled = false;
      wp.activeId = "";
    } else if (!state.wallpapers.some(function (w) { return w.id === wp.activeId; })) {
      wp.activeId = state.wallpapers[0].id;
    }
    renderWallpaperSlots();
    syncWallpaperControls();
    applyWallpaper();
    startWallpaperRotation();
    scheduleSave();
    updateWallpaperStorageInfo();
  }

  /* ============================================================
     Theme
     ============================================================ */
  function prefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function effectiveTheme() {
    if (state.settings.theme === "system") return prefersDark() ? "dark" : "light";
    return state.settings.theme;
  }

  function applyTheme() {
    var theme = effectiveTheme();
    document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#16181d" : "#ffffff");
    if (els.themeToggle) {
      els.themeToggle.innerHTML = icon(theme === "dark" ? "sun" : "moon");
      els.themeToggle.setAttribute("aria-label", theme === "dark" ? "切换到浅色主题" : "切换到深色主题");
    }
    $$(".theme-option").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.themeChoice === state.settings.theme);
    });
  }

  /* ============================================================
     LAN authentication
     ============================================================ */
  function showLoginScreen() {
    if (!els.loginScreen) return;
    els.loginScreen.hidden = false;
    document.body.classList.add("login-open");
    setTimeout(function () {
      if (els.loginPassword) els.loginPassword.focus();
    }, 80);
  }

  function hideLoginScreen() {
    if (!els.loginScreen) return;
    els.loginScreen.hidden = true;
    document.body.classList.remove("login-open");
  }

  async function initAuth() {
    try {
      var res = await fetchTimeout("/api/auth/status", { cache: "no-store" }, 3000);
      if (res.ok) {
        var data = await res.json();
        state.auth = data || state.auth;
        if (data.required && !data.authenticated) {
          showLoginScreen();
          loadLanInfo();
          return;
        }
      }
    } catch (e) {
      /* if the auth probe fails, fall through to the normal offline UI */
    }
    hideLoginScreen();
    await refreshServerStatus();
    loadLanInfo();
    loadWorkspaceInfo();
  }

  async function submitLogin() {
    var password = els.loginPassword.value;
    if (!password) {
      els.loginError.textContent = "请输入访问口令";
      return;
    }
    els.loginSubmit.disabled = true;
    els.loginError.textContent = "";
    try {
      var res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || "登录失败");
      state.auth.required = true;
      state.auth.authenticated = true;
      hideLoginScreen();
      els.loginPassword.value = "";
      await refreshServerStatus();
      await loadLanInfo();
      await loadWorkspaceInfo();
      toast("已解锁局域网访问", "success");
    } catch (e) {
      els.loginError.textContent = friendlyError(e);
      els.loginPassword.select();
    } finally {
      els.loginSubmit.disabled = false;
    }
  }

  async function logoutLan() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
    } catch (e) { /* clear locally regardless */ }
    state.auth.authenticated = false;
    showLoginScreen();
    toast("已退出局域网访问");
  }

  async function loadLanInfo() {
    try {
      var res = await fetch("/api/lan-info", { cache: "no-store" });
      if (!res.ok) return;
      state.lan = await res.json();
      renderLanInfo();
    } catch (e) { /* LAN info is optional */ }
  }

  function renderLanInfo() {
    if (!els.lanStatusPill) return;
    var data = state.lan || {};
    var enabled = !!data.lan && !!data.url;
    els.lanStatusPill.className = "status-pill " + (enabled ? "is-ok" : "");
    els.lanStatusPill.innerHTML = "<span></span>" + (enabled ? "局域网" : "本机模式");
    if (els.lanCard) els.lanCard.classList.toggle("no-qr", !enabled);
    if (els.lanQr) {
      if (enabled) els.lanQr.src = "/api/lan-qr.svg?t=" + Date.now();
      else els.lanQr.removeAttribute("src");
    }
    if (els.lanUrl) els.lanUrl.textContent = enabled ? data.url : "仅本机访问";
    if (els.lanHint) {
      if (!enabled) {
        els.lanHint.innerHTML = "运行 <code>start-lan.cmd</code> 后，这里会显示局域网地址和二维码。";
      } else if (data.authRequired) {
        els.lanHint.textContent = "手机打开后，输入电脑控制台显示的访问口令。";
      } else {
        els.lanHint.textContent = "当前未启用访问口令，只建议在可信网络使用。";
      }
    }
    if (els.logoutBtn) els.logoutBtn.hidden = !state.auth.required;
  }

  var FULL_ACCESS_MS = 60 * 60 * 1000;

  function isFullAccessActive() {
    return !!(state.fullAccess && state.fullAccess.active && Date.now() < state.fullAccess.expiresAt);
  }

  function updateFullAccessUI() {
    var active = isFullAccessActive();
    if (state.fullAccess && state.fullAccess.active && !active) state.fullAccess.active = false;
    if (els.fullAccessPill) {
      els.fullAccessPill.className = "status-pill " + (active ? "is-error" : "");
      els.fullAccessPill.innerHTML = "<span></span>" + (active ? "完全权限" : "逐次确认");
    }
    if (els.fullAccessHint) {
      els.fullAccessHint.textContent = active
        ? "完全权限已开启：Agent 写文件时不再逐次确认，仍保留 .bak 备份。"
        : "Agent 写文件前会展示 diff，需要你点击允许。";
    }
    if (els.permissionSection) els.permissionSection.classList.toggle("is-on", active);
    if (els.fullAccessSettingsBtn) {
      els.fullAccessSettingsBtn.innerHTML = active
        ? icon("shield") + "关闭完全权限"
        : icon("shield") + "开启完全权限";
    }
    if (els.agentAccessBtn) {
      els.agentAccessBtn.classList.toggle("is-on", active);
      if (els.agentAccessText) els.agentAccessText.textContent = active ? "完全权限" : "逐次确认";
    }
  }

  function openFullAccessDialog() {
    if (isFullAccessActive()) {
      disableFullAccess();
      return;
    }
    if (state.streaming) {
      toast("请先停止当前任务，再修改权限", "error");
      return;
    }
    if (!els.fullAccessDialog.open) {
      els.fullAccessDialog.showModal();
      document.body.classList.add("dialog-open");
    }
    els.fullAccessAck.checked = false;
    els.fullAccessEnable.disabled = true;
    els.fullAccessWorkspacePath.textContent = state.workspace.path || "当前工作区";
  }

  function enableFullAccess() {
    if (!els.fullAccessAck.checked) return;
    state.fullAccess.active = true;
    state.fullAccess.expiresAt = Date.now() + FULL_ACCESS_MS;
    closeDialog(els.fullAccessDialog);
    updateFullAccessUI();
    if (state.fullAccessTimer) clearTimeout(state.fullAccessTimer);
    state.fullAccessTimer = setTimeout(function () {
      state.fullAccess.active = false;
      state.fullAccess.expiresAt = 0;
      updateFullAccessUI();
      toast("完全权限已到期，恢复逐次确认", "error", 5000);
    }, FULL_ACCESS_MS);
    toast("完全权限已开启，60 分钟后自动失效", "error", 4500);
  }

  function disableFullAccess(silent) {
    state.fullAccess.active = false;
    state.fullAccess.expiresAt = 0;
    if (state.fullAccessTimer) {
      clearTimeout(state.fullAccessTimer);
      state.fullAccessTimer = null;
    }
    updateFullAccessUI();
    if (!silent) toast("已关闭完全权限，恢复逐次确认");
  }

  function activeConversationWorkspace() {
    var conv = state.conversations.find(function (c) { return c.id === state.activeId; });
    return (conv && conv.workspace) || state.workspace.defaultPath || state.workspace.path || "";
  }

  function renderWorkspaceInfo() {
    var path = activeConversationWorkspace();
    state.workspace.path = path;
    if (els.workspacePath) {
      els.workspacePath.textContent = path || "未设置";
      els.workspacePath.title = path || "";
    }
    if (els.fullAccessWorkspacePath) els.fullAccessWorkspacePath.textContent = path || "当前对话工作区";
    if (els.workspaceStatusPill) {
      els.workspaceStatusPill.className = "status-pill is-ok";
      els.workspaceStatusPill.innerHTML = "<span></span>当前对话";
    }
    if (els.workspaceHint) {
      els.workspaceHint.textContent = "只影响当前对话；Agent 只能访问此目录下的相对路径，写文件仍会先展示 diff。";
    }
  }

  async function loadWorkspaceInfo() {
    try {
      var res = await fetch("/api/workspace", { cache: "no-store" });
      if (res.status === 401) {
        showLoginScreen();
        return;
      }
      if (!res.ok) return;
      var data = await res.json();
      state.workspace.defaultPath = data.path || state.workspace.defaultPath;
      state.workspace.exists = !!data.exists;
      renderWorkspaceInfo();
    } catch (e) { /* settings are optional until logged in */ }
  }

  function closeWorkspaceDialog() {
    if (els.workspaceDialog && els.workspaceDialog.open) closeDialog(els.workspaceDialog);
  }

  async function openWorkspaceDialog() {
    if (state.streaming) {
      toast("请先停止当前 Agent 任务", "error");
      return;
    }
    els.workspaceError.textContent = "";
    if (!els.workspaceDialog.open) {
      els.workspaceDialog.showModal();
      document.body.classList.add("dialog-open");
    }
    await browseWorkspace(state.workspace.path || "");
  }

  async function browseWorkspace(targetPath) {
    els.workspaceError.textContent = "";
    els.workspaceSelect.disabled = true;
    els.workspaceList.innerHTML = '<div class="workspace-empty">读取中…</div>';
    try {
      var res = await fetch("/api/workspace/browse?path=" + encodeURIComponent(targetPath || ""), { cache: "no-store" });
      if (res.status === 401) {
        showLoginScreen();
        closeWorkspaceDialog();
        return;
      }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || "无法浏览目录");
      state.workspaceBrowsePath = data.path || "";
      state.workspaceBrowseParent = data.parent || "";
      els.workspaceBrowsePath.textContent = data.path || "此电脑";
      els.workspaceBrowsePath.title = data.path || "";
      els.workspaceUp.disabled = !data.path;
      els.workspaceSelect.disabled = !data.path;
      els.workspaceList.innerHTML = "";
      (data.entries || []).forEach(function (entry) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "workspace-entry";
        btn.dataset.path = entry.path;
        btn.innerHTML = icon("folder") + "<span></span>";
        btn.querySelector("span").textContent = entry.name;
        btn.addEventListener("click", function () { browseWorkspace(entry.path); });
        els.workspaceList.appendChild(btn);
      });
      if (!(data.entries || []).length) {
        els.workspaceList.innerHTML = '<div class="workspace-empty">这个文件夹下没有子目录</div>';
      }
    } catch (e) {
      els.workspaceError.textContent = friendlyError(e);
      els.workspaceList.innerHTML = '<div class="workspace-empty">无法读取</div>';
    }
  }

  async function selectCurrentWorkspace() {
    if (!state.workspaceBrowsePath) return;
    els.workspaceSelect.disabled = true;
    try {
      var res = await fetch("/api/workspace/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.workspaceBrowsePath })
      });
      if (res.status === 401) {
        showLoginScreen();
        return;
      }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || "切换失败");
      var conv = activeConversation();
      conv.workspace = data.path || state.workspaceBrowsePath;
      conv.updatedAt = now();
      disableFullAccess(true);
      closeWorkspaceDialog();
      renderWorkspaceInfo();
      scheduleSave();
      toast("当前对话工作区已切换", "success");
    } catch (e) {
      els.workspaceError.textContent = friendlyError(e);
      els.workspaceSelect.disabled = false;
    }
  }

  async function resetWorkspace() {
    if (!window.confirm("把当前对话恢复到默认工作区？")) return;
    var conv = activeConversation();
    conv.workspace = "";
    conv.updatedAt = now();
    disableFullAccess(true);
    await loadWorkspaceInfo();
    renderWorkspaceInfo();
    scheduleSave();
    toast("当前对话已恢复默认工作区", "success");
  }

  /* ============================================================
     Server status
     ============================================================ */
  function fetchTimeout(url, options, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || 2500);
    var opts = Object.assign({}, options || {});
    if (opts.signal) {
      var outer = opts.signal;
      outer.addEventListener("abort", function () { controller.abort(); }, { once: true });
    }
    opts.signal = controller.signal;
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  async function refreshServerStatus(opts) {
    opts = opts || {};
    if (location.protocol === "file:") {
      state.server.online = false;
      state.server.checking = false;
      state.server.error = "file-protocol";
      state.server.key = { configured: false, hint: "", source: "未配置" };
      updateConnectionUI();
      updateKeySettingsUI();
      return;
    }
    state.server.checking = true;
    if (!opts.quiet) updateConnectionUI();
    try {
      var res = await fetchTimeout("/api/status", { cache: "no-store" }, 3000);
      if (res.status === 401) {
        state.server.online = true;
        state.server.checking = false;
        state.server.key = { configured: false, hint: "", source: "需要访问口令" };
        showLoginScreen();
        updateConnectionUI();
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      state.server.online = true;
      state.server.checking = false;
      state.server.error = null;
      state.server.key = data.key || { configured: false, hint: "", source: "未配置" };
      state.server.search = !!data.search;
      state.server.agent = !!data.agent;
      state.server.version = data.version || "";
    } catch (e) {
      state.server.online = false;
      state.server.checking = false;
      state.server.error = e.name === "AbortError" ? "连接超时" : (e.message || "无法连接");
      state.server.key = { configured: false, hint: "", source: "未配置" };
    }
    updateConnectionUI();
    updateKeySettingsUI();
  }

  function updateConnectionUI() {
    if (!els.connectionChip) return;
    var chip = els.connectionChip;
    chip.className = "connection-chip";
    var label = "检测中";
    var title = "正在检测本地模型服务";
    if (state.server.checking) {
      chip.classList.add("is-checking");
    } else if (state.server.online && state.server.key.configured) {
      chip.classList.add("is-live");
      label = "已连接";
      title = "模型服务已连接 · " + (state.server.key.source || "");
    } else if (state.server.online) {
      chip.classList.add("is-demo");
      label = "演示模式";
      title = "本地服务已启动，但没有配置 API Key";
    } else {
      chip.classList.add("is-offline");
      label = "离线演示";
      title = location.protocol === "file:" ? "直接打开的文件页面，无法调用模型接口" : "未连接本地服务";
    }
    els.connectionText.textContent = label;
    chip.setAttribute("title", title);
    chip.setAttribute("aria-label", title);

    var showBanner = !state.settings.bannerDismissed && !(state.server.online && state.server.key.configured);
    els.demoBanner.hidden = !showBanner;
    if (showBanner) {
      if (location.protocol === "file:") {
        els.demoBannerText.textContent = "当前直接打开了 HTML 文件，模型接口不可用。运行 start.cmd 启动本地服务后，即可接入真实模型。";
        els.demoBannerAction.textContent = "查看启动方式";
      } else if (!state.server.online) {
        els.demoBannerText.textContent = "未连接本地服务，正在使用演示回答。运行 start.cmd 启动后即可配置模型。";
        els.demoBannerAction.textContent = "查看启动方式";
      } else {
        els.demoBannerText.textContent = "本地服务已就绪。配置 API Key 后即可使用真实模型，当前为演示模式。";
        els.demoBannerAction.textContent = "接入模型";
      }
    }
    els.planLabel.textContent = state.server.online && state.server.key.configured ? "API 已连接 · 本地优先" : "演示模式 · 本地优先";
    var dot = document.querySelector(".agent-entry-dot");
    if (dot) {
      dot.className = "agent-entry-dot " + (state.server.online && state.server.key.configured ? "is-live" : state.server.online ? "is-demo" : "is-offline");
    }
    updateKeySettingsUI();
  }

  function setKeyPill(configured, online, source) {
    var pill = els.keyStatusPill;
    if (!pill) return;
    pill.className = "status-pill";
    if (!online) {
      pill.classList.add("is-error");
      pill.innerHTML = "<span></span>服务离线";
    } else if (configured) {
      pill.classList.add("is-ok");
      pill.innerHTML = "<span></span>已配置";
    } else {
      pill.classList.add("is-warn");
      pill.innerHTML = "<span></span>未配置";
    }
  }

  function updateKeySettingsUI() {
    if (!els.apiKeyInput) return;
    setKeyPill(state.server.key.configured, state.server.online, state.server.key.source);
    els.serviceDot.className = "service-dot" + (state.server.checking ? "" : (state.server.online ? " is-ok" : " is-error"));
    els.serverAddress.textContent = location.protocol === "file:" ? "未连接（file://）" : (location.host || "127.0.0.1:4173");
    var configured = state.server.key.configured;
    var source = state.server.key.source || "未配置";
    var hint = state.server.key.hint || "";
    if (!state.server.online) {
      els.keyHint.innerHTML = location.protocol === "file:"
        ? "当前是直接打开的文件页面。运行 <code>start.cmd</code> 启动本地服务，再刷新此页。"
        : "本地服务未连接。运行 <code>start.cmd</code> 后点击“测试连接”。";
      els.apiKeyInput.placeholder = "本地服务未连接";
      els.saveKeyBtn.disabled = true;
      els.testKeyBtn.disabled = true;
      els.clearKeyBtn.disabled = true;
    } else {
      els.saveKeyBtn.disabled = false;
      els.testKeyBtn.disabled = false;
      els.clearKeyBtn.disabled = !configured;
      els.apiKeyInput.placeholder = configured ? ("已配置 " + hint + " · 粘贴新 Key 可替换") : "sk-...";
      els.keyHint.innerHTML = configured
        ? "已从 <strong>" + escapeHtml(source) + "</strong> 读取 Key" + (hint ? "（<code>" + escapeHtml(hint) + "</code>）" : "") + "。服务端只保存掩码状态，不会回发明文。"
        : "读取优先级：环境变量 <code>DEEPSEEK_API_KEY</code> → <code>secrets.json</code>。保存后立即生效。";
    }
  }

  /* ============================================================
     Sidebar
     ============================================================ */
  function activeConversation() {
    var conv = state.conversations.find(function (c) { return c.id === state.activeId; });
    if (!conv) {
      conv = makeConversation(state.settings.mode);
      state.conversations.unshift(conv);
      state.activeId = conv.id;
    }
    return conv;
  }

  function convTitle(conv) {
    if (conv.title) return conv.title;
    var firstUser = conv.messages.find(function (m) { return m.role === "user" && (m.content || (m.attachments && m.attachments.length)); });
    if (!firstUser) return "新对话";
    return truncate((firstUser.content || firstUser.attachments[0].name || "新对话").replace(/\s+/g, " ").trim(), 34);
  }

  function groupName(ts) {
    var d = dayStart(ts);
    var today = dayStart(now());
    var diff = Math.round((today - d) / 86400000);
    if (diff <= 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff < 7) return "近 7 天";
    return "更早";
  }

  function renderSidebar() {
    var list = els.conversationList;
    if (!list) return;
    var q = state.searchQuery.trim().toLowerCase();
    var convs = state.conversations.filter(function (c) {
      if (!c.messages.length) return false;
      if (!q) return true;
      var hay = (convTitle(c) + " " + c.messages.map(function (m) { return m.content || ""; }).join(" ")).toLowerCase();
      return hay.indexOf(q) !== -1;
    }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    if (!convs.length) {
      list.innerHTML = '<div class="conv-empty">' + icon("chat") +
        "<p>" + (q ? "没有找到相关对话" : "还没有对话") + "</p>" +
        "<small>" + (q ? "换个关键词试试" : "从下方输入框开始聊天") + "</small></div>";
      return;
    }

    var groups = [];
    var current = null;
    convs.forEach(function (conv) {
      var name = groupName(conv.updatedAt);
      if (!current || current.name !== name) {
        current = { name: name, items: [] };
        groups.push(current);
      }
      current.items.push(conv);
    });

    list.innerHTML = groups.map(function (group) {
      return '<div class="conv-group"><div class="conv-group-label">' + escapeHtml(group.name) + "</div>" +
        group.items.map(function (conv) {
          var isAgent = conv.mode === "agent" || conv.hasAgent;
          var active = conv.id === state.activeId;
          var count = conv.messages.filter(function (m) { return m.role === "user"; }).length;
          return '<div class="conv-item' + (active ? " is-active" : "") + '" data-conv-id="' + escapeAttr(conv.id) + '" role="button" tabindex="0" aria-label="' + escapeAttr(convTitle(conv)) + '">' +
            '<span class="conv-icon' + (isAgent ? " is-agent" : "") + '">' + icon(isAgent ? "robot" : "chat") + "</span>" +
            '<span class="conv-text"><span class="conv-title">' + escapeHtml(convTitle(conv)) + "</span>" +
            '<span class="conv-meta">' + (isAgent ? "Agent" : "对话") + '<span class="dot"></span>' + count + " 条<span class=\"dot\"></span>" + fmtRelative(conv.updatedAt) + "</span></span>" +
            '<button class="conv-more" type="button" data-conv-menu="' + escapeAttr(conv.id) + '" aria-label="对话操作">' + icon("more") + "</button>" +
            "</div>";
        }).join("") + "</div>";
    }).join("");
  }

  function setActiveConversation(id) {
    if (state.streaming) {
      toast("请先停止当前生成，再切换对话", "error");
      return;
    }
    var conv = state.conversations.find(function (c) { return c.id === id; });
    if (!conv) return;
    state.activeId = id;
    state.settings.mode = conv.mode === "agent" ? "agent" : "chat";
    state.attachments = [];
    closeSidebar();
    syncComposerFromActive();
    updateModeUI();
    renderWorkspaceInfo();
    renderSidebar();
    renderChat({ forceBottom: true });
    scheduleSave();
    setTimeout(function () { els.composerInput.focus(); }, 30);
  }

  function newChat(mode) {
    if (state.streaming) {
      toast("请先停止当前生成，再新建对话", "error");
      return;
    }
    mode = mode === "agent" ? "agent" : "chat";
    var empty = state.conversations.find(function (c) { return !c.messages.length; });
    if (empty) {
      empty.mode = mode;
      empty.updatedAt = now();
      state.activeId = empty.id;
    } else {
      var conv = makeConversation(mode);
      state.conversations.unshift(conv);
      state.activeId = conv.id;
    }
    state.settings.mode = mode;
    state.attachments = [];
    closeSidebar();
    syncComposerFromActive();
    updateModeUI();
    renderWorkspaceInfo();
    renderSidebar();
    renderChat({ forceBottom: true });
    scheduleSave();
    setTimeout(function () { els.composerInput.focus(); }, 30);
  }

  function renameConversation(id) {
    var conv = state.conversations.find(function (c) { return c.id === id; });
    if (!conv) return;
    var next = window.prompt("重命名对话", convTitle(conv));
    if (next == null) return;
    next = next.trim().slice(0, 80);
    if (!next) return;
    conv.title = next;
    conv.updatedAt = now();
    scheduleSave();
    renderSidebar();
    renderChat({ forceBottom: false });
  }

  function deleteConversation(id) {
    if (state.streaming) {
      toast("请先停止当前生成，再删除对话", "error");
      return;
    }
    var conv = state.conversations.find(function (c) { return c.id === id; });
    if (!conv) return;
    if (!window.confirm("删除「" + convTitle(conv) + "」？此操作不可撤销。")) return;
    state.conversations = state.conversations.filter(function (c) { return c.id !== id; });
    if (state.activeId === id) {
      var next = state.conversations.find(function (c) { return !c.messages.length; }) || state.conversations[0];
      if (!next) {
        next = makeConversation(state.settings.mode);
        state.conversations.push(next);
      }
      state.activeId = next.id;
      state.settings.mode = next.mode === "agent" ? "agent" : "chat";
    }
    scheduleSave();
    syncComposerFromActive();
    updateModeUI();
    renderSidebar();
    renderChat({ forceBottom: true });
    toast("对话已删除");
  }

  /* ============================================================
     Welcome
     ============================================================ */
  function welcomeTemplate(mode) {
    var isAgent = mode === "agent";
    var eyebrow = isAgent ? "AGENT WORKSPACE" : "DEEPSEEK WEB";
    var title = isAgent ? "把任务，交给 <em>Agent</em>。" : "你好，我是 <em>DeepSeek</em>。";
    var sub = isAgent
      ? "我会先拆解目标，再调用联网搜索与文件工具推进任务。涉及写文件时，我会把 diff 摆到你面前，你确认之后才会写入。"
      : "写代码、读文件、理清复杂问题。大多数时候，我们像朋友一样对话；需要完成多步任务时，再把方向盘交给 Agent。";
    var body;
    if (isAgent) {
      body = '<div class="agent-capabilities">' +
        '<button class="agent-cap-card" type="button" data-prompt="调研本地优先 AI 助手的常见产品形态，整理成一份带来源链接的摘要，并给出三个差异化方向。">' +
        icon("globe") + "<strong>调研并整理</strong><small>搜索多个来源，输出带引用的摘要</small></button>" +
        '<button class="agent-cap-card" type="button" data-prompt="写一份“本地优先 AI 助手”的产品方案文档，包含目标用户、核心功能、技术架构和上线步骤。">' +
        icon("file") + "<strong>生成文档</strong><small>产出结构完整、可下载的 Markdown</small></button>" +
        '<button class="agent-cap-card" type="button" data-prompt="检查 agent-workspace 里的文件，帮我整理成一份项目说明，并在写入前先给我看 diff。">' +
        icon("shield") + "<strong>改写本地文件</strong><small>先看 diff，确认后才写入磁盘</small></button>" +
        "</div>" +
        '<p class="agent-mode-note">Agent 只在你手动切换后启动。日常问答仍然留在对话模式，更快，也更安静。</p>';
    } else {
      body = '<div class="suggestion-grid">' +
        '<button class="suggestion-card" type="button" data-prompt="用 Python 写一个批量重命名文件的脚本，并解释每一段的作用。">' +
        '<span class="suggestion-icon tone-blue">' + icon("code") + '</span><span class="suggestion-copy"><strong>写一段代码</strong><small>Python 批量重命名脚本</small></span>' + icon("arrow-right", "suggestion-arrow") + "</button>" +
        '<button class="suggestion-card" type="button" data-prompt="帮我写一段新产品发布文案，语气克制、有画面感，控制在 150 字以内。">' +
        '<span class="suggestion-icon tone-violet">' + icon("pen") + '</span><span class="suggestion-copy"><strong>润色一段文案</strong><small>克制、有画面感的发布文案</small></span>' + icon("arrow-right", "suggestion-arrow") + "</button>" +
        '<button class="suggestion-card" type="button" data-prompt="我想在三个月内系统学习前端开发，请制定一份每周可执行的学习计划。">' +
        '<span class="suggestion-icon tone-amber">' + icon("book") + '</span><span class="suggestion-copy"><strong>制定学习计划</strong><small>三个月的前端学习路线</small></span>' + icon("arrow-right", "suggestion-arrow") + "</button>" +
        '<button class="suggestion-card" type="button" data-prompt="帮我把“本地优先的 AI 助手”这个想法拆成产品功能、技术方案和上线步骤。">' +
        '<span class="suggestion-icon tone-teal">' + icon("sparkles") + '</span><span class="suggestion-copy"><strong>梳理一个想法</strong><small>从产品到上线的拆解</small></span>' + icon("arrow-right", "suggestion-arrow") + "</button>" +
        "</div>";
    }
    var cta = isAgent
      ? '<button class="agent-cta" id="agentCta" type="button"><span class="agent-cta-icon">' + icon("chat") + '</span><span><strong>新建一个普通对话</strong><small>日常问答更快，不会显示工具步骤</small></span>' + icon("arrow-right", "agent-cta-arrow") + "</button>"
      : '<button class="agent-cta" id="agentCta" type="button"><span class="agent-cta-icon">' + icon("robot") + '</span><span><strong>新建一个 Agent 任务</strong><small>另开一个对话，它会规划、调用工具并在写文件前确认</small></span>' + icon("arrow-right", "agent-cta-arrow") + "</button>";
    var footnote = isAgent
      ? '<span>' + icon("eye") + "工具调用可见</span><span>" + icon("shield") + "写入前确认</span><span>" + icon("download") + "产出可下载</span>"
      : '<span>' + icon("shield") + "本地优先</span><span>" + icon("file") + "文件产出可下载</span><span>" + icon("check") + "写入前二次确认</span>";

    return '<div class="hero-visual"' + (isAgent ? ' data-mode="agent"' : "") + '>' +
      '<div class="hero-glow"></div><div class="hero-ring ring-one"></div><div class="hero-ring ring-two"></div>' +
      '<div class="hero-mark"><img class="hero-logo" src="deepseek-icon.png" alt=""></div>' +
      "</div>" +
      '<p class="hero-eyebrow"><span></span>' + eyebrow + "<span></span></p>" +
      '<h1 class="hero-title" id="welcomeTitle">' + title + "</h1>" +
      '<p class="hero-sub" id="heroSub">' + sub + "</p>" +
      body + cta +
      '<div class="hero-footnote">' + footnote + "</div>";
  }

  function renderWelcome() {
    var conv = activeConversation();
    var isAgent = state.settings.mode === "agent";
    els.welcome.classList.toggle("is-agent", isAgent);
    els.welcome.innerHTML = welcomeTemplate(state.settings.mode);
    els.welcome.style.display = conv.messages.length ? "none" : "";
  }

  /* ============================================================
     Chat rendering
     ============================================================ */
  function isNearBottom() {
    var el = els.chatScroll;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollToBottom(behavior) {
    var el = els.chatScroll;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: behavior || "auto" });
  }

  function updateChatMeta() {
    var conv = activeConversation();
    var has = conv.messages.length > 0;
    els.chatTitle.textContent = has ? convTitle(conv) : "新对话";
    els.modeBadge.hidden = state.settings.mode !== "agent";
    els.exportBtn.disabled = !has;
    els.exportBtn.style.opacity = has ? "" : ".35";
    document.title = (has ? convTitle(conv) + " · " : "") + "DeepSeek";
    updateScrollButton();
  }

  function showWelcomeState() {
    var conv = activeConversation();
    var empty = !conv.messages.length;
    els.welcome.style.display = empty ? "" : "none";
    els.messages.style.display = empty ? "none" : "flex";
    if (empty) renderWelcome();
  }

  function renderChat(opts) {
    opts = opts || {};
    if (state.mdJobs) {
      state.mdJobs.clear();
      state.mdCallbacks.clear();
    }
    var conv = activeConversation();
    var stick = opts.forceBottom || isNearBottom();
    showWelcomeState();
    if (conv.messages.length) {
      els.messages.innerHTML = conv.messages.map(function (msg, i) {
        return messageHtml(msg, i);
      }).join("");
    } else {
      els.messages.innerHTML = "";
    }
    updateChatMeta();
    updateModeUI();
    if (opts.forceBottom) {
      requestAnimationFrame(function () { scrollToBottom("auto"); });
    } else if (stick) {
      requestAnimationFrame(function () { scrollToBottom("auto"); });
    }
  }

  function userMessageHtml(msg) {
    var atts = (msg.attachments || []).map(function (a) {
      return '<span class="user-attachment">' + icon("file") + escapeHtml(a.name) + "</span>";
    }).join("");
    return '<article class="message is-user" data-msg-id="' + escapeAttr(msg.id) + '">' +
      '<div class="msg-body" data-user-text>' + escapeHtml(msg.content || "") +
      (atts ? '<div class="user-attachments">' + atts + "</div>" : "") +
      "</div>" +
      '<span class="msg-avatar user" aria-hidden="true">我</span>' +
      "</article>";
  }

  function thinkBlockHtml(msg) {
    if (!msg.reasoning) return "";
    var running = !!msg.streaming && !msg.content;
    var duration = msg.thinkMs ? fmtDuration(msg.thinkMs) : (msg.streaming ? "思考中" : "");
    return '<details class="think-block"' + (msg.streaming ? " open" : "") + ">" +
      '<summary class="think-head">' + icon("brain", "think-icon") +
      "<strong>" + (running ? "正在深度思考" : "已深度思考") + "</strong>" +
      (duration ? '<span class="think-time">' + escapeHtml(duration) + "</span>" : "") +
      '<span class="streaming-dots"' + (running ? "" : ' style="display:none"') + "><i></i><i></i><i></i></span>" +
      icon("chevron-down", "think-chevron") + "</summary>" +
      '<div class="think-body">' + escapeHtml(msg.reasoning).replace(/\n/g, "<br>") + "</div>" +
      "</details>";
  }

  function traceStepIcon(step) {
    if (step.kind === "search" || step.tool === "web_search") return "globe";
    if (step.kind === "write" || step.tool === "write_file") return "file";
    if (step.kind === "read" || step.tool === "read_file") return "file";
    if (step.kind === "plan") return "sparkles";
    if (step.kind === "approval") return "shield";
    if (step.kind === "check") return "check";
    if (step.kind === "tool") return "code";
    return "brain";
  }

  function traceStepHtml(step) {
    var status = step.status || "done";
    var label = step.title || step.label || "执行步骤";
    var detail = step.detail || "";
    var statusIcon = status === "running" ? "loader" : (status === "error" ? "x" : (status === "waiting" ? "clock" : "check"));
    var iconClass = status === "running" ? "spin" : "";
    var html = '<div class="trace-step is-' + status + '" data-step-id="' + escapeAttr(step.id) + '">' +
      '<span class="trace-step-icon">' + icon(statusIcon, iconClass) + "</span>" +
      '<div class="trace-step-copy"><div class="trace-step-title">' + escapeHtml(label) +
      (step.tool ? '<span class="trace-tool-name">' + escapeHtml(step.tool) + "</span>" : "") +
      (step.autoApproved ? '<span class="trace-auto">完全权限</span>' : "") +
      "</div>" +
      (detail ? '<div class="trace-step-detail">' + escapeHtml(detail) + "</div>" : "");
    if (step.summary) {
      html += '<div class="trace-step-result' + (status === "error" ? " is-error" : "") + '">' + escapeHtml(step.summary) + "</div>";
    }
    if (step.sources && step.sources.length) {
      html += '<div class="trace-step-result">' + icon("globe") + " 找到 " + step.sources.length + " 个来源</div>";
    }
    if (step.artifact) {
      html += '<div class="trace-step-result">' + icon("file") + " " + escapeHtml(step.artifact.name || "产出文件") + "</div>";
    }
    if (step.confirmation && status === "waiting") {
      html += '<button class="trace-approve" type="button" data-action="review-confirm">' + icon("shield") + "查看 diff 并确认</button>";
    }
    html += "</div></div>";
    return html;
  }

  function agentTraceHtml(msg) {
    var agent = msg.agent;
    if (!agent) return "";
    var steps = agent.steps || [];
    var status = agent.status || "running";
    var waiting = steps.some(function (s) { return s.status === "waiting"; });
    var open = agent.open !== false;
    var statusLabel = waiting ? "待确认" : status === "running" ? "执行中" : status === "done" ? "已完成" : status === "error" ? "已中断" : "已停止";
    var statusClass = waiting ? "is-waiting" : status === "done" ? "is-done" : status === "error" || status === "stopped" ? "is-error" : "";
    var duration = agent.endedAt && agent.startedAt ? fmtDuration(agent.endedAt - agent.startedAt) : "";
    var sub = waiting
      ? "等待你确认文件写入"
      : status === "running"
        ? (agent.statusText || "正在执行任务")
        : (steps.length + " 步" + (duration ? " · 用时 " + duration : ""));
    return '<section class="agent-trace ' + (status === "running" ? "is-running" : "is-done") + '" data-open="' + (open ? "true" : "false") + '" data-trace-for="' + escapeAttr(msg.id) + '">' +
      '<button class="trace-head" type="button" data-action="toggle-trace" aria-expanded="' + (open ? "true" : "false") + '">' +
      '<span class="trace-orb">' + icon("robot") + "</span>" +
      '<span class="trace-head-copy"><span class="trace-title">Agent 执行过程</span><span class="trace-sub">' + escapeHtml(sub) + "</span></span>" +
      '<span class="trace-status ' + statusClass + '">' + (status === "running" && !waiting ? '<span class="spinner"></span>' : "") + statusLabel + "</span>" +
      icon("chevron-down", "trace-chevron") + "</button>" +
      '<div class="trace-body">' +
      (agent.plan && agent.plan.length ? '<div class="trace-plan">' + agent.plan.map(function (p) {
        return '<span class="trace-plan-chip">' + icon("check") + escapeHtml(p) + "</span>";
      }).join("") + "</div>" : "") +
      '<div class="trace-steps">' + (steps.length ? steps.map(traceStepHtml).join("") : '<div class="trace-step is-running"><span class="trace-step-icon">' + icon("loader", "spin") + '</span><div class="trace-step-copy"><div class="trace-step-title">正在准备…</div></div></div>') + "</div>" +
      "</div></section>";
  }

  function sourcesHtml(list) {
    if (!list || !list.length) return "";
    var seen = {};
    var unique = [];
    list.forEach(function (s) {
      var url = safeHref(s.url);
      if (!url || seen[url]) return;
      seen[url] = true;
      unique.push({ url: url, title: s.title || domainOf(url), index: unique.length + 1 });
    });
    if (!unique.length) return "";
    return '<div class="sources"><div class="sources-head">' + icon("globe") + "参考来源 · " + unique.length + "</div><div class=\"source-list\">" +
      unique.map(function (s, i) {
        return '<a class="source-chip" href="' + escapeAttr(s.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeAttr(s.title) + '">' +
          '<span class="source-index">[' + (i + 1) + "]</span><span class=\"source-title\">" + escapeHtml(s.title || domainOf(s.url)) + "</span>" + icon("external") + "</a>";
      }).join("") + "</div></div>";
  }

  function artifactsHtml(msg) {
    var list = (msg.agent && msg.agent.artifacts) || [];
    if (!list.length) return "";
    return '<div class="artifacts">' + list.map(function (a, i) {
      var inner = '<span class="artifact-icon">' + icon("file") + "</span>" +
        '<span class="artifact-copy"><strong>' + escapeHtml(a.name || "产出文件") + "</strong><small>" + (a.size ? fmtSize(a.size) : "Markdown 文档") + "</small></span>" + icon("download");
      if (a.url) {
        return '<a class="artifact-card" href="' + escapeAttr(a.url) + '" download="' + escapeAttr(a.name || "download") + '">' + inner + "</a>";
      }
      return '<button class="artifact-card" type="button" data-action="download-artifact" data-artifact-index="' + i + '">' + inner + "</button>";
    }).join("") + "</div>";
  }

  function actionsHtml(msg, index) {
    var isLast = index === activeConversation().messages.length - 1;
    return '<div class="msg-actions">' +
      '<button class="msg-action" type="button" data-action="copy-message" title="复制回答" aria-label="复制回答">' + icon("copy") + "</button>" +
      '<button class="msg-action" type="button" data-action="regenerate" title="重新生成" aria-label="重新生成"' + (isLast ? "" : ' disabled style="opacity:.3"') + ">" + icon("refresh") + "</button>" +
      '<span class="msg-action-sep"></span>' +
      '<button class="msg-action' + (msg.feedback === "up" ? " is-active" : "") + '" type="button" data-action="feedback-up" title="有帮助" aria-label="有帮助" aria-pressed="' + (msg.feedback === "up") + '">' + icon("thumb-up") + "</button>" +
      '<button class="msg-action' + (msg.feedback === "down" ? " is-active" : "") + '" type="button" data-action="feedback-down" title="需要改进" aria-label="需要改进" aria-pressed="' + (msg.feedback === "down") + '">' + icon("thumb-down") + "</button>" +
      "</div>";
  }

  function messageHtml(msg, index) {
    if (msg.role === "user") return userMessageHtml(msg);
    var agent = msg.agent;
    var isStreaming = !!msg.streaming;
    var hasContent = !!msg.content;
    var contentHtml = hasContent ? window.DSMarkdown.render(msg.content) : "";
    var placeholder = "";
    if (!hasContent && isStreaming) {
      var agentBusy = agent ? (agent.steps && agent.steps.length ? "Agent 正在整理结果…" : "Agent 正在理解任务…") : "";
      placeholder = '<div class="thinking-state"><span class="spinner"></span><span>' + (agent ? agentBusy : (msg.reasoning ? "正在整理答案…" : "正在思考…")) + "</span></div>";
    }
    if (!hasContent && !isStreaming && !msg.error && !agent) {
      placeholder = '<p class="empty-answer">（没有返回内容）</p>';
    }
    var sources = (msg.sources || []).concat(agent && agent.sources ? agent.sources : []);
    var statusLine = "";
    if (isStreaming && hasContent) {
      statusLine = '<div class="generation-status"><span class="spinner"></span><span>' + (agent ? "Agent 正在整理结果…" : "正在生成…") + "</span></div>";
    } else if (msg.stopped) {
      statusLine = '<div class="generation-status">' + icon("stop") + "已停止生成 · 可以重新生成</div>";
    }
    var errorHtml = msg.error ? '<div class="error-box">' + icon("warning") + "<span>" + escapeHtml(msg.error) + '</span><button class="retry-link" type="button" data-action="regenerate">重试</button></div>' : "";
    return '<article class="message is-ai' + (isStreaming ? " is-streaming" : "") + '" data-msg-id="' + escapeAttr(msg.id) + '">' +
      '<span class="msg-avatar ai" aria-hidden="true"><img src="deepseek-icon.png" alt=""></span>' +
      '<div class="ai-content">' +
      '<div class="ai-head"><span class="ai-name">DeepSeek</span><span class="ai-model">' + escapeHtml(msg.modelLabel || (agent ? "Agent" : "DeepSeek Chat")) + "</span>" +
      (msg.demo ? '<span class="demo-pill">演示</span>' : "") +
      '<span class="ai-time">' + fmtClock(msg.createdAt) + "</span></div>" +
      agentTraceHtml(msg) +
      thinkBlockHtml(msg) +
      (contentHtml ? '<div class="md-body' + (isStreaming ? " is-streaming" : "") + '" data-md>' + contentHtml + "</div>" : "") +
      placeholder + errorHtml +
      sourcesHtml(sources) +
      artifactsHtml(msg) +
      statusLine +
      (isStreaming ? "" : actionsHtml(msg, index)) +
      "</div></article>";
  }

  function initMarkdownWorker() {
    if (!window.Worker) {
      document.documentElement.dataset.mdWorker = "off";
      return;
    }
    try {
      state.mdWorker = new Worker("markdown-worker.js");
      document.documentElement.dataset.mdWorker = "on";
      state.mdWorker.onmessage = function (event) {
        var data = event.data || {};
        var job = state.mdCallbacks.get(data.id);
        if (!job) return;
        state.mdCallbacks.delete(data.id);
        job.inFlight = false;
        if (job.node && job.node.isConnected) {
          if (data.error) {
            job.node.innerHTML = window.DSMarkdown.render(job.sent || "");
          } else {
            job.node.innerHTML = data.html || "";
          }
          job.rendered = job.sent;
          if (isNearBottom()) requestAnimationFrame(function () { scrollToBottom("auto"); });
        }
        if (job.latest !== job.rendered) pumpMarkdownJob(job);
      };
      state.mdWorker.onerror = function () {
        // Fall back to synchronous rendering. Existing in-flight jobs will be
        // replaced by the next streaming frame.
        state.mdWorker = null;
        state.mdJobs.clear();
        state.mdCallbacks.clear();
        document.documentElement.dataset.mdWorker = "off";
      };
    } catch (e) {
      state.mdWorker = null;
      document.documentElement.dataset.mdWorker = "off";
    }
  }

  function pumpMarkdownJob(job) {
    if (!state.mdWorker || job.inFlight) return;
    if (!job.node || !job.node.isConnected) return;
    if (job.latest === job.rendered) return;
    job.inFlight = true;
    job.sent = job.latest;
    var requestId = ++state.mdSeq;
    state.mdCallbacks.set(requestId, job);
    try {
      state.mdWorker.postMessage({ id: requestId, text: job.latest });
    } catch (e) {
      state.mdCallbacks.delete(requestId);
      job.inFlight = false;
      state.mdWorker = null;
    }
  }

  function queueMarkdownRender(msg, node) {
    if (!msg.content) return;
    if (!state.mdWorker) {
      node.innerHTML = window.DSMarkdown.render(msg.content);
      return;
    }
    var job = state.mdJobs.get(msg.id);
    if (!job) {
      job = { id: msg.id, node: node, latest: "", sent: "", rendered: "", inFlight: false };
      state.mdJobs.set(msg.id, job);
    }
    job.node = node;
    job.latest = msg.content;
    pumpMarkdownJob(job);
  }

  function updateStreamingView(msg) {
    var node = document.querySelector('[data-msg-id="' + msg.id + '"]');
    if (!node) {
      renderChat({ forceBottom: true });
      return;
    }
    var md = node.querySelector(".md-body");
    if (msg.content && !md) {
      renderChat({ forceBottom: isNearBottom() });
      return;
    }
    if (md) {
      md.classList.add("is-streaming");
      queueMarkdownRender(msg, md);
    }
    var think = node.querySelector(".think-body");
    if (msg.reasoning && think) think.innerHTML = escapeHtml(msg.reasoning).replace(/\n/g, "<br>");
    var status = node.querySelector(".generation-status span:last-child");
    if (status && msg.content) status.textContent = "正在生成…";
    var stick = isNearBottom();
    if (stick) requestAnimationFrame(function () { scrollToBottom("auto"); });
  }

  var pendingFrame = null;
  function scheduleStreamUpdate(msg) {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(function () {
      pendingFrame = null;
      updateStreamingView(msg);
    });
  }

  function updateScrollButton() {
    if (!els.scrollBottom) return;
    var conv = activeConversation();
    if (!conv.messages.length) {
      els.scrollBottom.hidden = true;
      return;
    }
    var show = els.chatScroll.scrollHeight - els.chatScroll.scrollTop - els.chatScroll.clientHeight > 320;
    els.scrollBottom.hidden = !show;
  }

  /* ============================================================
     Composer
     ============================================================ */
  function autosizeInput() {
    var input = els.composerInput;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 210) + "px";
  }

  function syncComposerFromActive() {
    var conv = activeConversation();
    els.composerInput.value = conv.draft || "";
    autosizeInput();
    updateSendState();
    updateAttachmentTray();
  }

  function updateSendState() {
    if (!els.sendBtn) return;
    if (state.streaming) {
      els.sendBtn.disabled = false;
      els.sendBtn.classList.add("is-stop");
      els.sendBtn.setAttribute("aria-label", "停止生成");
      els.sendBtn.title = "停止生成";
      return;
    }
    els.sendBtn.classList.remove("is-stop");
    els.sendBtn.setAttribute("aria-label", "发送消息");
    els.sendBtn.title = "发送";
    els.sendBtn.disabled = !els.composerInput.value.trim() && !state.attachments.length;
  }

  function setStreamingUI(streaming) {
    if (!els.composer) return;
    els.composer.classList.toggle("is-generating", !!streaming);
    updateSendState();
    if (streaming) {
      els.composerHint.textContent = "正在生成 · 点击圆形按钮停止";
    } else {
      updateComposerHint();
    }
  }

  function updateComposerHint() {
    if (state.settings.mode === "agent") {
      els.composerHint.textContent = "Agent 会先规划，再调用工具；写入文件前需要你确认";
    } else {
      els.composerHint.textContent = "Enter 发送 · Shift + Enter 换行";
    }
  }

  function updateModeUI() {
    var mode = state.settings.mode;
    $$(".mode-option").forEach(function (btn) {
      var active = btn.dataset.mode === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    els.composer.classList.toggle("is-agent", mode === "agent");
    els.chatTools.hidden = mode === "agent";
    els.agentTools.hidden = mode !== "agent";
    els.modelLabel.textContent = mode === "agent" ? "DeepSeek Agent" : (state.settings.deepThink ? "DeepSeek Reasoner" : "DeepSeek Chat");
    els.composerInput.placeholder = mode === "agent" ? "描述一个任务，Agent 会规划并执行…" : "给 DeepSeek 发送消息";
    els.thinkToggle.setAttribute("aria-pressed", state.settings.deepThink ? "true" : "false");
    els.searchToggle.setAttribute("aria-pressed", state.settings.webSearch ? "true" : "false");
    els.modeBadge.hidden = mode !== "agent";
    if (!state.streaming) updateComposerHint();
  }

  function setMode(mode, opts) {
    opts = opts || {};
    if (state.streaming) {
      toast("请先停止当前生成，再切换模式", "error");
      return;
    }
    if (mode !== "agent") mode = "chat";
    state.settings.mode = mode;
    var conv = activeConversation();
    conv.mode = mode;
    updateModeUI();
    if (conv.messages.length === 0) {
      renderWelcome();
      els.welcome.classList.toggle("is-agent", mode === "agent");
    }
    if (opts.fill) {
      els.composerInput.value = opts.fill;
      autosizeInput();
      updateSendState();
    }
    if (opts.toast) toast(mode === "agent" ? "已切换到 Agent 模式" : "已切回对话模式");
    scheduleSave();
    els.composerInput.focus();
  }

  function clearComposer() {
    els.composerInput.value = "";
    state.attachments = [];
    var conv = activeConversation();
    conv.draft = "";
    autosizeInput();
    updateSendState();
    updateAttachmentTray();
    els.fileInput.value = "";
  }

  function updateAttachmentTray() {
    var tray = els.attachmentTray;
    if (!state.attachments.length) {
      tray.hidden = true;
      tray.innerHTML = "";
      return;
    }
    tray.hidden = false;
    tray.innerHTML = state.attachments.map(function (a) {
      return '<span class="attachment-chip">' + icon("file") + "<span>" + escapeHtml(a.name) + "</span>" +
        '<button type="button" data-remove-attachment="' + escapeAttr(a.id) + '" aria-label="移除附件">' + icon("x") + "</button></span>";
    }).join("");
    updateSendState();
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (state.attachments.length >= 5) {
      toast("最多添加 5 个文本附件", "error");
      return;
    }
    for (var i = 0; i < files.length; i++) {
      if (state.attachments.length >= 5) break;
      var f = files[i];
      if (f.size > 140000) {
        toast("「" + f.name + "」超过 140 KB，未添加", "error");
        continue;
      }
      try {
        var text = await f.text();
        state.attachments.push({ id: uid("att"), name: f.name, size: f.size, content: text.slice(0, 140000) });
      } catch (e) {
        toast("读取「" + f.name + "」失败", "error");
      }
    }
    els.fileInput.value = "";
    updateAttachmentTray();
  }

  /* ============================================================
     Sending
     ============================================================ */
  function buildModelMessages(conv, excludeId) {
    var msgs = conv.messages.filter(function (m) {
      return m.role && m.id !== excludeId && (m.content || (m.attachments && m.attachments.length));
    }).slice(-24);
    var total = 0;
    return msgs.map(function (m) {
      var content = m.content || "";
      (m.attachments || []).forEach(function (a) {
        content += "\n\n<file name=\"" + a.name + "\">\n" + a.content + "\n</file>";
      });
      if (content.length > 32000) content = content.slice(0, 32000) + "\n…（已截断）";
      if (total + content.length > 110000) content = content.slice(0, 16000);
      total += content.length;
      return { role: m.role, content: content };
    });
  }

  function titleFrom(text, attachments) {
    var t = (text || (attachments && attachments[0] ? attachments[0].name : "") || "新对话").replace(/\s+/g, " ").trim();
    return truncate(t, 34);
  }

  function appendUserTurn(conv, text, attachments, mode) {
    var msg = {
      id: uid("msg"),
      role: "user",
      content: text,
      reasoning: "",
      createdAt: now(),
      attachments: attachments.map(function (a) {
        return { id: a.id, name: a.name, size: a.size, content: a.content };
      }),
      sources: []
    };
    conv.messages.push(msg);
    if (!conv.title) conv.title = titleFrom(text, attachments);
    conv.mode = mode;
    conv.updatedAt = now();
    if (mode === "agent") conv.hasAgent = true;
    return msg;
  }

  function appendAssistantPlaceholder(conv, mode, demoFlag) {
    var msg = {
      id: uid("msg"),
      role: "assistant",
      content: "",
      reasoning: "",
      createdAt: now(),
      streaming: true,
      stopped: false,
      error: "",
      demo: !!demoFlag,
      mode: mode,
      modelLabel: mode === "agent" ? "Agent" : (state.settings.deepThink ? "DeepSeek Reasoner" : "DeepSeek Chat"),
      feedback: "",
      sources: [],
      usage: null,
      agent: mode === "agent" ? {
        status: "running",
        startedAt: now(),
        endedAt: 0,
        statusText: "正在理解任务…",
        open: true,
        plan: [],
        steps: [],
        sources: [],
        artifacts: [],
        runId: ""
      } : null
    };
    conv.messages.push(msg);
    return msg;
  }

  async function sendMessage() {
    if (state.streaming) {
      stopStreaming();
      return;
    }
    var text = els.composerInput.value.trim();
    var attachments = state.attachments.slice();
    if (!text && !attachments.length) return;
    if (!text && attachments.length) text = "请阅读附件并帮我分析。";
    var mode = state.settings.mode === "agent" ? "agent" : "chat";
    var conv = activeConversation();
    conv.mode = mode;
    conv.draft = "";
    appendUserTurn(conv, text, attachments, mode);
    var demoFlag = !(state.server.online && state.server.key.configured);
    var assistant = appendAssistantPlaceholder(conv, mode, demoFlag);
    clearComposer();
    scheduleSave();
    renderSidebar();
    renderChat({ forceBottom: true });
    await runTurn(conv, assistant, mode, !demoFlag);
  }

  async function runTurn(conv, msg, mode, useApi) {
    var controller = new AbortController();
    state.streaming = {
      convId: conv.id,
      msgId: msg.id,
      mode: mode,
      controller: controller,
      msg: msg,
      startedAt: now(),
      pendingStep: null
    };
    setStreamingUI(true);
    updateSendState();
    startThinkTimer(msg);
    try {
      if (mode === "agent") {
        if (useApi) await runRealAgent(conv, msg, controller.signal);
        else await runDemoAgent(conv, msg, controller.signal);
      } else {
        if (useApi) await runRealChat(conv, msg, controller.signal);
        else await runDemoChat(conv, msg, controller.signal);
      }
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) {
        msg.stopped = true;
        msg.streaming = false;
        if (msg.agent && msg.agent.status === "running") {
          msg.agent.status = "stopped";
          msg.agent.statusText = "已停止";
          msg.agent.endedAt = msg.agent.endedAt || now();
          msg.agent.open = true;
        }
      } else {
        msg.error = friendlyError(err);
        msg.streaming = false;
        if (msg.agent && msg.agent.status === "running") {
          msg.agent.status = "error";
          msg.agent.statusText = "执行中断";
          msg.agent.endedAt = now();
          msg.agent.open = true;
        }
      }
    } finally {
      if (state.pendingConfirm) clearPendingConfirmation();
      msg.streaming = false;
      if (!msg.endedAt) msg.endedAt = now();
      if (msg.reasoning && !msg.thinkMs) msg.thinkMs = msg.endedAt - msg.createdAt;
      stopThinkTimer();
      state.streaming = null;
      // Stay in Agent mode for follow-up work in the same session. New chats
      // and page reloads still default to chat (see loadState/newChat).
      setStreamingUI(false);
      updateSendState();
      scheduleSave();
      renderSidebar();
      renderChat({ forceBottom: true });
      updateKeySettingsUI();
      if (msg.error) toast(msg.error, "error", 5000);
    }
  }

  function startThinkTimer(msg) {
    stopThinkTimer();
    if (!msg.reasoning) return;
    state.thinkTimer = setInterval(function () {
      var el = document.querySelector('[data-msg-id="' + msg.id + '"] .think-time');
      if (el && msg.streaming) el.textContent = fmtDuration(now() - msg.createdAt);
    }, 500);
  }

  function stopThinkTimer() {
    if (state.thinkTimer) {
      clearInterval(state.thinkTimer);
      state.thinkTimer = null;
    }
  }

  function stopStreaming() {
    if (!state.streaming) return;
    var s = state.streaming;
    s.controller.abort();
    if (s.mode === "agent" && s.pendingStep) {
      sendAgentDecision(false, { silent: true });
    }
    toast("已停止生成");
  }

  function friendlyError(err) {
    var m = (err && err.message) || "未知错误";
    if (/401|unauthorized|api.?key/i.test(m)) return "模型认证失败，请检查设置中的 API Key。";
    if (/402|balance|余额/i.test(m)) return "DeepSeek 账户余额不足，请充值后再试。";
    if (/429|rate.?limit|频繁/i.test(m)) return "请求过于频繁，请稍后再试。";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "无法连接本地服务，请确认 start.cmd 正在运行。";
    if (/abort/i.test(m)) return "请求已取消。";
    return m;
  }

  /* ============================================================
     Chat: real API
     ============================================================ */
  async function runRealChat(conv, msg, signal) {
    var body = {
      messages: buildModelMessages(conv, msg.id),
      model: state.settings.deepThink ? "deepseek-reasoner" : "deepseek-chat",
      webSearch: !!state.settings.webSearch
    };
    var res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) {
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      throw new Error((data && (data.error || data.message)) || ("HTTP " + res.status));
    }
    await consumeSSE(res, function (ev) {
      if (ev.type === "search") {
        msg.sources = Array.isArray(ev.sources) ? ev.sources : [];
        renderChat({ forceBottom: isNearBottom() });
      } else if (ev.type === "search_error") {
        toast("联网搜索失败，已基于模型知识继续", "error");
      } else if (ev.type === "reasoning") {
        if (!msg.reasoning) {
          msg.reasoning = ev.text || "";
          startThinkTimer(msg);
          renderChat({ forceBottom: isNearBottom() });
        } else {
          msg.reasoning += ev.text || "";
        }
        scheduleStreamUpdate(msg);
      } else if (ev.type === "delta") {
        msg.content += ev.text || "";
        scheduleStreamUpdate(msg);
        scheduleSave();
      } else if (ev.type === "usage") {
        msg.usage = ev.usage || null;
      } else if (ev.type === "done") {
        msg.streaming = false;
        if (msg.reasoning) msg.thinkMs = now() - msg.createdAt;
      } else if (ev.type === "error") {
        throw new Error(ev.message || "模型返回错误");
      }
    });
    if (!msg.content && !msg.stopped) throw new Error("模型没有返回内容，请重试。");
    msg.streaming = false;
    msg.endedAt = now();
    if (msg.reasoning) msg.thinkMs = msg.endedAt - msg.createdAt;
  }

  /* ============================================================
     Chat: demo
     ============================================================ */
  async function runDemoChat(conv, msg, signal) {
    var prompt = (buildModelMessages(conv, msg.id).filter(function (m) { return m.role === "user"; }).pop() || {}).content || "";
    if (state.settings.deepThink) {
      var reasoning = demoReasoning(prompt);
      await typeText(reasoning, function (chunk) {
        msg.reasoning += chunk;
        if (msg.reasoning === chunk) {
          renderChat({ forceBottom: isNearBottom() });
          startThinkTimer(msg);
        }
        scheduleStreamUpdate(msg);
      }, signal, 12, 4);
      msg.thinkMs = now() - msg.createdAt;
      await sleep(220, signal);
    }
    var answer = demoAnswer(prompt, { search: state.settings.webSearch });
    if (state.settings.webSearch) {
      answer = "> 当前为演示模式，没有发起真实联网搜索。接入 API 后，联网结果会由服务端注入。\n\n" + answer;
    }
    await typeText(answer, function (chunk) {
      msg.content += chunk;
      scheduleStreamUpdate(msg);
    }, signal, 8, 3);
    msg.streaming = false;
    msg.endedAt = now();
    if (msg.reasoning) msg.thinkMs = msg.endedAt - msg.createdAt;
  }

  async function typeText(text, onChunk, signal, delay, size) {
    var i = 0;
    while (i < text.length) {
      var step = size + (Math.random() < 0.2 ? 2 : 0);
      onChunk(text.slice(i, i + step));
      i += step;
      await sleep(delay, signal);
    }
  }

  /* ============================================================
     Agent: real API
     ============================================================ */
  async function runRealAgent(conv, msg, signal) {
    var runId = uid("run");
    msg.agent.runId = runId;
    var fullAccess = isFullAccessActive();
    var body = {
      runId: runId,
      messages: buildModelMessages(conv, msg.id),
      model: "deepseek-chat",
      workspace: conv.workspace || state.workspace.defaultPath || state.workspace.path || "",
      fullAccess: fullAccess,
      fullAccessAck: fullAccess
    };
    var res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) {
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      throw new Error((data && (data.error || data.message)) || ("HTTP " + res.status));
    }
    await consumeSSE(res, function (ev) {
      handleAgentEvent(msg, ev);
    });
    if (msg.agent.status === "running") {
      msg.agent.status = msg.content ? "done" : "error";
      msg.agent.endedAt = now();
      msg.agent.open = false;
      if (!msg.content && !msg.error) msg.error = "Agent 没有返回最终结果。";
      msg.streaming = false;
    }
  }

  function upsertAgentStep(agent, data) {
    var step = null;
    if (data.id) {
      step = agent.steps.find(function (s) { return s.id === data.id; });
    }
    if (!step) {
      step = { id: data.id || uid("step"), kind: data.kind || "tool", title: data.title || data.label || "执行步骤", status: "running" };
      agent.steps.push(step);
    }
    Object.keys(data).forEach(function (k) {
      if (data[k] !== undefined) step[k] = data[k];
    });
    return step;
  }

  function handleAgentEvent(msg, ev) {
    var agent = msg.agent;
    if (!agent) return;
    if (ev.type === "run") {
      agent.runId = ev.runId || agent.runId;
    } else if (ev.type === "status") {
      agent.statusText = ev.message || agent.statusText;
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "plan") {
      agent.plan = Array.isArray(ev.steps) ? ev.steps.slice(0, 20) : [];
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "step") {
      upsertAgentStep(agent, {
        id: ev.id, kind: ev.kind, title: ev.title, detail: ev.detail,
        status: ev.status, tool: ev.tool, summary: ev.summary
      });
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "tool_start") {
      upsertAgentStep(agent, {
        id: ev.id, kind: "tool", tool: ev.tool, title: ev.label || ev.tool,
        detail: ev.detail || "", status: "running", startedAt: now()
      });
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "full_access_write") {
      var accessStep = upsertAgentStep(agent, {
        id: ev.id,
        kind: "write",
        title: "写入文件 · 完全权限",
        detail: ev.path || "",
        status: "running",
        autoApproved: true
      });
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "tool_end") {
      var step = upsertAgentStep(agent, {
        id: ev.id, status: ev.status || "done", summary: ev.summary || ""
      });
      if (ev.autoApproved) step.autoApproved = true;
      if (step.kind === "write") {
        step.title = ev.status === "error" ? "写入文件 · 未执行" : (ev.autoApproved ? "写入文件 · 完全权限" : "写入文件");
        if (ev.summary) step.detail = ev.summary;
      }
      if (ev.sources && ev.sources.length) {
        step.sources = ev.sources;
        agent.sources = (agent.sources || []).concat(ev.sources);
      }
      if (ev.artifact) {
        step.artifact = ev.artifact;
        agent.artifacts = agent.artifacts || [];
        var existing = agent.artifacts.findIndex(function (a) {
          return (a.path && ev.artifact.path && a.path === ev.artifact.path) ||
            (a.name && ev.artifact.name && a.name === ev.artifact.name);
        });
        if (existing >= 0) agent.artifacts[existing] = ev.artifact;
        else agent.artifacts.push(ev.artifact);
      }
      if (ev.diff) step.diff = ev.diff;
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "confirmation_required") {
      var cstep = upsertAgentStep(agent, {
        id: ev.id, kind: "write", tool: "write_file",
        title: "写入文件 · 等待确认",
        detail: ev.path || "",
        status: "waiting",
        confirmation: {
          runId: ev.runId || agent.runId,
          callId: ev.callId,
          path: ev.path,
          diff: ev.diff || "",
          isNew: !!ev.isNew,
          preview: ev.preview || ""
        }
      });
      cstep.confirmation.runId = cstep.confirmation.runId || agent.runId;
      if (state.streaming) state.streaming.pendingStep = cstep;
      renderChat({ forceBottom: isNearBottom() });
      openConfirmDialog(msg, cstep);
    } else if (ev.type === "confirmation_result") {
      var rstep = upsertAgentStep(agent, { id: ev.id, status: "running" });
      rstep.title = ev.approved ? "写入文件 · 已确认" : "写入文件 · 已拒绝";
      rstep.detail = ev.timedOut
        ? "等待确认超时，文件未写入。"
        : (ev.approved ? "用户已允许写入，正在落盘…" : "用户拒绝了本次写入，Agent 将调整方案。");
      if (state.streaming && state.streaming.pendingStep && state.streaming.pendingStep.id === ev.id) {
        state.streaming.pendingStep = null;
      }
      if (state.pendingConfirm && state.pendingConfirm.stepId === ev.id) {
        state.pendingConfirm = null;
        if (els.confirmDialog.open) closeDialog(els.confirmDialog);
      }
      if (ev.timedOut) toast("等待确认超时，文件未写入", "error", 5000);
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "final_delta") {
      msg.content += ev.text || "";
      scheduleStreamUpdate(msg);
    } else if (ev.type === "final") {
      msg.content = ev.content || msg.content;
      renderChat({ forceBottom: isNearBottom() });
    } else if (ev.type === "usage") {
      msg.usage = ev.usage || null;
    } else if (ev.type === "done") {
      agent.status = "done";
      agent.endedAt = now();
      agent.statusText = "任务完成";
      agent.open = false;
      msg.streaming = false;
      clearPendingConfirmation();
      renderChat({ forceBottom: true });
    } else if (ev.type === "error") {
      clearPendingConfirmation();
      throw new Error(ev.message || "Agent 执行失败");
    }
  }

  /* ============================================================
     Agent: demo
     ============================================================ */
  async function runDemoAgent(conv, msg, signal) {
    var prompt = (buildModelMessages(conv, msg.id).filter(function (m) { return m.role === "user"; }).pop() || {}).content || "";
    var agent = msg.agent;
    function add(patch) {
      var step = upsertAgentStep(agent, patch);
      renderChat({ forceBottom: isNearBottom() });
      return step;
    }
    function update(id, patch) {
      var step = upsertAgentStep(agent, Object.assign({ id: id }, patch));
      renderChat({ forceBottom: isNearBottom() });
      return step;
    }

    agent.statusText = "正在理解任务…";
    var s1 = add({ id: "demo-s1", kind: "note", title: "理解目标", status: "running", detail: "读取任务描述，确认产出形式与约束。" });
    renderChat({ forceBottom: isNearBottom() });
    await sleep(650, signal);
    update(s1.id, { status: "done", detail: "目标已识别：生成一份结构化、可直接使用的成果。", summary: "任务边界清晰，无需额外澄清。" });

    agent.plan = ["确认目标与边界", "拆解执行步骤", "生成并校验成果"];
    var s2 = add({ id: "demo-s2", kind: "plan", title: "拆解执行计划", status: "running", detail: "正在把任务拆成可执行步骤…" });
    renderChat({ forceBottom: isNearBottom() });
    await sleep(720, signal);
    update(s2.id, { status: "done", detail: "3 个阶段 · 4 个步骤", summary: "先形成结构，再填充内容，最后做一致性检查。" });

    var deliverable = demoAgentDeliverable(prompt);
    var filename = deliverable.filename;
    var s3 = add({ id: "demo-s3", kind: "write", tool: "file", title: "生成成果文档", status: "running", detail: filename });
    renderChat({ forceBottom: isNearBottom() });
    await sleep(900, signal);
    var artifact = {
      name: filename,
      size: new Blob([deliverable.content]).size,
      demoContent: deliverable.content
    };
    agent.artifacts = [artifact];
    update(s3.id, { status: "done", detail: filename, summary: "已生成 Markdown 文档（演示模式，保存在浏览器内，可下载）。", artifact: artifact });

    var s4 = add({ id: "demo-s4", kind: "check", title: "校验成果", status: "running", detail: "检查结构完整性、代码块闭合与可执行性。" });
    renderChat({ forceBottom: isNearBottom() });
    await sleep(650, signal);
    update(s4.id, { status: "done", detail: "结构、格式与可读性检查通过。", summary: "2 项检查通过 · 0 个阻塞问题。" });

    msg.content = demoAgentFinal(prompt, filename);
    msg.streaming = false;
    msg.endedAt = now();
    agent.status = "done";
    agent.endedAt = now();
    agent.statusText = "任务完成";
    agent.open = false;
    renderChat({ forceBottom: true });
  }

  /* ============================================================
     SSE
     ============================================================ */
  async function consumeSSE(res, onEvent) {
    if (!res.body) throw new Error("当前浏览器不支持流式响应。");
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      var idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        var block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        var lines = block.split("\n");
        var data = [];
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf("data:") === 0) data.push(lines[i].slice(5).trim());
        }
        if (!data.length) continue;
        var payload = data.join("\n");
        if (!payload || payload === "[DONE]") continue;
        var ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        onEvent(ev);
      }
    }
  }

  /* ============================================================
     Agent confirmation
     ============================================================ */
  function renderDiff(diff) {
    if (!diff) return '<div class="diff-empty">没有可展示的差异</div>';
    var lines = String(diff).split("\n");
    if (lines.length > 260) lines = lines.slice(0, 260).concat(["…（diff 过长，已截断）"]);
    return lines.map(function (line) {
      var cls = "meta";
      var sign = "";
      var body = line;
      if (/^@@/.test(line)) {
        cls = "hunk";
      } else if (/^---/.test(line) || /^\+\+\+/.test(line)) {
        cls = "meta";
      } else if (/^\+/.test(line)) {
        cls = "add";
        sign = "+";
        body = line.slice(1);
      } else if (/^-/.test(line)) {
        cls = "del";
        sign = "-";
        body = line.slice(1);
      } else if (/^\s/.test(line)) {
        cls = "context";
        sign = " ";
        body = line.slice(1);
      }
      return '<div class="diff-line ' + cls + '"><span class="diff-sign">' + escapeHtml(sign) + "</span><span>" + escapeHtml(body || " ") + "</span></div>";
    }).join("");
  }

  function clearPendingConfirmation() {
    state.pendingConfirm = null;
    if (state.streaming) state.streaming.pendingStep = null;
    if (els.confirmDialog && els.confirmDialog.open) closeDialog(els.confirmDialog);
  }

  function openConfirmDialog(msg, step) {
    var c = step.confirmation;
    if (!c) return;
    if (els.settingsDialog.open) closeDialog(els.settingsDialog);
    state.pendingConfirm = { msgId: msg.id, stepId: step.id, runId: c.runId || (msg.agent && msg.agent.runId), callId: c.callId };
    els.confirmPath.textContent = c.path || "agent-workspace/未命名.md";
    els.confirmKind.textContent = c.isNew ? "新建" : "修改";
    els.confirmSubtitle.textContent = c.isNew ? "Agent 想创建一个新文件。请检查内容后决定是否允许。" : "Agent 想修改一个已有文件。请检查下面的 diff 后决定是否写入。";
    els.confirmDiff.innerHTML = renderDiff(c.diff || c.preview);
    els.confirmApprove.disabled = false;
    els.confirmCancel.disabled = false;
    if (!els.confirmDialog.open) {
      els.confirmDialog.showModal();
      document.body.classList.add("dialog-open");
    }
  }

  async function sendAgentDecision(approved, opts) {
    opts = opts || {};
    var pending = state.pendingConfirm;
    if (!pending) return;
    els.confirmApprove.disabled = true;
    els.confirmCancel.disabled = true;
    try {
      var res = await fetch("/api/agent/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: pending.runId, callId: pending.callId, approved: !!approved })
      });
      if (!res.ok) {
        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        throw new Error((data && data.error) || ("HTTP " + res.status));
      }
      var msg = activeConversation().messages.find(function (m) { return m.id === pending.msgId; });
      if (msg && msg.agent) {
        var step = msg.agent.steps.find(function (s) { return s.id === pending.stepId; });
        if (step) {
          step.status = approved ? "running" : "done";
          step.detail = approved ? "已允许写入，正在落盘…" : "已拒绝写入，Agent 会调整方案。";
        }
      }
      state.pendingConfirm = null;
      closeDialog(els.confirmDialog);
      if (state.streaming) state.streaming.pendingStep = null;
      if (!opts.silent) toast(approved ? "已允许 Agent 写入" : "已拒绝本次写入", approved ? "success" : "info");
      renderChat({ forceBottom: isNearBottom() });
    } catch (e) {
      var reason = friendlyError(e);
      if (/已经结束|已经处理过|不存在/.test(reason)) {
        clearPendingConfirmation();
        toast(reason, "error", 5000);
      } else {
        els.confirmApprove.disabled = false;
        els.confirmCancel.disabled = false;
        toast("提交决定失败：" + reason, "error", 5000);
      }
    }
  }

  /* ============================================================
     Regenerate
     ============================================================ */
  async function regenerateMessage(msgId) {
    if (state.streaming) {
      toast("请先停止当前生成", "error");
      return;
    }
    var conv = activeConversation();
    var idx = conv.messages.findIndex(function (m) { return m.id === msgId; });
    if (idx === -1 || conv.messages[idx].role !== "assistant") return;
    if (idx !== conv.messages.length - 1) {
      toast("只能重新生成最后一条回答", "error");
      return;
    }
    var user = null;
    for (var i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].role === "user") { user = conv.messages[i]; break; }
    }
    if (!user) return;
    var oldAssistant = conv.messages[idx];
    var mode = oldAssistant.mode === "agent" ? "agent" : "chat";
    conv.messages.splice(idx, 1);
    var demoFlag = !(state.server.online && state.server.key.configured);
    var assistant = appendAssistantPlaceholder(conv, mode, demoFlag);
    conv.updatedAt = now();
    scheduleSave();
    renderChat({ forceBottom: true });
    await runTurn(conv, assistant, mode, !demoFlag);
  }

  /* ============================================================
     Demo content
     ============================================================ */
  function demoReasoning(prompt) {
    return [
      "用户的目标是：" + truncate(prompt.replace(/\s+/g, " "), 120),
      "先判断这是知识问答、创作还是执行类任务；这里需要给出可直接使用的答案。",
      "回答结构：先给结论，再给关键步骤或代码，最后补充容易踩坑的地方。",
      "当前处于演示模式，不引用无法验证的实时信息。"
    ].join("\n");
  }

  function demoAnswer(prompt, opts) {
    opts = opts || {};
    var q = prompt.toLowerCase();
    var quoted = escapeHtml(truncate(prompt.replace(/\s+/g, " "), 90));

    if (/^(你好|hi|hello|嗨|在吗)/i.test(prompt.trim())) {
      return [
        "你好，我是 **DeepSeek**。现在运行在本地演示模式。",
        "",
        "你可以直接问我问题、让我写代码，或者把一段文字交给我改写。需要多步任务时，点输入框左侧的 **Agent**，我会拆解目标、调用工具，并在写文件前把 diff 交给你确认。",
        "",
        "想先试点什么？",
        "",
        "- 写一段 Python 脚本",
        "- 把一段想法整理成产品方案",
        "- 制定一份学习计划",
        "",
        "> 配置 API Key 后，演示模式会自动切换为真实模型。"
      ].join("\n");
    }

    if (/你是谁|介绍.*自己|能做什么|是什么模型/.test(prompt)) {
      return [
        "我是 **DeepSeek**，这个网页端把两件事放在了一起：",
        "",
        "1. **对话**：默认入口，适合问答、写作、代码和日常讨论。",
        "2. **Agent**：需要多步完成时才切换，会规划、调用联网搜索和文件工具，并把写入前的 diff 展示给你。",
        "",
        "当前页面运行在**本地演示模式**：回答由内置示例生成，不会请求外部模型。配置 API Key 后，对话和 Agent 都会使用真实接口。",
        "",
        "我的界面参考了 [DeepSeek](https://www.deepseek.com) 的简洁风格，但不是官方客户端。"
      ].join("\n");
    }

    if (/python|批量重命名|重命名|脚本/.test(q)) {
      return [
        "可以。下面这个脚本不依赖第三方库，先**预演**、确认无误后再真正改名，避免一口气改错。",
        "",
        "```python",
        "from pathlib import Path",
        "",
        "def batch_rename(folder: str, prefix: str = \"file\", dry_run: bool = True):",
        "    root = Path(folder)",
        "    if not root.is_dir():",
        "        raise NotADirectoryError(folder)",
        "",
        "    files = sorted(",
        "        (p for p in root.iterdir() if p.is_file()),",
        "        key=lambda p: p.stat().st_mtime",
        "    )",
        "    width = max(3, len(str(len(files))))",
        "",
        "    for index, path in enumerate(files, start=1):",
        "        new_name = f\"{prefix}_{index:0{width}d}{path.suffix.lower()}\"",
        "        target = path.with_name(new_name)",
        "        if target.exists():",
        "            print(f\"跳过（已存在）: {target.name}\")",
        "            continue",
        "        print(f\"{path.name} -> {new_name}\")",
        "        if not dry_run:",
        "            path.rename(target)",
        "",
        "if __name__ == \"__main__\":",
        "    batch_rename(\"./photos\", prefix=\"trip\", dry_run=True)",
        "```",
        "",
        "### 关键点",
        "",
        "- **先排序**：按修改时间排列，编号才稳定；否则每次运行顺序可能不同。",
        "- **固定位宽**：`trip_001`、`trip_002` 这样排序结果才符合直觉。",
        "- **冲突检查**：目标文件已存在就跳过，不覆盖任何东西。",
        "- **dry run**：默认只打印计划，把 `dry_run=False` 才真正改名。",
        "",
        "> 演示提示：把脚本里的 `dry_run=True` 改成 `False` 之前，先备份目录。"
      ].join("\n");
    }

    if (/html|网页|前端|css|landing/.test(q)) {
      return [
        "先给一个能直接打开的极简落地页骨架。重点不是堆样式，而是把**信息层级**和**移动端**先搭稳。",
        "",
        "```html",
        "<!doctype html>",
        "<html lang=\"zh-CN\">",
        "<head>",
        "  <meta charset=\"utf-8\">",
        "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "  <title>本地优先的 AI 助手</title>",
        "  <style>",
        "    :root { --accent: #4d6bfe; --ink: #171b24; }",
        "    * { box-sizing: border-box; }",
        "    body { margin: 0; font-family: system-ui, sans-serif; color: var(--ink); }",
        "    .hero { max-width: 760px; margin: 16vh auto; padding: 0 24px; }",
        "    .tag { color: var(--accent); font-weight: 600; letter-spacing: .08em; }",
        "    h1 { font-size: clamp(2rem, 6vw, 4rem); line-height: 1.1; margin: 12px 0; }",
        "    p { color: #5d6675; line-height: 1.8; }",
        "    a { display: inline-block; margin-top: 18px; padding: 12px 18px;",
        "        border-radius: 999px; background: var(--accent); color: #fff;",
        "        text-decoration: none; }",
        "  </style>",
        "</head>",
        "<body>",
        "  <main class=\"hero\">",
        "    <div class=\"tag\">LOCAL FIRST</div>",
        "    <h1>把复杂，留给安静。</h1>",
        "    <p>一个以对话为主、需要时才调用 Agent 的本地 AI 工作台。</p>",
        "    <a href=\"#\">开始使用</a>",
        "  </main>",
        "</body>",
        "</html>",
        "```",
        "",
        "### 为什么这样写",
        "",
        "| 选择 | 原因 |",
        "| --- | --- |",
        "| `clamp()` | 标题在手机和桌面都保持合理比例 |",
        "| 单列布局 | 首屏只承载一个行动，转化更聚焦 |",
        "| 系统字体 | 零加载成本，首屏不会闪烁 |",
        "",
        "下一步可以把主按钮接到真实入口，并补上深色模式和键盘焦点样式。"
      ].join("\n");
    }

    if (/计划|学习|路线|三个月/.test(q)) {
      return [
        "可以，按**每周一个可交付物**来排，而不是按“看多少教程”。三个月后你应该有一个能展示的项目。",
        "",
        "| 阶段 | 时间 | 目标 | 交付物 |",
        "| --- | --- | --- | --- |",
        "| 基础 | 第 1–3 周 | HTML / CSS / JS 核心语法 | 一个响应式个人页 |",
        "| 框架 | 第 4–6 周 | 组件、状态、路由 | 一个待办应用 |",
        "| 工程化 | 第 7–9 周 | API、构建、调试 | 接入真实接口的看板 |",
        "| 综合 | 第 10–12 周 | 性能、部署、复盘 | 可公开访问的作品 |",
        "",
        "### 每周节奏",
        "",
        "1. **输入 3 小时**：只学本周需要的概念，不做“收藏式学习”。",
        "2. **动手 6 小时**：把概念落进当前项目，允许写得丑。",
        "3. **复盘 1 小时**：记录 3 个问题，下周优先解决。",
        "",
        "### 三条建议",
        "",
        "- 不要同时学三套框架，先把一套用熟。",
        "- 每两周做一次“从零重写”，比反复看视频有效。",
        "- 把项目部署出去，让真实链接迫使你处理细节。",
        "",
        "如果你告诉我每天能投入多少时间，我可以把这张表细化到每天。"
      ].join("\n");
    }

    if (/文案|发布|写一段|润色|标题/.test(q)) {
      return [
        "**主标题：把复杂，留给安静。**",
        "",
        "有些工具让你记住更多按钮，有些工具让你忘记它的存在。",
        "我们把多步任务交给 Agent，把日常对话留给你。",
        "需要时，它在；不需要时，它不打扰。",
        "",
        "**副标题：一个以对话为主的本地 AI 工作台。**",
        "",
        "### 三个备选方向",
        "",
        "1. **克制版**：少一点操作，多一点思考。",
        "2. **画面版**：让机器去忙碌，让你留在问题里。",
        "3. **直接版**：聊天是日常，Agent 是例外。",
        "",
        "> 如果发布渠道是朋友圈，建议用第一版；如果是官网首屏，主标题 + 副标题就够，不要再加第三行。"
      ].join("\n");
    }

    if (/产品|拆解|方案|上线|需求/.test(q)) {
      return [
        "先把想法收成一句话：**一个以对话为默认入口、在需要时切换到 Agent 的本地 AI 工作台。**",
        "",
        "### 1. 产品分层",
        "",
        "- **对话层**：低摩擦问答、写作、代码。默认永远停在这里。",
        "- **Agent 层**：显式切换，展示计划、工具调用和产物。用户知道“它开始干活了”。",
        "- **工作区**：Agent 的文件产出可下载，写入前必须看 diff。",
        "",
        "### 2. 最小可行版本",
        "",
        "| 模块 | 首版做什么 | 先不做什么 |",
        "| --- | --- | --- |",
        "| 对话 | 流式回答、Markdown、历史记录 | 多模型路由 |",
        "| Agent | 搜索、读写文件、审批 | 任意 shell |",
        "| 数据 | 本地保存、导出 | 云同步 |",
        "",
        "### 3. 上线步骤",
        "",
        "1. 打通真实模型流式接口，准备无 Key 演示模式。",
        "2. 用一条任务跑通“搜索 → 生成 → diff → 确认 → 写盘”。",
        "3. 补上错误、超时、停止生成和刷新恢复。",
        "4. 做一次 10 人可用性测试，观察他们是否误触 Agent。",
        "",
        "### 4. 关键指标",
        "",
        "- 首次对话开始时间；",
        "- 对话轮次 / 会话；",
        "- Agent 任务完成率与审批拒绝率；",
        "- 7 日回访。",
        "",
        "真正的差异化不在“能不能调用工具”，而在**用户是否始终知道 Agent 在做什么**。"
      ].join("\n");
    }

    return [
      "你提到的是「" + quoted + "」。我先给一个可执行的拆法。",
      "",
      "### 先看结论",
      "",
      "这类问题通常可以拆成三层：**目标、约束、下一步动作**。先把目标写成一句可验证的话，再列出不能牺牲的约束，最后只选一个最小动作开始。",
      "",
      "### 可以这样推进",
      "",
      "1. **定义完成**：什么结果出现，才算这件事做完了？",
      "2. **找瓶颈**：现在最不确定的是信息、能力，还是时间？",
      "3. **做小实验**：用一天时间验证最关键的假设，不追求完整方案。",
      "4. **留复盘**：记录结果和偏差，下一轮只改一个变量。",
      "",
      "### 一个简单的判断表",
      "",
      "| 信号 | 说明 | 动作 |",
      "| --- | --- | --- |",
      "| 目标模糊 | 说不清完成标准 | 先写一句验收条件 |",
      "| 信息不足 | 关键事实靠猜 | 先做一次搜索或访谈 |",
      "| 执行卡住 | 知道做什么但不动 | 把第一步缩到 15 分钟 |",
      "",
      "如果你愿意补充一点背景，我可以把上面的框架变成一份更具体的行动清单。",
      "",
      "> 当前是演示回答，没有调用外部模型或实时搜索。"
    ].join("\n");
  }

  function demoAgentDeliverable(prompt) {
    var title = "任务成果：" + truncate(prompt.replace(/\s+/g, " "), 26);
    var filename = "DeepSeek-Agent-任务成果.md";
    if (/产品|方案|拆解|上线/.test(prompt)) filename = "本地优先AI助手-产品方案.md";
    else if (/调研|分析|报告/.test(prompt)) filename = "调研摘要.md";
    else if (/代码|脚本|python|html|网页/.test(prompt.toLowerCase())) filename = "agent-script.md";
    else if (/文档|说明|计划/.test(prompt)) filename = "任务文档.md";
    var body = [
      "# " + title,
      "",
      "> 本文件由 DeepSeek Agent 的演示模式生成。它不会写入磁盘；配置 API Key 后，Agent 会在你确认 diff 后写入 `agent-workspace/`。",
      "",
      "## 一、任务理解",
      "",
      prompt,
      "",
      "## 二、执行计划",
      "",
      "- [x] 识别目标与约束",
      "- [x] 拆解为可执行步骤",
      "- [x] 生成结构化成果",
      "- [x] 做格式与一致性检查",
      "",
      "## 三、正文",
      "",
      demoAnswer(prompt, {}),
      "",
      "## 四、交付清单",
      "",
      "1. 一份 Markdown 成果文档；",
      "2. 可继续编辑的结构化大纲；",
      "3. 写入真实工作区前的 diff 审批流程说明。",
      "",
      "## 五、需要你确认的点",
      "",
      "- 目标受众是否准确；",
      "- 是否要补充真实数据或来源；",
      "- 正式写入前是否需要调整文件名与目录。",
      "",
      "---",
      "",
      "生成时间：" + new Date().toLocaleString("zh-CN")
    ].join("\n");
    return { title: title, filename: filename, content: body };
  }

  function demoAgentFinal(prompt, filename) {
    return [
      "任务已完成。我按 **理解 → 规划 → 生成 → 校验** 的顺序执行，并产出了一份可下载的 Markdown 文档。",
      "",
      "### 交付摘要",
      "",
      "- 已识别任务目标，并拆成 4 个执行步骤；",
      "- 已生成结构化成果，包含正文、交付清单和待确认项；",
      "- 已完成格式与一致性检查，未发现阻塞问题。",
      "",
      "### 产出",
      "",
      "`" + filename + "` 已生成，可在下方卡片中下载。",
      "",
      "### 下一步",
      "",
      "如果你希望把这份成果真正写入本地工作区，配置 API Key 后切换到 Agent 模式再执行一次。届时我会先展示 diff，只有你点“允许写入”才会落盘，并自动保留 `.bak` 备份。",
      "",
      "> 当前为演示模式：没有调用真实模型，也没有写入磁盘。"
    ].join("\n");
  }

  /* ============================================================
     Export / copy / feedback
     ============================================================ */
  function conversationMarkdown(conv) {
    var lines = [];
    lines.push("# " + convTitle(conv));
    lines.push("");
    lines.push("> 模式：" + (conv.mode === "agent" ? "Agent" : "对话") + " · 导出时间：" + new Date().toLocaleString("zh-CN"));
    lines.push("");
    conv.messages.forEach(function (m) {
      if (m.role === "user") {
        lines.push("## 我");
        lines.push("");
        lines.push(m.content || "");
        (m.attachments || []).forEach(function (a) {
          lines.push("");
          lines.push("**附件：** `" + a.name + "`");
        });
      } else {
        lines.push("## DeepSeek");
        lines.push("");
        if (m.agent && m.agent.steps && m.agent.steps.length) {
          lines.push("### Agent 执行过程");
          lines.push("");
          m.agent.steps.forEach(function (s) {
            lines.push("- " + (s.title || "步骤") + (s.summary ? "：" + s.summary : ""));
          });
          lines.push("");
        }
        if (m.reasoning) {
          lines.push("<details><summary>深度思考</summary>");
          lines.push("");
          lines.push(m.reasoning);
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }
        lines.push(m.content || (m.error ? "（错误：" + m.error + "）" : ""));
        var sources = (m.sources || []).concat(m.agent && m.agent.sources ? m.agent.sources : []);
        if (sources.length) {
          lines.push("");
          lines.push("**参考来源**");
          sources.forEach(function (s, i) {
            lines.push((i + 1) + ". [" + (s.title || s.url) + "](" + s.url + ")");
          });
        }
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  function exportConversation(conv) {
    conv = conv || activeConversation();
    if (!conv.messages.length) {
      toast("当前对话为空", "error");
      return;
    }
    var date = new Date();
    var stamp = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
    downloadFile(safeFilename(convTitle(conv)) + "-" + stamp + ".md", conversationMarkdown(conv), "text/markdown;charset=utf-8");
    toast("已导出 Markdown", "success");
  }

  function exportAll() {
    if (!state.conversations.filter(function (c) { return c.messages.length; }).length) {
      toast("还没有可导出的对话", "error");
      return;
    }
    downloadFile("deepseek-web-backup-" + Date.now() + ".json", JSON.stringify({
      version: VERSION,
      exportedAt: new Date().toISOString(),
      conversations: state.conversations.filter(function (c) { return c.messages.length; })
    }, null, 2), "application/json;charset=utf-8");
    toast("已导出全部对话", "success");
  }

  function copyMessage(msgId) {
    var conv = activeConversation();
    var msg = conv.messages.find(function (m) { return m.id === msgId; });
    if (!msg) return;
    copyText(msg.content || "").then(function () {
      toast("已复制回答", "success");
    }).catch(function () {
      toast("复制失败，请手动选择文本", "error");
    });
  }

  function setFeedback(msgId, value) {
    var conv = activeConversation();
    var msg = conv.messages.find(function (m) { return m.id === msgId; });
    if (!msg) return;
    msg.feedback = msg.feedback === value ? "" : value;
    scheduleSave();
    renderChat({ forceBottom: false });
    toast(msg.feedback ? "感谢反馈" : "已取消反馈");
  }

  function downloadDemoArtifact(msgId, index) {
    var conv = activeConversation();
    var msg = conv.messages.find(function (m) { return m.id === msgId; });
    var artifact = msg && msg.agent && msg.agent.artifacts && msg.agent.artifacts[index];
    if (!artifact || !artifact.demoContent) {
      toast("这个文件没有可下载的内容", "error");
      return;
    }
    downloadFile(artifact.name || "deepseek-agent-output.md", artifact.demoContent, "text/markdown;charset=utf-8");
    toast("已下载 " + (artifact.name || "文件"), "success");
  }

  /* ============================================================
     Settings / dialogs
     ============================================================ */
  function openSettings(section) {
    closeContextMenu();
    refreshServerStatus({ quiet: true });
    loadLanInfo();
    loadWorkspaceInfo();
    if (!els.settingsDialog.open) {
      els.settingsDialog.showModal();
      document.body.classList.add("dialog-open");
    }
    setTimeout(function () {
      renderWallpaperSlots();
      syncWallpaperControls();
      updateWallpaperStorageInfo();
      if (section === "wallpaper" && els.wallpaperSection) {
        els.wallpaperSection.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (!state.server.key.configured) els.apiKeyInput.focus();
    }, 80);
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
    setTimeout(function () {
      if (!document.querySelector("dialog[open]")) document.body.classList.remove("dialog-open");
    }, 0);
  }

  async function saveKey() {
    var key = els.apiKeyInput.value.trim();
    if (!key) {
      toast("请先粘贴 API Key", "error");
      return;
    }
    if (!/^[\x20-\x7E]+$/.test(key)) {
      toast("Key 里混入了非 ASCII 字符，请重新复制", "error");
      return;
    }
    els.saveKeyBtn.disabled = true;
    els.saveKeyBtn.textContent = "保存中…";
    try {
      var res = await fetch("/api/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
      els.apiKeyInput.value = "";
      toast(data.message || "Key 已保存并生效", "success");
      await refreshServerStatus({ quiet: true });
      updateConnectionUI();
    } catch (e) {
      toast("保存失败：" + friendlyError(e), "error", 5000);
    } finally {
      els.saveKeyBtn.disabled = false;
      els.saveKeyBtn.textContent = "保存";
    }
  }

  async function clearKey() {
    if (!window.confirm("清除本机保存的 API Key？环境变量中的 Key 不受影响。")) return;
    try {
      var res = await fetch("/api/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "" })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || "清除失败");
      toast(data.message || "已清除 Key");
      await refreshServerStatus({ quiet: true });
      updateConnectionUI();
    } catch (e) {
      toast("清除失败：" + friendlyError(e), "error");
    }
  }

  async function testConnection() {
    els.testKeyBtn.disabled = true;
    var old = els.testKeyBtn.innerHTML;
    els.testKeyBtn.innerHTML = icon("loader", "spin") + "测试中";
    try {
      var res = await fetch("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || "连接失败");
      toast(data.message || "连接成功，模型服务可用", "success", 4000);
    } catch (e) {
      toast("连接失败：" + friendlyError(e), "error", 5000);
    } finally {
      els.testKeyBtn.disabled = false;
      els.testKeyBtn.innerHTML = old;
    }
  }

  function clearAllConversations() {
    if (state.streaming) {
      toast("请先停止当前生成", "error");
      return;
    }
    if (!window.confirm("清空全部对话？此操作不可撤销，建议先导出备份。")) return;
    var conv = makeConversation(state.settings.mode);
    state.conversations = [conv];
    state.activeId = conv.id;
    state.attachments = [];
    flushSave();
    syncComposerFromActive();
    renderSidebar();
    renderChat({ forceBottom: true });
    closeDialog(els.settingsDialog);
    toast("全部对话已清空", "success");
  }

  /* ============================================================
     Context menu
     ============================================================ */
  function closeContextMenu() {
    els.contextMenu.hidden = true;
    els.contextMenu.innerHTML = "";
  }

  function showContextMenu(x, y, convId) {
    var conv = state.conversations.find(function (c) { return c.id === convId; });
    if (!conv) return;
    els.contextMenu.innerHTML =
      '<button type="button" role="menuitem" data-menu-action="rename">' + icon("edit") + "重命名</button>" +
      '<button type="button" role="menuitem" data-menu-action="export">' + icon("download") + "导出 Markdown</button>" +
      '<div class="menu-sep"></div>' +
      '<button type="button" role="menuitem" class="danger" data-menu-action="delete">' + icon("trash") + "删除对话</button>";
    els.contextMenu.dataset.convId = convId;
    els.contextMenu.hidden = false;
    els.contextMenu.style.left = "0px";
    els.contextMenu.style.top = "0px";
    var rect = els.contextMenu.getBoundingClientRect();
    var left = Math.min(x, window.innerWidth - rect.width - 8);
    var top = Math.min(y, window.innerHeight - rect.height - 8);
    els.contextMenu.style.left = Math.max(8, left) + "px";
    els.contextMenu.style.top = Math.max(8, top) + "px";
  }

  /* ============================================================
     Sidebar mobile
     ============================================================ */
  function openSidebar() {
    if (window.innerWidth > 920) return;
    els.sidebar.classList.add("is-open");
    els.sidebarScrim.hidden = false;
  }

  function closeSidebar() {
    els.sidebar.classList.remove("is-open");
    els.sidebarScrim.hidden = true;
  }

  function syncSidebarCollapse() {
    if (!els.appShell) return;
    if (window.innerWidth <= 920) {
      els.appShell.classList.remove("is-collapsed");
    } else {
      els.appShell.classList.toggle("is-collapsed", !!state.settings.sidebarCollapsed);
      els.collapseBtn.setAttribute("aria-label", state.settings.sidebarCollapsed ? "展开侧栏" : "收起侧栏");
    }
  }

  /* ============================================================
     Toast
     ============================================================ */
  function toast(message, type, duration) {
    if (!els.toastStack) return;
    type = type || "info";
    duration = duration || 2800;
    var el = document.createElement("div");
    el.className = "toast" + (type === "error" ? " is-error" : type === "success" ? " is-success" : "");
    var ic = type === "error" ? "warning" : type === "success" ? "check" : "sparkles";
    el.innerHTML = icon(ic) + "<span>" + escapeHtml(message) + "</span>";
    els.toastStack.appendChild(el);
    setTimeout(function () {
      el.classList.add("is-leaving");
      setTimeout(function () { el.remove(); }, 220);
    }, duration);
  }

  /* ============================================================
     Event bindings
     ============================================================ */
  function bindEvents() {
    /* Sidebar */
    els.newChatBtn.addEventListener("click", function () { newChat("chat"); });
    els.newAgentBtn.addEventListener("click", function () { newChat("agent"); });
    els.collapseBtn.addEventListener("click", function () {
      state.settings.sidebarCollapsed = !document.getElementById("appShell").classList.contains("is-collapsed");
      syncSidebarCollapse();
      scheduleSave();
    });
    els.conversationSearch.addEventListener("input", function () {
      state.searchQuery = els.conversationSearch.value;
      els.searchClear.hidden = !state.searchQuery;
      renderSidebar();
    });
    els.searchClear.addEventListener("click", function () {
      els.conversationSearch.value = "";
      state.searchQuery = "";
      els.searchClear.hidden = true;
      renderSidebar();
      els.conversationSearch.focus();
    });
    els.conversationList.addEventListener("click", function (e) {
      var menuBtn = e.target.closest("[data-conv-menu]");
      if (menuBtn) {
        e.stopPropagation();
        var r = menuBtn.getBoundingClientRect();
        showContextMenu(r.left - 120, r.bottom + 4, menuBtn.dataset.convMenu);
        return;
      }
      var item = e.target.closest(".conv-item");
      if (item) setActiveConversation(item.dataset.convId);
    });
    els.conversationList.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var item = e.target.closest(".conv-item");
      if (item) {
        e.preventDefault();
        setActiveConversation(item.dataset.convId);
      }
    });
    els.agentEntry.addEventListener("click", function () {
      newChat("agent");
      toast("已进入 Agent 工作台");
    });
    els.accountBtn.addEventListener("click", openSettings);
    els.settingsBtn.addEventListener("click", openSettings);
    els.mobileMenuBtn.addEventListener("click", openSidebar);
    els.sidebarScrim.addEventListener("click", closeSidebar);
    els.brandHome.addEventListener("click", function (e) {
      e.preventDefault();
      newChat("chat");
    });

    /* LAN login */
    els.loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      submitLogin();
    });
    els.copyLanUrl.addEventListener("click", function () {
      if (!state.lan || !state.lan.url) return;
      copyText(state.lan.url).then(function () {
        toast("已复制手机访问地址", "success");
      }).catch(function () { toast("复制失败", "error"); });
    });
    els.logoutBtn.addEventListener("click", logoutLan);
    els.chooseWorkspace.addEventListener("click", openWorkspaceDialog);
    els.resetWorkspace.addEventListener("click", resetWorkspace);
    els.workspaceCancel.addEventListener("click", closeWorkspaceDialog);
    els.workspaceSelect.addEventListener("click", selectCurrentWorkspace);
    els.workspaceUp.addEventListener("click", function () {
      if (!state.workspaceBrowsePath) return;
      if (state.workspaceBrowseParent) browseWorkspace(state.workspaceBrowseParent);
      else browseWorkspace("");
    });
    els.workspaceDialog.addEventListener("click", function (e) {
      if (e.target === els.workspaceDialog) closeWorkspaceDialog();
    });
    els.fullAccessSettingsBtn.addEventListener("click", openFullAccessDialog);
    els.agentAccessBtn.addEventListener("click", openFullAccessDialog);
    els.fullAccessAck.addEventListener("change", function () {
      els.fullAccessEnable.disabled = !els.fullAccessAck.checked;
    });
    els.fullAccessEnable.addEventListener("click", enableFullAccess);
    els.fullAccessCancel.addEventListener("click", function () { closeDialog(els.fullAccessDialog); });
    els.fullAccessDialog.addEventListener("click", function (e) {
      if (e.target === els.fullAccessDialog) closeDialog(els.fullAccessDialog);
    });

    /* Topbar */
    els.themeToggle.addEventListener("click", function () {
      state.settings.theme = effectiveTheme() === "dark" ? "light" : "dark";
      applyTheme();
      scheduleSave();
    });
    els.wallpaperBtn.addEventListener("click", function () { openSettings("wallpaper"); });
    els.exportBtn.addEventListener("click", function () { exportConversation(); });
    els.topSettingsBtn.addEventListener("click", openSettings);
    els.connectionChip.addEventListener("click", openSettings);

    /* Wallpapers */
    els.wallpaperInput.addEventListener("change", function () { addWallpapers(els.wallpaperInput.files); });
    els.wallpaperGrid.addEventListener("click", function (e) {
      if (e.target.closest("[data-wallpaper-add]")) {
        els.wallpaperInput.click();
        return;
      }
      var remove = e.target.closest("[data-wallpaper-remove]");
      if (remove) {
        e.stopPropagation();
        removeWallpaper(remove.dataset.wallpaperRemove);
        return;
      }
      var slot = e.target.closest("[data-wallpaper-id]");
      if (slot) setActiveWallpaper(slot.dataset.wallpaperId);
    });
    els.wallpaperGrid.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("[data-wallpaper-remove]")) return;
      var slot = e.target.closest("[data-wallpaper-id]");
      if (slot) {
        e.preventDefault();
        setActiveWallpaper(slot.dataset.wallpaperId);
      }
    });
    els.wallpaperEnabled.addEventListener("click", function () {
      if (!state.wallpapers.length) {
        toast("先添加一张壁纸", "error");
        els.wallpaperInput.click();
        return;
      }
      var wp = state.settings.wallpaper;
      wp.enabled = !wp.enabled;
      if (wp.enabled && !wp.activeId) wp.activeId = state.wallpapers[0].id;
      state.currentWallpaperId = "";
      applyWallpaper();
      startWallpaperRotation();
      scheduleSave();
      toast(wp.enabled ? "已启用壁纸与玻璃面板" : "已关闭壁纸");
    });
    els.wallpaperDisable.addEventListener("click", function () {
      state.settings.wallpaper.enabled = false;
      state.currentWallpaperId = "";
      applyWallpaper();
      stopWallpaperRotation();
      scheduleSave();
      toast("已关闭壁纸");
    });
    els.wpRotate.addEventListener("change", function () {
      state.settings.wallpaper.rotate = els.wpRotate.checked;
      startWallpaperRotation();
      scheduleSave();
    });
    els.wpInterval.addEventListener("change", function () {
      state.settings.wallpaper.interval = clampNumber(els.wpInterval.value, 15, 3600, 60);
      startWallpaperRotation();
      scheduleSave();
    });
    [
      ["wpOpacity", "opacity", "wpOpacityOut", "%"],
      ["wpBlur", "blur", "wpBlurOut", "px"],
      ["wpBrightness", "brightness", "wpBrightnessOut", "%"],
      ["wpScale", "scale", "wpScaleOut", "%"],
      ["glassBlur", "glassBlur", "glassBlurOut", "px"],
      ["glassOpacity", "glassOpacity", "glassOpacityOut", "%"]
    ].forEach(function (def) {
      var input = document.getElementById(def[0]);
      var output = document.getElementById(def[2]);
      if (!input) return;
      input.addEventListener("input", function () {
        var value = Number(input.value);
        state.settings.wallpaper[def[1]] = value;
        if (output) output.textContent = value + def[3];
        applyWallpaper();
        scheduleSave();
      });
    });

    /* Demo banner */
    els.demoBannerAction.addEventListener("click", openSettings);
    els.demoBannerClose.addEventListener("click", function () {
      state.settings.bannerDismissed = true;
      els.demoBanner.hidden = true;
      scheduleSave();
    });

    /* Welcome delegated */
    els.welcome.addEventListener("click", function (e) {
      var promptBtn = e.target.closest("[data-prompt]");
      if (promptBtn) {
        if (promptBtn.closest(".agent-cap-card")) {
          setMode("agent", { fill: promptBtn.dataset.prompt });
        } else {
          els.composerInput.value = promptBtn.dataset.prompt;
          autosizeInput();
          updateSendState();
          els.composerInput.focus();
        }
        return;
      }
      var cta = e.target.closest("#agentCta");
      if (cta) {
        newChat(state.settings.mode === "agent" ? "chat" : "agent");
      }
    });

    /* Composer */
    els.composer.addEventListener("submit", function (e) {
      e.preventDefault();
      if (state.streaming) stopStreaming();
      else sendMessage();
    });
    els.composerInput.addEventListener("input", function () {
      var conv = activeConversation();
      conv.draft = els.composerInput.value;
      autosizeInput();
      updateSendState();
      scheduleSave();
    });
    els.composerInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (state.streaming) stopStreaming();
        else sendMessage();
      }
    });
    els.sendBtn.addEventListener("click", function (e) {
      if (state.streaming) {
        e.preventDefault();
        stopStreaming();
      }
    });
    els.thinkToggle.addEventListener("click", function () {
      if (state.settings.mode === "agent") return;
      if (state.streaming) return toast("请先停止当前生成", "error");
      state.settings.deepThink = !state.settings.deepThink;
      updateModeUI();
      scheduleSave();
      toast(state.settings.deepThink ? "已开启深度思考" : "已关闭深度思考");
    });
    els.searchToggle.addEventListener("click", function () {
      if (state.settings.mode === "agent") return;
      if (state.streaming) return toast("请先停止当前生成", "error");
      state.settings.webSearch = !state.settings.webSearch;
      updateModeUI();
      scheduleSave();
      toast(state.settings.webSearch ? "已开启联网搜索" : "已关闭联网搜索");
    });
    els.attachBtn.addEventListener("click", function () { els.fileInput.click(); });
    els.fileInput.addEventListener("change", function () { addFiles(els.fileInput.files); });
    els.attachmentTray.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-remove-attachment]");
      if (!btn) return;
      state.attachments = state.attachments.filter(function (a) { return a.id !== btn.dataset.removeAttachment; });
      updateAttachmentTray();
    });

    /* Chat scrolling */
    els.chatScroll.addEventListener("scroll", function () {
      var main = document.getElementById("main");
      main.classList.toggle("is-scrolled", els.chatScroll.scrollTop > 8);
      updateScrollButton();
    }, { passive: true });
    els.scrollBottom.addEventListener("click", function () { scrollToBottom("smooth"); });

    /* Message actions + code copy */
    els.messages.addEventListener("click", function (e) {
      var copyCode = e.target.closest("[data-copy-code]");
      if (copyCode) {
        var code = copyCode.closest(".code-block").querySelector("code").textContent;
        copyText(code).then(function () {
          copyCode.innerHTML = icon("check") + "<span>已复制</span>";
          setTimeout(function () { copyCode.innerHTML = icon("copy") + "<span>复制</span>"; }, 1300);
        }).catch(function () { toast("复制失败", "error"); });
        return;
      }
      var actionBtn = e.target.closest("[data-action]");
      if (!actionBtn) return;
      var article = actionBtn.closest("[data-msg-id]");
      var msgId = article && article.dataset.msgId;
      var action = actionBtn.dataset.action;
      if (action === "copy-message") copyMessage(msgId);
      else if (action === "regenerate") regenerateMessage(msgId);
      else if (action === "feedback-up") setFeedback(msgId, "up");
      else if (action === "feedback-down") setFeedback(msgId, "down");
      else if (action === "download-artifact") downloadDemoArtifact(msgId, Number(actionBtn.dataset.artifactIndex));
      else if (action === "toggle-trace") {
        var conv = activeConversation();
        var msg = conv.messages.find(function (m) { return m.id === msgId; });
        if (msg && msg.agent) {
          msg.agent.open = msg.agent.open === false;
          var trace = article.querySelector(".agent-trace");
          if (trace) {
            trace.dataset.open = msg.agent.open ? "true" : "false";
            var head = trace.querySelector(".trace-head");
            if (head) head.setAttribute("aria-expanded", msg.agent.open ? "true" : "false");
          }
          scheduleSave();
        }
      } else if (action === "review-confirm") {
        var conv2 = activeConversation();
        var msg2 = conv2.messages.find(function (m) { return m.id === msgId; });
        if (!msg2 || !msg2.agent) return;
        var step = msg2.agent.steps.find(function (s) { return s.id === actionBtn.closest("[data-step-id]").dataset.stepId; });
        if (step) openConfirmDialog(msg2, step);
      }
    });

    /* Settings dialog */
    $$("[data-close-dialog]").forEach(function (btn) {
      btn.addEventListener("click", function () { closeDialog(document.getElementById(btn.dataset.closeDialog)); });
    });
    els.settingsDialog.addEventListener("click", function (e) {
      if (e.target === els.settingsDialog) closeDialog(els.settingsDialog);
    });
    els.settingsDialog.addEventListener("close", function () {
      if (!document.querySelector("dialog[open]")) document.body.classList.remove("dialog-open");
    });
    $$(".theme-option").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.settings.theme = btn.dataset.themeChoice;
        applyTheme();
        scheduleSave();
      });
    });
    els.keyVisibilityBtn.addEventListener("click", function () {
      var visible = els.apiKeyInput.type === "text";
      els.apiKeyInput.type = visible ? "password" : "text";
      els.keyVisibilityBtn.innerHTML = icon(visible ? "eye" : "eye-off");
    });
    els.saveKeyBtn.addEventListener("click", saveKey);
    els.clearKeyBtn.addEventListener("click", clearKey);
    els.testKeyBtn.addEventListener("click", testConnection);
    els.exportAllBtn.addEventListener("click", exportAll);
    els.clearAllBtn.addEventListener("click", clearAllConversations);
    els.apiKeyInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); saveKey(); }
    });

    /* Confirm dialog */
    els.confirmApprove.addEventListener("click", function () { sendAgentDecision(true); });
    els.confirmCancel.addEventListener("click", function () { sendAgentDecision(false); });
    els.confirmDialog.addEventListener("cancel", function (e) {
      e.preventDefault();
      if (state.pendingConfirm) sendAgentDecision(false);
    });

    /* Context menu */
    els.contextMenu.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-menu-action]");
      if (!btn) return;
      var id = els.contextMenu.dataset.convId;
      var action = btn.dataset.menuAction;
      closeContextMenu();
      if (action === "rename") renameConversation(id);
      else if (action === "export") {
        var conv = state.conversations.find(function (c) { return c.id === id; });
        if (conv) exportConversation(conv);
      } else if (action === "delete") deleteConversation(id);
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest("#contextMenu") && !e.target.closest("[data-conv-menu]")) closeContextMenu();
    });
    window.addEventListener("scroll", closeContextMenu, true);

    /* Keyboard shortcuts */
    document.addEventListener("keydown", function (e) {
      var meta = isMac ? e.metaKey : e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newChat(state.settings.mode);
      } else if (meta && e.key === "/") {
        e.preventDefault();
        els.composerInput.focus();
      } else if (e.key === "Escape") {
        closeContextMenu();
        closeSidebar();
      }
    });

    /* System theme */
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () { if (state.settings.theme === "system") applyTheme(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    window.addEventListener("pagehide", flushSave);
    window.addEventListener("beforeunload", flushSave);
    window.addEventListener("resize", function () {
      if (window.innerWidth > 920) closeSidebar();
      syncSidebarCollapse();
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  function cacheElements() {
    els.appShell = $("#appShell");
    els.sidebar = $("#sidebar");
    els.sidebarScrim = $("#sidebarScrim");
    els.newChatBtn = $("#newChatBtn");
    els.collapseBtn = $("#collapseBtn");
    els.brandHome = $("#brandHome");
    els.conversationSearch = $("#conversationSearch");
    els.searchClear = $("#searchClear");
    els.conversationList = $("#conversationList");
    els.agentEntry = $("#agentEntry");
    els.accountBtn = $("#accountBtn");
    els.settingsBtn = $("#settingsBtn");
    els.planLabel = $("#planLabel");
    els.mobileMenuBtn = $("#mobileMenuBtn");
    els.chatTitle = $("#chatTitle");
    els.modeBadge = $("#modeBadge");
    els.connectionChip = $("#connectionChip");
    els.connectionText = $("#connectionText");
    els.themeToggle = $("#themeToggle");
    els.wallpaperBtn = $("#wallpaperBtn");
    els.wallpaperLayer = $("#wallpaperLayer");
    els.wallpaperSlides = $("#wallpaperSlides");
    els.wallpaperGrid = $("#wallpaperGrid");
    els.wallpaperInput = $("#wallpaperInput");
    els.wallpaperSection = $("#wallpaperSection");
    els.wallpaperEnabled = $("#wallpaperEnabled");
    els.wallpaperCount = $("#wallpaperCount");
    els.wallpaperStorage = $("#wallpaperStorage");
    els.wallpaperDisable = $("#wallpaperDisable");
    els.loginScreen = $("#loginScreen");
    els.loginForm = $("#loginForm");
    els.loginPassword = $("#loginPassword");
    els.loginSubmit = $("#loginSubmit");
    els.loginError = $("#loginError");
    els.lanSection = $("#lanSection");
    els.lanStatusPill = $("#lanStatusPill");
    els.lanCard = $("#lanCard");
    els.lanQrWrap = $("#lanQrWrap");
    els.lanQr = $("#lanQr");
    els.lanUrl = $("#lanUrl");
    els.lanHint = $("#lanHint");
    els.copyLanUrl = $("#copyLanUrl");
    els.logoutBtn = $("#logoutBtn");
    els.workspaceSection = $("#workspaceSection");
    els.workspacePath = $("#workspacePath");
    els.workspaceHint = $("#workspaceHint");
    els.workspaceStatusPill = $("#workspaceStatusPill");
    els.chooseWorkspace = $("#chooseWorkspace");
    els.resetWorkspace = $("#resetWorkspace");
    els.workspaceDialog = $("#workspaceDialog");
    els.workspaceUp = $("#workspaceUp");
    els.workspaceBrowsePath = $("#workspaceBrowsePath");
    els.workspaceList = $("#workspaceList");
    els.workspaceError = $("#workspaceError");
    els.workspaceSelect = $("#workspaceSelect");
    els.workspaceCancel = $("#workspaceCancel");
    els.permissionSection = $("#permissionSection");
    els.fullAccessPill = $("#fullAccessPill");
    els.fullAccessHint = $("#fullAccessHint");
    els.fullAccessSettingsBtn = $("#fullAccessSettingsBtn");
    els.agentAccessBtn = $("#agentAccessBtn");
    els.agentAccessText = $("#agentAccessText");
    els.fullAccessDialog = $("#fullAccessDialog");
    els.fullAccessAck = $("#fullAccessAck");
    els.fullAccessEnable = $("#fullAccessEnable");
    els.fullAccessCancel = $("#fullAccessCancel");
    els.fullAccessWorkspacePath = $("#fullAccessWorkspacePath");
    els.wpRotate = $("#wpRotate");
    els.wpInterval = $("#wpInterval");
    els.wpOpacity = $("#wpOpacity");
    els.wpOpacityOut = $("#wpOpacityOut");
    els.wpBlur = $("#wpBlur");
    els.wpBlurOut = $("#wpBlurOut");
    els.wpBrightness = $("#wpBrightness");
    els.wpBrightnessOut = $("#wpBrightnessOut");
    els.wpScale = $("#wpScale");
    els.wpScaleOut = $("#wpScaleOut");
    els.glassBlur = $("#glassBlur");
    els.glassBlurOut = $("#glassBlurOut");
    els.glassOpacity = $("#glassOpacity");
    els.glassOpacityOut = $("#glassOpacityOut");
    els.exportBtn = $("#exportBtn");
    els.topSettingsBtn = $("#topSettingsBtn");
    els.demoBanner = $("#demoBanner");
    els.demoBannerText = $("#demoBannerText");
    els.demoBannerAction = $("#demoBannerAction");
    els.demoBannerClose = $("#demoBannerClose");
    els.chatScroll = $("#chatScroll");
    els.chatInner = $("#chatInner");
    els.welcome = $("#welcome");
    els.messages = $("#messages");
    els.scrollBottom = $("#scrollBottom");
    els.composer = $("#composer");
    els.composerInput = $("#composerInput");
    els.attachmentTray = $("#attachmentTray");
    els.attachBtn = $("#attachBtn");
    els.fileInput = $("#fileInput");
    els.newAgentBtn = $("#newAgentBtn");
    els.chatTools = $("#chatTools");
    els.agentTools = $("#agentTools");
    els.thinkToggle = $("#thinkToggle");
    els.searchToggle = $("#searchToggle");
    els.modelLabel = $("#modelLabel");
    els.sendBtn = $("#sendBtn");
    els.composerHint = $("#composerHint");
    els.toastStack = $("#toastStack");
    els.contextMenu = $("#contextMenu");
    els.settingsDialog = $("#settingsDialog");
    els.apiKeyInput = $("#apiKeyInput");
    els.keyVisibilityBtn = $("#keyVisibilityBtn");
    els.saveKeyBtn = $("#saveKeyBtn");
    els.clearKeyBtn = $("#clearKeyBtn");
    els.testKeyBtn = $("#testKeyBtn");
    els.keyStatusPill = $("#keyStatusPill");
    els.keyHint = $("#keyHint");
    els.serviceDot = $("#serviceDot");
    els.serverAddress = $("#serverAddress");
    els.exportAllBtn = $("#exportAllBtn");
    els.clearAllBtn = $("#clearAllBtn");
    els.confirmDialog = $("#confirmDialog");
    els.confirmSubtitle = $("#confirmSubtitle");
    els.confirmPath = $("#confirmPath");
    els.confirmKind = $("#confirmKind");
    els.confirmDiff = $("#confirmDiff");
    els.confirmApprove = $("#confirmApprove");
    els.confirmCancel = $("#confirmCancel");
  }

  function init() {
    cacheElements();
    loadState();
    applyTheme();
    bindEvents();
    initMarkdownWorker();
    syncSidebarCollapse();
    syncComposerFromActive();
    updateModeUI();
    updateFullAccessUI();
    ensureWallpaperLayers();
    syncWallpaperControls();
    renderWallpaperSlots();
    initWallpapers();
    renderSidebar();
    renderChat({ forceBottom: true });
    updateConnectionUI();
    initAuth();
    setTimeout(function () { els.composerInput.focus(); }, 120);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
