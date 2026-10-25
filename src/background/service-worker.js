// 백그라운드 서비스 워커
// 역할: CORS 우회 프록시 fetch, 자막 텍스트 준비, 범용 자막 감지(webRequest, 선택 권한 <all_urls>)
importScripts(
  "../shared/formats.js",
  "../shared/hls.js",
  "../shared/dash.js",
  "../shared/filename.js",
  "../shared/platforms.js",
);

const SETTINGS_DEFAULTS = { format: "srt" };
const MAX_TRACKS_PER_TAB = 40;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

// 범용 감지 상태: tabId -> { url, title, tracks: Map<id, track>, seen: Set<url> }
const universalTabs = new Map();
const tabUrlCache = new Map();
let universalEnabled = false;

// ---------------------------------------------------------------------------
// 공용 유틸
// ---------------------------------------------------------------------------

function decodeBuffer(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

async function fetchText(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: (options && options.method) || "GET",
      headers: (options && options.headers) || {},
      body: options && options.body,
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_TEXT_BYTES) throw new Error("response too large");
    return { text: decodeBuffer(buffer), status: res.status, contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAll(urls, concurrency) {
  const results = new Array(urls.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      try {
        results[i] = (await fetchText(urls[i])).text;
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency || 6, urls.length) }, worker));
  return results;
}

async function getSettings() {
  return chrome.storage.local.get(SETTINGS_DEFAULTS);
}

// 폴더 선택 대화상자와 저장 중에도 닫히지 않는 전용 창을 생성함
chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab.id)) return;
  chrome.windows.create({
    url: chrome.runtime.getURL(`src/popup/popup.html?tabId=${tab.id}`),
    type: "popup", width: 440, height: 680,
  });
});

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------------------
// 범용 자막 감지
// ---------------------------------------------------------------------------

