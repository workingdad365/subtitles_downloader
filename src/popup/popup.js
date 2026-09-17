// 팝업 UI
// 활성 탭의 콘텐츠 스크립트(플랫폼 트랙)와 백그라운드(범용 감지 트랙)에서 상태를 읽어 목록을 그리고 다운로드를 요청함
(() => {
  "use strict";

  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  const $ = (id) => document.getElementById(id);

  const state = { tab: null, platform: null, native: null, universal: null, settings: { format: "srt", saveAs: false }, busy: false };

  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames([chrome.i18n.getUILanguage()], { type: "language" });
  } catch {
    displayNames = null;
  }

  function languageName(code) {
    if (!code || code === "und") return t("langUnknown");
    try {
      const name = displayNames ? displayNames.of(code) : null;
      return name && name !== code ? name : code.toUpperCase();
    } catch {
      return code.toUpperCase();
    }
  }

  function sourceTag(source) {
    switch (source) {
      case "cc": return t("srcCc");
      case "sdh": return t("srcSdh");
      case "forced": return t("srcForced");
      case "auto": return t("srcAuto");
      case "translated": return t("srcTranslated");
      default: return "";
    }
  }

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
  }

  function setStatus(text, kind) {
    const el = $("status");
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.className = "status";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = `status ${kind || ""}`;
  }

  function setBusy(busy) {
    state.busy = busy;
    document.querySelectorAll("button.btn").forEach((b) => {
      b.disabled = busy;
    });
  }

  // -------------------------------------------------------------------------
  // 렌더링
  // -------------------------------------------------------------------------

  function renderVideo() {
    const card = $("videoCard");
    const info = state.native && state.native.videoInfo;
    if (!state.platform) {
      card.hidden = false;
      $("platformBadge").textContent = t("anySite");
      $("videoMeta").textContent = "";
      $("videoTitle").textContent = state.tab && state.tab.title ? state.tab.title : "";
      return;
    }
    card.hidden = false;
    $("platformBadge").textContent = Platforms.nameOf(state.platform);
    if (!info) {
      $("videoMeta").textContent = "";
      $("videoTitle").textContent = t("noVideo");
      return;
    }
    const meta = [];
    if (info.isSeries && (info.season != null || info.episode != null)) {
      meta.push(`S${String(info.season ?? "?").padStart(2, "0")}E${String(info.episode ?? "?").padStart(2, "0")}`);
    }
    if (info.episodeTitle) meta.push(info.episodeTitle);
    $("videoMeta").textContent = meta.join(" · ");
    $("videoTitle").textContent = info.title || "";
  }

  function trackItem(track, onDownload) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "track-main";
    const lang = document.createElement("div");
    lang.className = "track-lang";
    lang.textContent = languageName(track.language);
    const tag = sourceTag(track.source);
    if (tag) {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      lang.append(" ", span);
    }
    if (track.kind === "hls" || track.kind === "dash") {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = track.kind.toUpperCase();
      lang.append(" ", span);
    }
    const label = document.createElement("div");
    label.className = "track-label";
    label.textContent = track.label && track.label.toLowerCase() !== (track.language || "").toLowerCase() ? track.label : (track.format || "");
    label.title = track.url || "";
    main.append(lang, label);
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = t("download");
    btn.addEventListener("click", () => onDownload(track, btn));
    li.append(main, btn);
    return li;
  }

  function renderNative() {
    const list = $("tracks");
    const empty = $("tracksEmpty");
    const section = $("tracksSection");
    list.textContent = "";
    empty.textContent = "";
    $("translateSection").hidden = true;
    if (!state.platform) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (!state.native) {
      empty.textContent = t("errContentScript");
      return;
    }
    const tracks = Array.isArray(state.native.tracks) ? state.native.tracks : [];
    if (!tracks.length) {
      empty.textContent = t("noTracks");
    }
    for (const track of tracks) list.append(trackItem(track, downloadNative));
    if (state.platform === "youtube" && tracks.length && Array.isArray(state.native.translationLanguages) && state.native.translationLanguages.length) {
      const select = $("tlang");
      const current = select.value;
      select.textContent = "";
      for (const l of state.native.translationLanguages) {
        const opt = document.createElement("option");
        opt.value = l.code;
        opt.textContent = `${languageName(l.code)} (${l.code})`;
        select.append(opt);
      }
      const preferred = current || chrome.i18n.getUILanguage().split("-")[0];
      if (Array.from(select.options).some((o) => o.value === preferred)) select.value = preferred;
      $("translateSection").hidden = false;
    }
  }

  function renderUniversal() {
    const section = $("universalSection");
    const list = $("universalTracks");
    const empty = $("universalEmpty");
    const toggle = $("universalToggle");
    const hint = $("universalHint");
    list.textContent = "";
    empty.textContent = "";
    if (state.platform) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const enabled = !!(state.universal && state.universal.enabled);
    toggle.textContent = enabled ? t("universalDisable") : t("universalEnable");
    hint.textContent = enabled ? t("universalHintEnabled") : t("universalHint");
    if (!enabled) return;
    const tracks = state.universal.tracks || [];
    if (!tracks.length) {
      empty.textContent = t("universalEmpty");
      return;
    }
    for (const track of tracks) list.append(trackItem(track, downloadUniversal));
  }

  function render() {
    renderVideo();
    renderNative();
    renderUniversal();
  }

  // -------------------------------------------------------------------------
  // 데이터 로드
  // -------------------------------------------------------------------------

  async function loadSettings() {
    state.settings = await chrome.storage.local.get({ format: "srt", saveAs: false });
    $("format").value = state.settings.format;
    $("saveAs").checked = !!state.settings.saveAs;
  }

  async function refresh() {
    if (!state.tab) return;
    if (state.platform) {
      try {
        state.native = await chrome.tabs.sendMessage(state.tab.id, { type: "GET_STATE" });
      } catch {
        state.native = null;
      }
    } else {
      try {
        state.universal = await chrome.runtime.sendMessage({ type: "GET_UNIVERSAL_STATE", tabId: state.tab.id });
      } catch {
        state.universal = { enabled: false, tracks: [] };
      }
    }
    render();
  }

  // -------------------------------------------------------------------------
  // 다운로드
  // -------------------------------------------------------------------------

  async function runDownload(btn, request) {
    if (state.busy) return;
    setBusy(true);
    const original = btn ? btn.textContent : null;
    if (btn) btn.textContent = t("downloading");
    setStatus(t("downloading"));
    try {
      const res = await request();
      if (!res || !res.ok) throw new Error((res && res.error) || t("errUnknown"));
      setStatus(t("downloaded", [res.filename]), "ok");
    } catch (err) {
      setStatus(`${t("errPrefix")} ${err && err.message ? err.message : String(err)}`, "err");
    } finally {
      if (btn) btn.textContent = original;
      setBusy(false);
    }
  }

  function downloadNative(track, btn, tlang) {
    return runDownload(btn, () => chrome.tabs.sendMessage(state.tab.id, { type: "DOWNLOAD", track, format: $("format").value, tlang: tlang || null }));
  }

  function downloadUniversal(track, btn) {
    return runDownload(btn, () => chrome.runtime.sendMessage({ type: "DOWNLOAD_UNIVERSAL", tabId: state.tab.id, trackId: track.id, format: $("format").value }));
  }

  async function toggleUniversal() {
    const enabled = !!(state.universal && state.universal.enabled);
    try {
      if (enabled) await chrome.permissions.remove({ origins: ["<all_urls>"] });
      else {
        const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
        if (!granted) return;
      }
      await chrome.runtime.sendMessage({ type: "UNIVERSAL_PERMISSION_CHANGED" });
      if (!enabled) setStatus(t("universalReloadHint"));
      await refresh();
    } catch (err) {
      setStatus(`${t("errPrefix")} ${err.message}`, "err");
    }
  }

  // -------------------------------------------------------------------------
  // 초기화
  // -------------------------------------------------------------------------

  async function init() {
    applyI18n();
    await loadSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    state.platform = tab && tab.url ? Platforms.detect(tab.url) : null;
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
      $("videoCard").hidden = true;
      $("tracksSection").hidden = true;
      $("universalSection").hidden = true;
      setStatus(t("notSupported"), "err");
      return;
    }
    $("format").addEventListener("change", () => chrome.storage.local.set({ format: $("format").value }));
    $("saveAs").addEventListener("change", () => chrome.storage.local.set({ saveAs: $("saveAs").checked }));
    $("refresh").addEventListener("click", async () => {
      if (state.platform) {
        try {
          await chrome.tabs.sendMessage(state.tab.id, { type: "REFRESH" });
        } catch {
          // 콘텐츠 스크립트 미로드 시 무시
        }
        setTimeout(refresh, 800);
      }
      refresh();
    });
    $("translateDownload").addEventListener("click", () => {
      const tracks = (state.native && state.native.tracks) || [];
      const base = tracks.find((x) => x.source === "primary" && x.translatable !== false) || tracks.find((x) => x.translatable !== false) || tracks[0];
      if (!base) return;
      downloadNative(base, $("translateDownload"), $("tlang").value);
    });
    $("universalToggle").addEventListener("click", toggleUniversal);
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "STATE_CHANGED" && !state.busy) refresh();
    });
    await refresh();
  }

  init().catch((err) => setStatus(`${t("errPrefix")} ${err.message}`, "err"));
})();
