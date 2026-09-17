// Apple TV+ 인젝터
// fetch 후킹으로 마스터 플레이리스트(play-edge.itunes.apple.com)의 자막 트랙과
// play-metadata 응답의 canonicalId를 수집함. 제목은 세션 데이터 및 플레이어 DOM에서 보완함
(() => {
  "use strict";
  const SD = window.__subtitlesDownloader__;
  if (!SD || typeof HlsUtils === "undefined") return;

  const PLATFORM = "appletv";
  const MASTER_RE = /play-edge\.itunes\.apple\.com\/(?!.*\/stream\/).*\/playlist\.m3u8/;
  const PLAYMETA_RE = /\/api\/uts\/v\d+\/contents\/play-metadata\/(vod|episode)/;

  const state = { videoId: null, isSeries: false, title: null, episodeTitle: null, season: null, episode: null, tracks: null, lastMaster: null };

  function domMeta() {
    const out = { title: null, episodeTitle: null, season: null, episode: null };
    try {
      const t = document.querySelector("[data-testid=\"player-metadata-title\"]");
      const s = document.querySelector("[data-testid=\"player-metadata-subtitle\"] .subtitle-text");
      out.title = t && t.textContent ? t.textContent.trim() : null;
      const sub = s && s.textContent ? s.textContent.trim() : "";
      const m = sub.match(/^\D*?(\d+)\D+?(\d+)(?:[\s·•・]+(.+))?$/u);
      if (m) {
        out.season = parseInt(m[1], 10);
        out.episode = parseInt(m[2], 10);
        out.episodeTitle = m[3] ? m[3].trim() : null;
      }
    } catch {
      // DOM 미준비 시 기본값
    }
    return out;
  }

  function publish() {
    const dm = domMeta();
    const videoId = state.videoId || location.pathname;
    SD.post("VIDEO_INFO", {
      platform: PLATFORM,
      videoId,
      title: state.title || dm.title || document.title.replace(/\s*[-|]\s*Apple TV\+?\s*$/i, ""),
      episodeTitle: state.episodeTitle || dm.episodeTitle || undefined,
      isSeries: state.isSeries || dm.season != null,
      season: state.season != null ? state.season : dm.season != null ? dm.season : undefined,
      episode: state.episode != null ? state.episode : dm.episode != null ? dm.episode : undefined,
    });
    if (state.tracks) SD.post("TRACKS", { platform: PLATFORM, videoId, tracks: state.tracks });
  }

  async function handleMaster(url, res) {
    const text = await res.text();
    if (!text.includes("#EXTM3U") || !HlsUtils.isMasterPlaylist(text)) return;
    const seen = new Set();
    const tracks = [];
    for (const t of HlsUtils.parseSubtitleTracks(text, url)) {
      if (t.pathwayId && !t.pathwayId.toLowerCase().startsWith("ap")) continue;
      const source = t.forced ? "forced" : t.accessibility ? "sdh" : "primary";
      const id = `${t.language}|${source}`;
      if (seen.has(id)) continue;
      seen.add(id);
      tracks.push({ id, platform: PLATFORM, language: t.language, label: t.name, source, url: t.url, kind: "hls-appletv" });
    }
    const session = HlsUtils.parseSessionData(text);
    if (session["com.apple.hls.title"]) state.title = session["com.apple.hls.title"];
    if (session["com.apple.hls.episode-title"]) state.episodeTitle = session["com.apple.hls.episode-title"];
    const ep = (session["com.apple.hls.episode-id"] || "").match(/S(\d+)E(\d+)/i);
    if (ep) {
      state.season = parseInt(ep[1], 10);
      state.episode = parseInt(ep[2], 10);
      state.isSeries = true;
    }
    state.tracks = tracks;
    state.lastMaster = url;
    publish();
  }

  async function handlePlayMeta(res) {
    const text = await res.text();
    const id = text.match(/"canonicalId"\s*:\s*"([^"]+)"/);
    if (id && id[1] !== state.videoId) {
      state.videoId = id[1];
      const type = text.match(/"type"\s*:\s*"(Episode|Movie)"/);
      state.isSeries = !!type && type[1] === "Episode";
      // 새 콘텐츠로 전환되면 이전 트랙/제목 정보 초기화
      state.tracks = null;
      state.title = null;
      state.episodeTitle = null;
      state.season = null;
      state.episode = null;
    }
    await SD.sleep(300);
    publish();
  }

  SD.hookFetch((url, res) => {
    if (MASTER_RE.test(url)) handleMaster(url, res.clone()).catch((err) => SD.log("master 처리 실패", err));
    else if (PLAYMETA_RE.test(url)) handlePlayMeta(res.clone()).catch((err) => SD.log("play-metadata 처리 실패", err));
  });

  SD.onRequest((type) => {
    if (type === "REQUEST_TRACKS") publish();
  });
})();
