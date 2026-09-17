// 저장 파일명 생성 유틸리티
// 규칙: "<제목>.<확장자>", 시리즈는 "<제목> S01E02.<확장자>"
var FilenameUtils = (() => {
  "use strict";

  // 페이지 제목에 붙는 서비스 접미사 제거 (예: "서브스턴스 | 디즈니+", "제목 - YouTube")
  const SITE_SUFFIX_RE = /\s*[|\-–—]\s*(Disney\+|디즈니\+|Netflix|넷플릭스|YouTube|유튜브|Prime Video|프라임 비디오|Apple TV\+?|HBO Max|Max)\s*$/i;

  function cleanTitle(text) {
    return String(text || "").replace(SITE_SUFFIX_RE, "").trim();
  }

  // 파일 시스템에서 허용되지 않는 문자 제거 후 공백 정리
  function sanitize(text) {
    return String(text || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/[⁦-⁩]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+|[. ]+$/g, "");
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function episodeTag(season, episode) {
    let tag = "";
    if (season != null && Number.isFinite(Number(season))) tag += `S${pad2(season)}`;
    if (episode != null && Number.isFinite(Number(episode))) tag += `E${pad2(episode)}`;
    return tag;
  }

  // 예: "서브스턴스.srt", "쇼 제목 S01E02.srt"
  function buildFilename({ title, seriesTitle, season, episode, ext }) {
    const base = sanitize(cleanTitle(seriesTitle || title)) || "subtitle";
    const tag = episodeTag(season, episode);
    const name = tag ? `${base} ${tag}` : base;
    return `${name}.${ext || "srt"}`;
  }

  return { cleanTitle, sanitize, buildFilename };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FilenameUtils;
