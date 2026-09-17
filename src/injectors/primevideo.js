// Prime Video 인젝터
// 재생 리소스 API 응답(GetVodPlaybackResources 등)에서 TTML2 자막 URL 목록과 카탈로그 메타데이터를 추출함
(() => {
  "use strict";
  const SD = window.__subtitlesDownloader__;
  if (!SD) return;

  const PLATFORM = "primevideo";
  const MATCH_KEYS = ["GetVodPlaybackResources", "catalogMetadata", "dvWebSPA", "playerChromeResources"];
  const inFlight = new Set();
  let lastVideoId = null;
  let lastTracks = null;
  let lastInfo = null;

  function matches(url) {
    return MATCH_KEYS.some((k) => url.includes(k));
  }

  function idFrom(obj, url) {
    try {
      const u = new URL(url, location.origin);
      const id = u.searchParams.get("entityId") || u.searchParams.get("titleId");
      if (id) return id;
    } catch {
      // URL 파싱 실패 시 응답 본문에서 추출
    }
    const cat = (obj.resources && obj.resources.catalogMetadataV2 && obj.resources.catalogMetadataV2.catalog)
      || (obj.catalogMetadataV2 && obj.catalogMetadataV2.catalog);
    return obj.id || obj.entityId || obj.catalogId || (cat && cat.id) || null;
  }

  function sourceOf(type) {
    const t = String(type || "").toLowerCase();
    if (t.includes("forced")) return "forced";
    if (t.includes("sdh") || t.includes("caption")) return "sdh";
    return "primary";
  }

  function handle(obj, url) {
    if (!obj || typeof obj !== "object") return;
    const videoId = idFrom(obj, url) || lastVideoId;
    if (!videoId) return;
    const tt = (obj.timedTextUrls && obj.timedTextUrls.result) || (obj.resources && obj.resources.playbackResources);
    if (tt && (Array.isArray(tt.subtitleUrls) || Array.isArray(tt.forcedNarrativeUrls))) {
      const all = [...(tt.subtitleUrls || []), ...(tt.forcedNarrativeUrls || [])];
      const seen = new Set();
      const tracks = [];
      for (const s of all) {
        if (!s || !s.url) continue;
        const language = String(s.languageCode || "und").toLowerCase();
        const source = sourceOf(s.type);
        const id = `${language}|${source}|${s.index != null ? s.index : ""}`;
        if (seen.has(id)) continue;
        seen.add(id);
        tracks.push({ id, platform: PLATFORM, language, label: s.displayName || s.languageCode, source, url: s.url, format: "ttml" });
      }
      lastVideoId = videoId;
      lastTracks = tracks;
      SD.post("TRACKS", { platform: PLATFORM, videoId, tracks });
    }
    const cat = (obj.resources && obj.resources.catalogMetadataV2 && obj.resources.catalogMetadataV2.catalog)
      || (obj.catalogMetadataV2 && obj.catalogMetadataV2.catalog)
      || (obj.resources && obj.resources.catalogMetadata && obj.resources.catalogMetadata.catalog);
    if (cat && (cat.title || cat.seriesTitle)) {
      const isSeries = cat.type === "EPISODE" || !!cat.seriesTitle;
      lastVideoId = videoId;
      lastInfo = {
        platform: PLATFORM,
        videoId,
        title: isSeries ? cat.seriesTitle || cat.title : cat.title,
        episodeTitle: isSeries ? cat.title : undefined,
        isSeries,
        season: cat.seasonNumber,
        episode: cat.episodeNumber,
      };
      SD.post("VIDEO_INFO", lastInfo);
    }
  }

  function handleText(text, url) {
    if (!text) return;
    try {
      handle(JSON.parse(text), url);
    } catch {
      // JSON이 아닌 응답은 무시
    }
  }

  SD.hookFetch((url, res) => {
    if (!matches(url)) return;
    res.clone().text().then((t) => handleText(t, url)).catch(() => {});
  });

  SD.hookXhr((url, xhr) => {
    if (!matches(url)) return;
    const text = SD.xhrText(xhr);
    if (text) {
      handleText(text, url);
      return;
    }
    // 바이너리 응답 타입이면 동일 요청을 재전송하여 본문 확보
    if (inFlight.has(url)) return;
    inFlight.add(url);
    fetch(url, { method: xhr.__sdMethod || "GET", credentials: "include" })
      .then((r) => r.text())
      .then((t) => handleText(t, url))
      .catch(() => {})
      .finally(() => inFlight.delete(url));
  });

  SD.onRequest((type) => {
    if (type !== "REQUEST_TRACKS") return;
    if (lastInfo) SD.post("VIDEO_INFO", lastInfo);
    if (lastTracks && lastVideoId) SD.post("TRACKS", { platform: PLATFORM, videoId: lastVideoId, tracks: lastTracks });
  });
})();
