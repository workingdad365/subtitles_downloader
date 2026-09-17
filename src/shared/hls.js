// HLS(m3u8) 플레이리스트 파서
// 마스터 플레이리스트의 자막 트랙 추출과 미디어 플레이리스트의 세그먼트 목록 추출을 담당함
var HlsUtils = (() => {
  "use strict";

  function resolveUrl(baseUrl, ref) {
    try {
      return new URL(ref, baseUrl).toString();
    } catch {
      return ref;
    }
  }

  // KEY=VALUE,KEY="V,V" 형태의 속성 목록 파싱
  function parseAttributeList(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    }
    return out;
  }

  function isMasterPlaylist(text) {
    return /#EXT-X-STREAM-INF|#EXT-X-MEDIA:/.test(String(text));
  }

  // #EXT-X-MEDIA 중 TYPE=SUBTITLES / CLOSED-CAPTIONS 항목 추출
  function parseSubtitleTracks(text, baseUrl) {
    const tracks = [];
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("#EXT-X-MEDIA:")) continue;
      const attrs = parseAttributeList(line.substring("#EXT-X-MEDIA:".length));
      if (attrs.TYPE !== "SUBTITLES" && attrs.TYPE !== "CLOSED-CAPTIONS") continue;
      if (!attrs.URI) continue;
      const characteristics = attrs.CHARACTERISTICS || "";
      tracks.push({
        language: (attrs.LANGUAGE || "und").toLowerCase(),
        name: (attrs.NAME || attrs.LANGUAGE || "Unknown").replace(/\s*\(forced\)\s*$/i, "").trim(),
        url: resolveUrl(baseUrl, attrs.URI),
        forced: attrs.FORCED === "YES",
        accessibility: characteristics.includes("public.accessibility"),
        groupId: attrs["GROUP-ID"] || null,
        pathwayId: attrs["PATHWAY-ID"] || null,
        characteristics,
        isDefault: attrs.DEFAULT === "YES",
      });
    }
    return tracks;
  }

  // 세그먼트 목록 추출: #EXT-X-DISCONTINUITY 기준으로 블록을 나눔
  function parseMediaSegments(text, baseUrl) {
    const blocks = [];
    let current = { segments: [], durationMs: 0 };
    let pendingDurationMs = 0;
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line === "#EXT-X-DISCONTINUITY") {
        if (current.segments.length > 0) blocks.push(current);
        current = { segments: [], durationMs: 0 };
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        const m = line.match(/^#EXTINF:([\d.]+)/);
        pendingDurationMs = m ? Math.round(parseFloat(m[1]) * 1000) : 0;
        continue;
      }
      if (line.startsWith("#")) continue;
      current.segments.push({ url: resolveUrl(baseUrl, line), durationMs: pendingDurationMs });
      current.durationMs += pendingDurationMs;
      pendingDurationMs = 0;
    }
    if (current.segments.length > 0) blocks.push(current);
    return { blocks, segments: blocks.flatMap((b) => b.segments) };
  }

  // #EXT-X-SESSION-DATA 항목을 DATA-ID → VALUE 맵으로 추출
  function parseSessionData(text) {
    const out = {};
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("#EXT-X-SESSION-DATA:")) continue;
      const attrs = parseAttributeList(line.substring("#EXT-X-SESSION-DATA:".length));
      if (attrs["DATA-ID"] && attrs.VALUE !== undefined) out[attrs["DATA-ID"]] = attrs.VALUE;
    }
    return out;
  }

  return { resolveUrl, parseAttributeList, isMasterPlaylist, parseSubtitleTracks, parseMediaSegments, parseSessionData };
})();

if (typeof module !== "undefined" && module.exports) module.exports = HlsUtils;
