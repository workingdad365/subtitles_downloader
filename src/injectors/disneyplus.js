// Disney+ 인젝터
// 재생 응답(stream.sources[0].complete.url)의 마스터 m3u8을 감지해 자막 트랙(서브 플레이리스트)을 추출함
// 감지 경로: JSON.parse 후킹, Response.json 후킹, fetch 응답 복제, 마스터 m3u8 직접 요청 감지
(() => {
  "use strict";
  const SD = window.__subtitlesDownloader__;
  if (!SD || typeof HlsUtils === "undefined") return;

  const PLATFORM = "disneyplus";
  let lastMaster = null;
  let lastTracks = null;
  let lastInfo = null;

  function videoIdFromUrl() {
    const m = location.href.match(/\/(?:play|video)\/([a-f0-9-]{36})/i);
    return m ? m[1] : location.pathname;
  }

  function tracksFromMaster(text, masterUrl) {
    const seen = new Set();
    const tracks = [];
    for (const t of HlsUtils.parseSubtitleTracks(text, masterUrl)) {
      const source = t.forced ? "forced" : t.accessibility || /\[CC\]|\bSDH\b/i.test(t.name) ? "sdh" : "primary";
      const id = `${t.language}|${source}`;
      if (seen.has(id)) continue;
      seen.add(id);
      tracks.push({ id, platform: PLATFORM, language: t.language, label: t.name, source, url: t.url, kind: "hls" });
    }
    return tracks;
  }

  function publishTracks(text, masterUrl) {
    if (!text.includes("#EXTM3U") || !HlsUtils.isMasterPlaylist(text)) return;
    lastMaster = masterUrl;
    lastTracks = tracksFromMaster(text, masterUrl);
    SD.log("Disney+ master playlist parsed", lastTracks.length, "subtitle tracks");
    SD.post("TRACKS", { platform: PLATFORM, videoId: videoIdFromUrl(), tracks: lastTracks });
  }

  async function handleMaster(masterUrl) {
    try {
      const res = await fetch(masterUrl);
      if (!res.ok) return;
      publishTracks(await res.text(), masterUrl);
    } catch (err) {
      SD.log("마스터 플레이리스트 처리 실패", err);
    }
  }

  function publishInfo(pe) {
    const title = pe.title;
    const internal = pe.internalTitle || "";
    const subtitle = pe.subtitle || "";
    const m = internal.match(/s(\d+)e(\d+)/i) || subtitle.match(/[A-Za-z](\d+)\D+(\d+)/);
    const info = {
      platform: PLATFORM,
      videoId: videoIdFromUrl(),
      title,
      isSeries: !!m,
      season: m ? parseInt(m[1], 10) : undefined,
      episode: m ? parseInt(m[2], 10) : undefined,
    };
    if (m) {
      const epTitle = subtitle.replace(/^[^:]*\d+\D+\d+\s*[:\-·]?\s*/, "").trim();
      if (epTitle && epTitle !== subtitle) info.episodeTitle = epTitle;
    }
    lastInfo = info;
    SD.post("VIDEO_INFO", info);
  }

  // 응답 JSON 객체 검사 (감지 경로에 무관하게 공용)
  function inspect(obj) {
    if (!obj || typeof obj !== "object") return;
    const master = obj.stream && obj.stream.sources && obj.stream.sources[0] && obj.stream.sources[0].complete
      ? obj.stream.sources[0].complete.url
      : null;
    if (typeof master === "string" && master !== lastMaster) {
      lastMaster = master;
      SD.log("Disney+ master playlist URL detected");
      setTimeout(() => handleMaster(master), 0);
    }
    const pe = obj.data && obj.data.playerExperience;
    if (pe && typeof pe.title === "string") setTimeout(() => publishInfo(pe), 0);
  }

  SD.hookJsonParse(inspect);
  SD.hookResponseJson(inspect);

  const INTEREST_RE = /bamgrid\.com|\/playback\/|\/explore\//i;
  SD.hookFetch((url, res) => {
    if (/\.m3u8(\?|$)/i.test(url)) {
      res.clone().text().then((text) => {
        if (HlsUtils.isMasterPlaylist(text) && url !== lastMaster) publishTracks(text, url);
      }).catch(() => {});
      return;
    }
    if (!INTEREST_RE.test(url)) return;
    res.clone().text().then((text) => {
      try {
        inspect(JSON.parse(text));
      } catch {
        // JSON이 아닌 응답은 무시
      }
    }).catch(() => {});
  });

  SD.hookXhr((url, xhr) => {
    if (!INTEREST_RE.test(url)) return;
    const text = SD.xhrText(xhr);
    if (!text) return;
    try {
      inspect(JSON.parse(text));
    } catch {
      // JSON이 아닌 응답은 무시
    }
  });

  SD.onRequest((type) => {
    if (type !== "REQUEST_TRACKS") return;
    if (lastInfo) SD.post("VIDEO_INFO", { ...lastInfo, videoId: videoIdFromUrl() });
    if (lastTracks) SD.post("TRACKS", { platform: PLATFORM, videoId: videoIdFromUrl(), tracks: lastTracks });
    else if (lastMaster) handleMaster(lastMaster);
  });

  SD.log("Disney+ injector ready");
})();
