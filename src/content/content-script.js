// 콘텐츠 스크립트 (ISOLATED world)
// 인젝터가 postMessage로 보내는 트랙/영상 정보를 수집하고, 팝업 요청에 따라 자막을 받아 변환 후 저장을 요청함
(() => {
  "use strict";

  const NS = "subtitles_downloader";
  const platform = Platforms.detect(location.href);
  if (!platform) return;

  const state = { videoId: null, videoInfo: null, tracksByVideo: {}, latestTracks: [], fallbackTracks: [], translationLanguages: [] };
  const pending = new Map();
  // Netflix: 백그라운드가 관찰한 자막 파일 요청 URL (trackKey -> url)
  const netflixObserved = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  const log = (...args) => console.info("[subtitles_downloader]", ...args);

  function notifyPopup() {
    chrome.runtime.sendMessage({ type: "STATE_CHANGED", scope: "native" }).catch(() => {});
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.ns !== NS || d.dir !== "page") return;
    if (d.requestId && pending.has(d.requestId)) {
      pending.get(d.requestId)(d.payload);
      pending.delete(d.requestId);
      return;
    }
    const p = d.payload || {};
    if (d.type === "VIDEO_INFO") {
      log("video info", p.videoId, p.title);
      state.videoInfo = p;
      if (p.videoId) state.videoId = p.videoId;
      notifyPopup();
    } else if (d.type === "TRACKS") {
      const tracks = Array.isArray(p.tracks) ? p.tracks : [];
      log("tracks", p.videoId, tracks.length);
      if (p.videoId) {
        state.tracksByVideo[p.videoId] = tracks;
        state.videoId = p.videoId;
      }
      state.latestTracks = tracks;
      if (Array.isArray(p.translationLanguages)) state.translationLanguages = p.translationLanguages;
      notifyPopup();
    }
  });

  function postPage(type, payload) {
    window.postMessage({ ns: NS, dir: "content", type, payload }, "*");
  }

  function requestPage(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, timeoutMs || 30000);
      pending.set(requestId, (payload2) => {
        clearTimeout(timer);
        resolve(payload2);
      });
      window.postMessage({ ns: NS, dir: "content", type, payload, requestId }, "*");
    });
  }

  // 인젝터 트랙 우선, 없으면 백그라운드 webRequest 폴백 트랙 사용
  function currentTracks() {
    let tracks = [];
    if (state.videoId && state.tracksByVideo[state.videoId]) tracks = state.tracksByVideo[state.videoId];
    else tracks = state.latestTracks;
    return tracks.length ? tracks : state.fallbackTracks;
  }

  // 영상 정보가 없을 때 페이지 제목으로 대체
  function currentVideoInfo() {
    if (state.videoInfo) return state.videoInfo;
    if (!currentTracks().length) return null;
    const title = FilenameUtils.cleanTitle(document.title);
    return { platform, videoId: state.videoId || location.href, title: title || document.title, isSeries: false, fromPageTitle: true };
  }

  function getState() {
    return {
      platform,
      url: location.href,
      videoId: state.videoId,
      videoInfo: currentVideoInfo(),
      tracks: currentTracks(),
      translationLanguages: state.translationLanguages,
    };
  }

  // -------------------------------------------------------------------------
  // 네트워크 (백그라운드 프록시 경유로 CORS 우회)
  // -------------------------------------------------------------------------

  async function proxyFetch(url, options) {
    const res = await chrome.runtime.sendMessage({ type: "PROXY_FETCH", url, method: (options && options.method) || "GET", headers: (options && options.headers) || {} });
    if (!res || !res.ok) {
      const err = new Error((res && res.error) || `fetch failed: ${url}`);
      err.status = res ? res.status : 0;
      throw err;
    }
    return res.text;
  }

  async function fetchWithRetry(url, options, retries) {
    const max = retries == null ? 3 : retries;
    let lastErr = null;
    for (let attempt = 0; attempt <= max; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
      try {
        return await proxyFetch(url, options);
      } catch (err) {
        lastErr = err;
        if (err.status !== 429 && err.status !== 503) throw err;
      }
    }
    throw lastErr;
  }

  async function fetchAll(urls, concurrency) {
    const results = new Array(urls.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < urls.length) {
        const i = next++;
        try {
          results[i] = await proxyFetch(urls[i]);
        } catch {
          results[i] = null;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency || 6, urls.length) }, worker));
    return results;
  }

  // -------------------------------------------------------------------------
  // 플랫폼별 자막 취득
  // -------------------------------------------------------------------------

  async function cuesFromSegments(urls, formatHint, offsets) {
    if (!urls.length) throw new Error(t("errSegments"));
    const texts = await fetchAll(urls, 6);
    if (!texts.some(Boolean)) throw new Error(t("errSegments"));
    return SubtitleFormats.mergeSegments(texts, formatHint, offsets);
  }

  // HLS 자막 플레이리스트 처리. mainBlockOnly가 참이면 빈 세그먼트만 있는 블록을 제외하고 가장 긴 블록만 사용 (Apple TV+ 광고/프리롤 대응)
  async function cuesFromHlsPlaylist(playlistUrl, mainBlockOnly) {
    const text = await proxyFetch(playlistUrl);
    if (!text.includes("#EXTM3U")) throw new Error(t("errSegments"));
    if (HlsUtils.isMasterPlaylist(text)) {
      const subs = HlsUtils.parseSubtitleTracks(text, playlistUrl);
      if (!subs.length) throw new Error(t("errSegments"));
      return cuesFromHlsPlaylist(subs[0].url, mainBlockOnly);
    }
    const { blocks } = HlsUtils.parseMediaSegments(text, playlistUrl);
    let segments;
    if (mainBlockOnly) {
      const candidates = blocks.filter((b) => b.segments.some((s) => !/empty-\d+\.webvtt/i.test(s.url)));
      candidates.sort((a, b) => b.durationMs - a.durationMs);
      segments = candidates.length ? candidates[0].segments : [];
    } else {
      segments = blocks.flatMap((b) => b.segments);
    }
    return cuesFromSegments(segments.map((s) => s.url), "vtt");
  }

  async function acquireSingle(url, formatHint) {
    const raw = await fetchWithRetry(url);
    const parsed = SubtitleFormats.parse(raw, formatHint);
    return { cues: parsed.cues, raw, rawFormat: parsed.format };
  }

  async function acquire(track, tlang) {
    switch (platform) {
      case "youtube": {
        let url = track.url;
        if (tlang) {
          const u = new URL(url);
          u.searchParams.set("tlang", tlang);
          url = u.toString();
        }
        return acquireSingle(url, track.format || "json3");
      }
      case "netflix": {
        let url = track.url;
        let format = track.format;
        if (!url && netflixObserved.has(track.trackKey)) {
          url = netflixObserved.get(track.trackKey);
          format = null;
        }
        if (!url) {
          // 1차: 인젝터가 트랙을 활성화하고 manifest 캐시에서 URL 확보
          const r = await requestPage("NETFLIX_RESOLVE_URL", { videoId: state.videoId, trackKey: track.trackKey }, 40000);
          if (r && r.url) {
            url = r.url;
            format = r.format;
          }
        }
        if (!url) {
          // 2차: 활성화 직후 플레이어가 실제로 요청한 자막 파일 URL을 백그라운드가 관찰할 때까지 대기
          for (let i = 0; i < 40 && !url; i++) {
            await sleep(250);
            if (netflixObserved.has(track.trackKey)) url = netflixObserved.get(track.trackKey);
          }
          format = null;
        }
        if (!url) throw new Error(t("errNetflixUrl"));
        log("netflix subtitle url resolved", track.trackKey, url.slice(0, 80));
        return acquireSingle(url, format);
      }
      case "primevideo":
        return acquireSingle(track.url, "ttml");
      case "disneyplus":
        return { cues: await cuesFromHlsPlaylist(track.url, false) };
      case "appletv":
        return { cues: await cuesFromHlsPlaylist(track.url, true) };
      case "hbomax": {
        const segments = Array.isArray(track.segments) ? track.segments : [];
        return { cues: await cuesFromSegments(segments.map((s) => s.url), track.mime === "ttml" ? "ttml" : "vtt") };
      }
      default:
        throw new Error(t("errUnsupported"));
    }
  }

  async function handleDownload({ track, format, tlang }) {
    if (!track) throw new Error(t("errUnsupported"));
    const effective = tlang ? { ...track, language: tlang, source: "translated" } : track;
    const result = await acquire(effective, tlang);
    const info = currentVideoInfo() || {};
    const useRaw = format === "original" && result.raw;
    if (!useRaw && (!result.cues || result.cues.length === 0)) throw new Error(t("errEmpty"));
    const ext = useRaw ? SubtitleFormats.rawExtensionFor(result.rawFormat) : SubtitleFormats.extensionFor(format);
    const filename = FilenameUtils.buildFilename({
      title: info.title || document.title,
      season: info.isSeries ? info.season : undefined,
      episode: info.isSeries ? info.episode : undefined,
      ext,
    });
    const content = useRaw ? result.raw : SubtitleFormats.serialize(result.cues, format, info.title || "Subtitles");
    log("saving", filename, `${content.length} chars`);
    await saveFile(filename, content);
    return { filename, cueCount: result.cues ? result.cues.length : 0 };
  }

  // 페이지 컨텍스트에서 Blob + 앵커 클릭으로 저장 (download 속성이 파일명을 결정함)
  function saveViaPage(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // 기본은 페이지 저장, "저장 위치 묻기"가 켜져 있거나 페이지 저장이 실패하면 백그라운드 downloads API 사용
  async function saveFile(filename, content) {
    const settings = await chrome.storage.local.get({ saveAs: false });
    if (!settings.saveAs) {
      try {
        saveViaPage(filename, content);
        log("saved via page", filename);
        return;
      } catch (err) {
        log("page save failed, falling back to background", err);
      }
    }
    const saved = await chrome.runtime.sendMessage({ type: "SAVE_FILE", filename, content });
    if (!saved || !saved.ok) throw new Error((saved && saved.error) || "save failed");
    log("saved via background", filename);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type === "GET_STATE") {
      sendResponse(getState());
      return false;
    }
    if (msg.type === "REFRESH") {
      postPage("REQUEST_TRACKS", {});
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "NETFLIX_SUBTITLE_REQUEST") {
      if (platform === "netflix" && msg.url) {
        requestPage("NETFLIX_ACTIVE_TRACK", {}, 2000).then((r) => {
          if (r && r.trackKey) {
            netflixObserved.set(r.trackKey, msg.url);
            log("netflix subtitle request observed for", r.trackKey);
          }
        });
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "FALLBACK_TRACKS") {
      if (msg.platform === platform && Array.isArray(msg.tracks)) {
        log("fallback tracks from background", msg.tracks.length, msg.manifestUrl);
        state.fallbackTracks = msg.tracks;
        notifyPopup();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "DOWNLOAD") {
      handleDownload(msg)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
      return true;
    }
    return false;
  });

  // 인젝터가 먼저 로드된 경우를 대비해 초기 트랙 요청
  setTimeout(() => postPage("REQUEST_TRACKS", {}), 1000);
})();
