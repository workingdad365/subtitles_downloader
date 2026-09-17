// HLS 파서 테스트
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../src/shared/hls.js");

const MASTER = [
  "#EXTM3U",
  "#EXT-X-SESSION-DATA:DATA-ID=\"com.apple.hls.title\",VALUE=\"쇼 제목\"",
  "#EXT-X-SESSION-DATA:DATA-ID=\"com.apple.hls.episode-id\",VALUE=\"S02E03\"",
  "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",LANGUAGE=\"en\",NAME=\"English\",URI=\"audio/en.m3u8\"",
  "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"sub\",LANGUAGE=\"ko\",NAME=\"한국어\",DEFAULT=NO,URI=\"subs/ko/prog.m3u8\"",
  "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"sub\",LANGUAGE=\"en\",NAME=\"English (forced)\",FORCED=YES,URI=\"subs/en_f/prog.m3u8\"",
  "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"sub\",LANGUAGE=\"en\",NAME=\"English CC\",CHARACTERISTICS=\"public.accessibility.describes-music-and-sound\",PATHWAY-ID=\"AP1\",URI=\"https://cdn.example.com/en_cc.m3u8\"",
  "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"sub\",LANGUAGE=\"ja\",NAME=\"No URI\"",
  "#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES=\"sub\"",
  "video/1000.m3u8",
].join("\n");

test("isMasterPlaylist 판별", () => {
  assert.equal(H.isMasterPlaylist(MASTER), true);
  assert.equal(H.isMasterPlaylist("#EXTM3U\n#EXTINF:4.0,\nseg0.vtt"), false);
});

test("parseSubtitleTracks: 자막 트랙 추출 및 URL 해석", () => {
  const tracks = H.parseSubtitleTracks(MASTER, "https://host.example.com/path/master.m3u8?x=1");
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].language, "ko");
  assert.equal(tracks[0].url, "https://host.example.com/path/subs/ko/prog.m3u8");
  assert.equal(tracks[1].forced, true);
  assert.equal(tracks[1].name, "English");
  assert.equal(tracks[2].accessibility, true);
  assert.equal(tracks[2].pathwayId, "AP1");
  assert.equal(tracks[2].url, "https://cdn.example.com/en_cc.m3u8");
});

test("parseSessionData: 세션 데이터 추출", () => {
  const data = H.parseSessionData(MASTER);
  assert.equal(data["com.apple.hls.title"], "쇼 제목");
  assert.equal(data["com.apple.hls.episode-id"], "S02E03");
});

test("parseMediaSegments: 불연속 블록 분리 및 길이 합산", () => {
  const media = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:6.0,",
    "empty-0.webvtt",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:6.0,",
    "seg-0.webvtt",
    "#EXTINF:4.5,",
    "seg-1.webvtt",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const { blocks, segments } = H.parseMediaSegments(media, "https://cdn.example.com/a/b/prog.m3u8");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].durationMs, 6000);
  assert.equal(blocks[1].durationMs, 10500);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].url, "https://cdn.example.com/a/b/seg-0.webvtt");
});