const FILE_EXT_RE = /\.(srt|vtt|webvtt|ass|ssa|ttml|dfxp|xml|sbv|smi|sami)(?:[?#]|$)/i;
const HLS_RE = /\.m3u8(?:[?#]|$)/i;
const DASH_RE = /\.mpd(?:[?#]|$)/i;
const SKIP_RE = /thumbnail|sprite|chapter|storyboard/i;
const KNOWN_LANGS = new Set(["en", "ko", "ja", "zh", "es", "fr", "de", "it", "pt", "ru", "ar", "hi", "nl", "pl", "tr", "sv", "da", "fi", "no", "nb", "cs", "el", "he", "th", "vi", "id", "ms", "uk", "ro", "hu", "bg", "hr", "sr", "sk", "sl", "et", "lv", "lt", "fa", "bn", "ta", "te", "fil", "tl", "ca", "eu", "gl", "und"]);

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h && h.value ? h.value.toLowerCase() : "";
}

function classify(url, contentType) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (SKIP_RE.test(u.pathname)) return null;
  const ct = contentType || "";
  if (ct.includes("mpegurl") || HLS_RE.test(u.pathname)) return "hls";
  if (ct.includes("dash+xml") || DASH_RE.test(u.pathname)) return "dash";
  if (ct.includes("text/vtt") || ct.includes("x-subrip") || ct.includes("ttml")) return "file";
  if (FILE_EXT_RE.test(u.pathname)) return "file";
  if (u.hostname.endsWith("youtube.com") && u.pathname === "/api/timedtext") return "file";
  return null;
}

function guessLanguage(url, text) {
  if (text) {
    const vttLang = text.slice(0, 2000).match(/^\s*Language\s*:\s*([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)\s*$/m);
    if (vttLang) return vttLang[1].toLowerCase();
    const xmlLang = text.slice(0, 4000).match(/xml:lang\s*=\s*"([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)"/);
    if (xmlLang) return xmlLang[1].toLowerCase();
  }
  try {
    const u = new URL(url);
    for (const key of ["tlang", "lang", "language", "locale", "hl"]) {
      const v = u.searchParams.get(key);
      if (v && /^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})?$/.test(v)) return v.toLowerCase().replace("_", "-");
    }
    const path = u.pathname.toLowerCase();
    const m = path.match(/(?:^|[/._-])([a-z]{2,3}(?:-[a-z]{2,4})?)(?=[/._-])/g) || [];
    for (const raw of m) {
      const code = raw.replace(/^[/._-]/, "");
      if (KNOWN_LANGS.has(code.split("-")[0])) return code;
    }
  } catch {
    // URL 파싱 실패 시 und
  }
  return "und";
}

function guessSource(url, label) {
  const s = `${url} ${label || ""}`.toLowerCase();
  if (/forced/.test(s)) return "forced";
  if (/\bsdh\b|\bcc\b|caption/.test(s)) return "sdh";
  return "primary";
}

function fileLabel(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtube.com") && u.pathname === "/api/timedtext") return "YouTube timedtext";
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last);
  } catch {
    return url;
  }
}

function getEntry(tabId) {
  if (!universalTabs.has(tabId)) universalTabs.set(tabId, { url: null, title: null, tracks: new Map(), seen: new Set() });
  return universalTabs.get(tabId);
}

function addTrack(entry, track) {
  if (entry.tracks.has(track.id)) return false;
  if (entry.tracks.size >= MAX_TRACKS_PER_TAB) return false;
  entry.tracks.set(track.id, track);
  return true;
}

async function tabInfo(tabId) {
  if (tabUrlCache.has(tabId)) return tabUrlCache.get(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const info = { url: tab.url || "", title: tab.title || "" };
    tabUrlCache.set(tabId, info);
    return info;
  } catch {
    return { url: "", title: "" };
  }
}

// 네이티브 플랫폼 폴백: 인젝터가 매니페스트를 놓친 경우(Worker 사용 등) CDN 요청을 webRequest로 잡아 콘텐츠 스크립트에 전달
const nativeSeen = new Map();
const NATIVE_FALLBACK = { disneyplus: "hls", appletv: "hls", hbomax: "dash" };

async function handleNativeFallback(details, platform, kind) {
  if (NATIVE_FALLBACK[platform] !== kind) return;
  if (kind === "dash" && details.url.includes("fallback.mpd")) return;
  const key = details.url.split("#")[0];
  if (!nativeSeen.has(details.tabId)) nativeSeen.set(details.tabId, new Set());
  const seen = nativeSeen.get(details.tabId);
  if (seen.has(key)) return;
  seen.add(key);
  let tracks = [];
  try {
    const { text } = await fetchText(details.url);
    if (kind === "hls") {
      if (!HlsUtils.isMasterPlaylist(text)) return;
      const ids = new Set();
      for (const s of HlsUtils.parseSubtitleTracks(text, details.url)) {
        if (platform === "appletv" && s.pathwayId && !s.pathwayId.toLowerCase().startsWith("ap")) continue;
        const source = s.forced ? "forced" : s.accessibility || /\[CC\]|\bSDH\b/i.test(s.name) ? "sdh" : "primary";
        const id = `${s.language}|${source}`;
        if (ids.has(id)) continue;
        ids.add(id);
        tracks.push({ id, platform, language: s.language, label: s.name, source, url: s.url, kind: platform === "appletv" ? "hls-appletv" : "hls" });
      }
    } else {
      tracks = DashUtils.parseTextTracks(text, details.url).map((t) => ({
        id: `${t.language}|${t.source}`, platform, language: t.language, label: t.label || t.language, source: t.source, kind: "dash", mime: t.kind, segments: t.segments,
      }));
    }
  } catch (err) {
    console.info("[subtitles_downloader] native fallback fetch failed", details.url, err);
    return;
  }
  if (!tracks.length) return;
  console.info("[subtitles_downloader] native fallback tracks", platform, tracks.length);
  chrome.tabs.sendMessage(details.tabId, { type: "FALLBACK_TRACKS", platform, tracks, manifestUrl: details.url }).catch(() => {});
}

// Netflix 플레이어가 자막 파일을 내려받는 요청 (nflxvideo.net/?o=...) 판별
function isNetflixSubtitleRequest(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("nflxvideo.net") && u.pathname === "/" && u.searchParams.has("o");
  } catch {
    return false;
  }
}

