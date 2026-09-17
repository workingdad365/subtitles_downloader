// HBO Max 인젝터
// fetch/XHR 후킹으로 DASH MPD를 가로채 텍스트 AdaptationSet의 세그먼트 목록을 추출하고,
// CMS 라우트 응답에서 제목/시즌/에피소드 정보를 수집함
(() => {
  "use strict";
  const SD = window.__subtitlesDownloader__;
  if (!SD || typeof DashUtils === "undefined") return;

  const PLATFORM = "hbomax";
  let lastMpd = null;
  let lastInfo = null;

  function videoIdFromUrl() {
    const m = location.href.match(/\/video\/watch\/([a-f0-9-]{36})(?:\/([a-f0-9-]{36}))?/);
    return m ? m[2] || m[1] : null;
  }

  function handleMpd(text, url) {
    if (!text || !text.includes("<MPD")) return;
    let parsed;
    try {
      parsed = DashUtils.parseTextTracks(text, url);
    } catch (err) {
      SD.log("MPD 파싱 실패", err);
      return;
    }
    const tracks = parsed.map((t) => ({
      id: `${t.language}|${t.source}`,
      platform: PLATFORM,
      language: t.language,
      label: t.label || t.language,
      source: t.source,
      kind: "dash",
      mime: t.kind,
      segments: t.segments,
    }));
    lastMpd = { text, url };
    SD.post("TRACKS", { platform: PLATFORM, videoId: videoIdFromUrl() || url, tracks });
  }

  function handleRoute(text, url) {
    const m = url.match(/\/video\/watch\/([a-f0-9-]{36})/);
    if (!m) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const included = Array.isArray(json.included) ? json.included : [];
    const item = included.find((x) => x.type === "video" && x.id === m[1]);
    if (!item || !item.attributes) return;
    const a = item.attributes;
    const isEpisode = (a.materialType || a.videoType) === "EPISODE";
    const name = a.name || a.originalName || "";
    let seriesTitle = null;
    if (isEpisode && item.relationships && item.relationships.show && item.relationships.show.data) {
      const show = included.find((x) => x.type === "show" && x.id === item.relationships.show.data.id);
      if (show && show.attributes) seriesTitle = show.attributes.name || show.attributes.originalName || null;
    }
    lastInfo = {
      platform: PLATFORM,
      videoId: videoIdFromUrl() || m[1],
      title: seriesTitle || name,
      episodeTitle: isEpisode ? name : undefined,
      isSeries: isEpisode,
      season: isEpisode ? a.seasonNumber : undefined,
      episode: isEpisode ? a.episodeNumber : undefined,
    };
    SD.post("VIDEO_INFO", lastInfo);
  }

  function isMpdUrl(url) {
    return url.includes(".mpd") && !url.includes("fallback.mpd");
  }

  SD.hookFetch((url, res) => {
    if (isMpdUrl(url)) res.clone().text().then((t) => handleMpd(t, url)).catch(() => {});
    else if (url.includes("/cms/routes/video/watch/")) res.clone().text().then((t) => handleRoute(t, url)).catch(() => {});
  });

  SD.hookXhr((url, xhr) => {
    const text = SD.xhrText(xhr);
    if (!text) return;
    if (isMpdUrl(url)) handleMpd(text, url);
    else if (url.includes("/cms/routes/video/watch/")) handleRoute(text, url);
  });

  SD.onRequest((type) => {
    if (type !== "REQUEST_TRACKS") return;
    if (lastInfo) SD.post("VIDEO_INFO", lastInfo);
    if (lastMpd) handleMpd(lastMpd.text, lastMpd.url);
  });
})();
