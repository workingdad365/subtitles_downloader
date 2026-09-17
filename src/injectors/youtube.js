// YouTube 인젝터
// InnerTube player API(ANDROID 클라이언트)로 자막 트랙 목록을 조회하고 timedtext URL을 전달함
(() => {
  "use strict";
  const SD = window.__subtitlesDownloader__;
  if (!SD) return;

  const PLATFORM = "youtube";
  let playerResponse = window.ytInitialPlayerResponse || null;
  let lastPublishedId = null;

  function videoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      if (u.pathname === "/watch") return u.searchParams.get("v");
    } catch {
      // URL 파싱 실패 시 null
    }
    return null;
  }

  // InnerTube ANDROID 클라이언트로 조회하면 pot 토큰 없이 timedtext URL 사용 가능
  async function fetchInnertube(videoId) {
    const key = window.ytcfg && typeof window.ytcfg.get === "function" ? window.ytcfg.get("INNERTUBE_API_KEY") : null;
    if (!key) return null;
    const res = await fetch(`${location.origin}/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: window.ytcfg.get("HL") || "en" } },
        videoId,
      }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  function captionRenderer(pr) {
    return pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer ? pr.captions.playerCaptionsTracklistRenderer : null;
  }

  function labelOf(ct) {
    if (!ct.name) return ct.languageCode || "";
    if (ct.name.simpleText) return ct.name.simpleText;
    if (Array.isArray(ct.name.runs)) return ct.name.runs.map((r) => r.text).join("");
    return ct.languageCode || "";
  }

  function buildTracks(captionTracks) {
    return captionTracks.map((ct) => {
      const base = ct.baseUrl.startsWith("/") ? location.origin + ct.baseUrl : ct.baseUrl;
      const u = new URL(base);
      u.searchParams.set("fmt", "json3");
      const language = String(ct.languageCode || "und").toLowerCase();
      const isAuto = ct.kind === "asr";
      return {
        id: `${language}|${isAuto ? "auto" : "primary"}|${ct.vssId || ""}`,
        platform: PLATFORM,
        language,
        label: labelOf(ct),
        source: isAuto ? "auto" : "primary",
        url: u.toString(),
        format: "json3",
        translatable: ct.isTranslatable !== false,
      };
    });
  }

  async function publish(pr, forceId) {
    const videoId = forceId || (pr && pr.videoDetails && pr.videoDetails.videoId) || videoIdFromUrl();
    if (!videoId) return;
    let details = pr && pr.videoDetails && pr.videoDetails.videoId === videoId ? pr.videoDetails : null;
    let renderer = pr && pr.videoDetails && pr.videoDetails.videoId === videoId ? captionRenderer(pr) : null;
    try {
      const json = await fetchInnertube(videoId);
      if (json) {
        if (captionRenderer(json)) renderer = captionRenderer(json);
        if (!details && json.videoDetails) details = json.videoDetails;
      }
    } catch (err) {
      SD.log("InnerTube 조회 실패", err);
    }
    SD.post("VIDEO_INFO", {
      platform: PLATFORM,
      videoId,
      title: (details && details.title) || document.title.replace(/\s*-\s*YouTube$/, ""),
      author: details ? details.author : undefined,
      isSeries: false,
    });
    const captionTracks = renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];
    const translationLanguages = renderer && Array.isArray(renderer.translationLanguages)
      ? renderer.translationLanguages.map((t) => ({
        code: t.languageCode,
        name: t.languageName && (t.languageName.simpleText || (t.languageName.runs || []).map((r) => r.text).join("")) || t.languageCode,
      }))
      : [];
    SD.post("TRACKS", { platform: PLATFORM, videoId, tracks: buildTracks(captionTracks), translationLanguages });
    lastPublishedId = videoId;
  }

  document.addEventListener("yt-navigate-finish", (ev) => {
    const pr = ev && ev.detail && ev.detail.response ? ev.detail.response.playerResponse : null;
    if (pr && pr.videoDetails && pr.videoDetails.videoId) {
      playerResponse = pr;
      publish(pr);
      return;
    }
    const vid = videoIdFromUrl();
    if (vid && vid !== lastPublishedId) publish(null, vid);
  });

  SD.onRequest((type) => {
    if (type !== "REQUEST_TRACKS") return;
    const vid = videoIdFromUrl();
    if (vid) publish(playerResponse, vid);
  });

  if (videoIdFromUrl()) publish(playerResponse);
})();