async function handleDetectedRequest(details) {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
  const contentType = headerValue(details.responseHeaders, "content-type");
  const kind = classify(details.url, contentType);
  const netflixSubtitle = !kind && isNetflixSubtitleRequest(details.url);
  if (!kind && !netflixSubtitle) return;
  let host;
  try {
    host = new URL(details.url).hostname;
  } catch {
    return;
  }
  const tab = await tabInfo(details.tabId);
  const nativePlatform = tab.url ? Platforms.detect(tab.url) : null;
  if (netflixSubtitle) {
    if (nativePlatform === "netflix") {
      chrome.tabs.sendMessage(details.tabId, { type: "NETFLIX_SUBTITLE_REQUEST", url: details.url }).catch(() => {});
    }
    return;
  }
  if (nativePlatform) {
    await handleNativeFallback(details, nativePlatform, kind);
    return;
  }
  if (!universalEnabled) return;
  if (Platforms.isNativeHost(host)) return;
  const entry = getEntry(details.tabId);
  entry.url = tab.url;
  entry.title = tab.title;
  const key = details.url.split("#")[0];
  if (entry.seen.has(key)) return;
  entry.seen.add(key);
  let added = false;
  try {
    if (kind === "file") {
      const { text } = await fetchText(details.url);
      const format = SubtitleFormats.detectFormat(text);
      if (!SubtitleFormats.isCueFormat(format)) return;
      const label = fileLabel(details.url);
      added = addTrack(entry, { id: key, kind: "file", url: details.url, format, language: guessLanguage(details.url, text), label, source: guessSource(details.url, label), text });
    } else if (kind === "hls") {
      const { text } = await fetchText(details.url);
      if (HlsUtils.isMasterPlaylist(text)) {
        for (const s of HlsUtils.parseSubtitleTracks(text, details.url)) {
          entry.seen.add(s.url.split("#")[0]);
          const source = s.forced ? "forced" : s.accessibility ? "sdh" : "primary";
          added = addTrack(entry, { id: s.url, kind: "hls", url: s.url, language: s.language, label: s.name, source }) || added;
        }
      } else if (/\.(vtt|webvtt|ttml|dfxp|xml)(\?|$)/im.test(text)) {
        const label = fileLabel(details.url);
        added = addTrack(entry, { id: key, kind: "hls", url: details.url, language: guessLanguage(details.url), label, source: guessSource(details.url, label) });
      }
    } else if (kind === "dash") {
      const { text } = await fetchText(details.url);
      for (const t of DashUtils.parseTextTracks(text, details.url)) {
        added = addTrack(entry, { id: `${key}#${t.language}|${t.source}`, kind: "dash", segments: t.segments, mime: t.kind, language: t.language, label: t.label, source: t.source }) || added;
      }
    }
  } catch (err) {
    console.info("[subtitles_downloader] universal detect failed", details.url, err);
  }
  if (added) broadcast({ type: "STATE_CHANGED", scope: "universal", tabId: details.tabId });
}

// MV3 서비스 워커는 리스너를 최상위에서 동기 등록해야 이벤트로 깨어남
// 호스트 권한이 없는 URL의 이벤트는 브라우저가 전달하지 않으므로 <all_urls> 필터를 항상 등록함
chrome.webRequest.onCompleted.addListener(
  (details) => {
    handleDetectedRequest(details).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "other", "media", "object"] },
  ["responseHeaders"],
);

async function syncUniversalPermission() {
  try {
    universalEnabled = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    universalEnabled = false;
  }
  if (!universalEnabled) universalTabs.clear();
}

