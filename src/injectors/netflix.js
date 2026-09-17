// Netflix 인젝터
// JSON.parse 후킹으로 manifest 응답의 timedtexttracks(ttDownloadables) URL을 수집하고,
// 플레이어 API(getTimedTextTrackList)로 트랙 목록을 구성함. URL이 없는 트랙은 활성화 후 폴링하여 확보함
(() => {
  "use strict";
  const SD = window.__subtitlesDownloader__;
  if (!SD) return;

  const PLATFORM = "netflix";
  const PROFILE_PREF = ["webvtt-lssdh-ios8", "dfxp-ls-sdh", "simplesdh", "imsc1.1"];
  const PROFILE_FORMAT = { "webvtt-lssdh-ios8": "vtt", "dfxp-ls-sdh": "ttml", simplesdh: "ttml", "imsc1.1": "ttml" };

  const urlCache = {};
  let currentVideoId = null;
  let detectTimer = null;
  // 최근 활성화한 트랙 (백그라운드가 관찰한 자막 요청 URL을 트랙에 연결할 때 사용)
  const activation = { trackKey: null, at: 0 };

  function trackKeyOf(t) {
    const lang = String(t.bcp47 || t.language || "").toLowerCase();
    const raw = String(t.rawTrackType || "").toLowerCase();
    const forced = t.isForcedNarrative ? "forced" : "";
    return `${lang}|${raw}|${forced}`;
  }

  function sourceOf(t) {
    if (t.isForcedNarrative) return "forced";
    if (String(t.rawTrackType || "").toLowerCase() === "closedcaptions") return t.trackType === "ASSISTIVE" ? "sdh" : "cc";
    return "primary";
  }

  // manifest 응답에서 다운로드 URL 수집
  function processTimedTextTracks(result) {
    const movieId = String(result.movieId);
    const store = urlCache[movieId] || (urlCache[movieId] = {});
    let added = 0;
    for (const t of result.timedtexttracks || []) {
      if (t.isNoneTrack || !t.ttDownloadables) continue;
      const key = trackKeyOf(t);
      if (store[key]) continue;
      for (const profile of PROFILE_PREF) {
        const dl = t.ttDownloadables[profile];
        if (!dl) continue;
        const urls = dl.downloadUrls ? Object.values(dl.downloadUrls) : (dl.urls || []).map((u) => u.url);
        if (!urls.length) continue;
        store[key] = { url: urls[0], format: PROFILE_FORMAT[profile] };
        added++;
        break;
      }
    }
    if (added > 0 && movieId === currentVideoId) publishTracks(movieId);
  }

  // 캐시 조회: 정확한 키 → 구성 요소 일부 생략 키 → 같은 언어/강제 여부의 항목 순으로 탐색
  function findCached(movieId, trackKey, preferCc) {
    const store = urlCache[movieId];
    if (!store) return null;
    if (store[trackKey]) return store[trackKey];
    const [lang, raw, forced] = trackKey.split("|");
    const candidates = [`${lang}|${raw}|${forced}`, `${lang}||${forced}`, `${lang}|${raw}|`, `${lang}||`];
    for (const c of candidates) if (store[c]) return store[c];
    const keys = Object.keys(store).filter((k) => k.startsWith(`${lang}|`) && k.endsWith(`|${forced}`));
    if (!keys.length) return null;
    keys.sort((a, b) => {
      const ac = a.includes("closedcaptions") ? 1 : 0;
      const bc = b.includes("closedcaptions") ? 1 : 0;
      return preferCc ? bc - ac : ac - bc;
    });
    return store[keys[0]];
  }

  function getPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds() || [];
      const sid = ids.find((s) => s.includes("watch")) || ids[ids.length - 1];
      return sid ? vp.getVideoPlayerBySessionId(sid) : null;
    } catch {
      return null;
    }
  }

  function publishTracks(movieId) {
    const player = getPlayer();
    if (!player) return false;
    let list;
    try {
      list = player.getTimedTextTrackList() || [];
    } catch {
      return false;
    }
    const seen = new Set();
    const tracks = [];
    for (const t of list) {
      if (t.isNoneTrack || !(t.bcp47 || t.language)) continue;
      const key = trackKeyOf(t);
      if (seen.has(key)) continue;
      seen.add(key);
      const cached = findCached(movieId, key, t.trackType === "ASSISTIVE");
      tracks.push({
        id: key,
        platform: PLATFORM,
        language: String(t.bcp47 || t.language).toLowerCase(),
        label: t.displayName || t.bcp47 || t.language,
        source: sourceOf(t),
        url: cached ? cached.url : null,
        format: cached ? cached.format : null,
        trackKey: key,
      });
    }
    SD.post("TRACKS", { platform: PLATFORM, videoId: movieId, tracks });
    return tracks.length > 0;
  }

  function publishVideoInfo(movieId) {
    const info = { platform: PLATFORM, videoId: movieId, title: null, isSeries: false };
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI();
      const video = api.getVideoMetadataByVideoId(movieId).getCurrentVideo();
      if (video) {
        info.title = video.getTitle ? video.getTitle() : null;
        info.isSeries = typeof video.isEpisodic === "function" && video.isEpisodic() === true;
        if (info.isSeries) {
          const season = video.getSeason && video.getSeason();
          const seq = season && season._season ? season._season.seq : undefined;
          info.season = seq !== undefined ? parseInt(String(seq), 10) : undefined;
          const ep = video.getEpisodeNumber && video.getEpisodeNumber();
          info.episode = ep !== undefined ? parseInt(String(ep), 10) : undefined;
          info.episodeTitle = video.getEpisodeTitle ? video.getEpisodeTitle() : undefined;
        }
      }
    } catch {
      // 메타데이터 API 미준비 시 기본값 사용
    }
    if (!info.title) info.title = `Netflix_${movieId}`;
    SD.post("VIDEO_INFO", info);
    return info;
  }

  async function onVideoDetected(movieId) {
    currentVideoId = movieId;
    // 플레이어와 메타데이터 API 준비 대기
    for (let i = 0; i < 20; i++) {
      await SD.sleep(500);
      if (currentVideoId !== movieId) return;
      const info = publishVideoInfo(movieId);
      const ok = publishTracks(movieId);
      if (ok && !info.title.startsWith("Netflix_")) break;
    }
  }

  // 트랙 활성화 후 manifest 갱신을 폴링하여 URL 확보
  async function resolveUrl(movieId, trackKey) {
    const player = getPlayer();
    if (!player) return null;
    const list = player.getTimedTextTrackList() || [];
    const target = list.find((t) => trackKeyOf(t) === trackKey);
    const preferCc = !!target && target.trackType === "ASSISTIVE";
    const cached = findCached(movieId, trackKey, preferCc);
    if (cached) return cached;
    if (!target) {
      SD.log("플레이어 트랙 목록에서 키를 찾지 못함", trackKey, list.map(trackKeyOf));
      return null;
    }
    let previous = null;
    try {
      previous = player.getTimedTextTrack();
    } catch {
      previous = null;
    }
    activation.trackKey = trackKey;
    activation.at = Date.now();
    let activated = false;
    for (let attempt = 0; attempt < 3 && !activated; attempt++) {
      try {
        await player.setTimedTextTrack(target);
        activated = true;
      } catch (err) {
        SD.log("setTimedTextTrack 실패, 재시도", err);
        await SD.sleep(200 * (attempt + 1));
      }
    }
    if (!activated) return null;
    let result = null;
    for (let i = 0; i < 40; i++) {
      await SD.sleep(100);
      result = findCached(movieId, trackKey, preferCc);
      if (result) break;
    }
    if (!result) {
      const store = urlCache[movieId];
      SD.log("manifest 캐시에서 URL 미발견", trackKey, store ? Object.keys(store) : "(캐시 없음)");
    }
    try {
      if (previous && previous !== target) player.setTimedTextTrack(previous);
    } catch {
      // 이전 트랙 복원 실패는 무시
    }
    return result || null;
  }

  // 백그라운드가 관찰한 자막 요청을 어느 트랙에 연결할지 판단: 최근 활성화 트랙 우선, 없으면 현재 활성 트랙
  function activeTrackKey() {
    if (activation.trackKey && Date.now() - activation.at < 15000) return activation.trackKey;
    try {
      const player = getPlayer();
      const t = player && player.getTimedTextTrack();
      if (t && !t.isNoneTrack && (t.bcp47 || t.language)) return trackKeyOf(t);
    } catch {
      // 플레이어 미준비
    }
    return null;
  }

  SD.hookJsonParse((obj) => {
    const r = obj && obj.result;
    if (r && r.timedtexttracks && r.movieId) processTimedTextTracks(r);
  });

  // manifest 요청에 모든 자막 프로필과 전체 트랙 노출 옵션 추가
  const originalStringify = JSON.stringify;
  JSON.stringify = function patchedStringify(value, ...rest) {
    try {
      if (value && typeof value.url === "string" && /manifest|licensedManifest/.test(value.url)) {
        for (const v of Object.values(value)) {
          if (!v || typeof v !== "object") continue;
          if (Array.isArray(v.profiles)) {
            for (const p of PROFILE_PREF) if (!v.profiles.includes(p)) v.profiles.unshift(p);
          }
          if (v.showAllSubDubTracks != null) v.showAllSubDubTracks = true;
        }
      }
    } catch {
      // 요청 본문 수정 실패는 무시
    }
    return originalStringify.call(this, value, ...rest);
  };

  function onMetadataUrl(url) {
    const m = String(url).match(/movieid=(\d+)/);
    if (!m) return;
    if (m[1] === currentVideoId) return;
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => onVideoDetected(m[1]), 300);
  }

  SD.hookFetch((url) => {
    if (url.includes("/metadata") && url.includes("movieid=")) onMetadataUrl(url);
  });
  SD.hookXhr((url) => {
    if (url.includes("/metadata") && url.includes("movieid=")) onMetadataUrl(url);
  });

  SD.onRequest(async (type, payload, requestId) => {
    if (type === "REQUEST_TRACKS") {
      let id = currentVideoId;
      if (!id) {
        const player = getPlayer();
        try {
          id = player ? String(player.getMovieId()) : null;
        } catch {
          id = null;
        }
      }
      if (!id) {
        const m = location.pathname.match(/\/watch\/(\d+)/);
        id = m ? m[1] : null;
      }
      if (id) {
        currentVideoId = id;
        publishVideoInfo(id);
        publishTracks(id);
      }
      return;
    }
    if (type === "NETFLIX_RESOLVE_URL") {
      const result = await resolveUrl(String(payload.videoId), payload.trackKey);
      SD.reply(requestId, "NETFLIX_URL", result);
      return;
    }
    if (type === "NETFLIX_ACTIVE_TRACK") {
      SD.reply(requestId, "NETFLIX_ACTIVE_TRACK", { trackKey: activeTrackKey() });
    }
  });

  const initial = location.pathname.match(/\/watch\/(\d+)/);
  if (initial) {
    setTimeout(() => {
      if (!currentVideoId) onVideoDetected(initial[1]);
    }, 1500);
  }
})();