chrome.permissions.onAdded.addListener(syncUniversalPermission);
chrome.permissions.onRemoved.addListener(syncUniversalPermission);
chrome.runtime.onInstalled.addListener(syncUniversalPermission);
chrome.runtime.onStartup.addListener(syncUniversalPermission);
syncUniversalPermission();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    tabUrlCache.set(tabId, { url: tab.url || changeInfo.url || "", title: tab.title || "" });
    if (changeInfo.url) {
      universalTabs.delete(tabId);
      nativeSeen.delete(tabId);
    }
  }
  if (changeInfo.title && tabUrlCache.has(tabId)) tabUrlCache.get(tabId).title = changeInfo.title;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  universalTabs.delete(tabId);
  nativeSeen.delete(tabId);
  tabUrlCache.delete(tabId);
});

function universalState(tabId) {
  const entry = universalTabs.get(tabId);
  const tracks = entry ? Array.from(entry.tracks.values()).map(({ text, segments, ...rest }) => ({ ...rest, segmentCount: segments ? segments.length : undefined })) : [];
  return { enabled: universalEnabled, title: entry ? entry.title : null, tracks };
}

async function prepareUniversal({ tabId, trackId, format }) {
  const entry = universalTabs.get(tabId);
  const track = entry ? entry.tracks.get(trackId) : null;
  if (!track) throw new Error("track not found");
  let cues = [];
  let raw = null;
  let rawFormat = null;
  if (track.kind === "file") {
    raw = track.text || (await fetchText(track.url)).text;
    const parsed = SubtitleFormats.parse(raw, track.format);
    cues = parsed.cues;
    rawFormat = parsed.format;
  } else if (track.kind === "hls") {
    const { text } = await fetchText(track.url);
    let playlistUrl = track.url;
    let playlist = text;
    if (HlsUtils.isMasterPlaylist(playlist)) {
      const subs = HlsUtils.parseSubtitleTracks(playlist, playlistUrl);
      if (!subs.length) throw new Error("no subtitle tracks in playlist");
      playlistUrl = subs[0].url;
      playlist = (await fetchText(playlistUrl)).text;
    }
    const { segments } = HlsUtils.parseMediaSegments(playlist, playlistUrl);
    const texts = await fetchAll(segments.map((s) => s.url), 6);
    cues = SubtitleFormats.mergeSegments(texts);
  } else if (track.kind === "dash") {
    const texts = await fetchAll(track.segments.map((s) => s.url), 6);
    cues = SubtitleFormats.mergeSegments(texts, track.mime === "ttml" ? "ttml" : "vtt");
  }
  const useRaw = format === "original" && raw;
  if (!useRaw && cues.length === 0) throw new Error("empty subtitle");
  const title = FilenameUtils.cleanTitle(entry.title) || "subtitle";
  const ext = useRaw ? SubtitleFormats.rawExtensionFor(rawFormat) : SubtitleFormats.extensionFor(format);
  const filename = FilenameUtils.buildFilename({ title, ext });
  return { filename, content: useRaw ? raw : SubtitleFormats.serialize(cues, format, title), cueCount: cues.length };
}

// ---------------------------------------------------------------------------
// 메시지 처리
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "PROXY_FETCH":
      fetchText(msg.url, { method: msg.method, headers: msg.headers, body: msg.body })
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: err.message, status: err.status || 0 }));
      return true;
    case "GET_UNIVERSAL_STATE":
      sendResponse(universalState(msg.tabId));
      return false;
    case "PREPARE_UNIVERSAL_SUBTITLE":
      prepareUniversal(msg)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "UNIVERSAL_PERMISSION_CHANGED":
      syncUniversalPermission().then(() => sendResponse({ ok: true, enabled: universalEnabled }));
      return true;
    case "GET_SETTINGS":
      getSettings().then(sendResponse);
      return true;
    case "SET_SETTINGS":
      chrome.storage.local.set(msg.settings || {}).then(() => sendResponse({ ok: true }));
      return true;
    default:
      return false;
  }
});
