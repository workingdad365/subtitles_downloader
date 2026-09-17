// 파일명 생성 및 플랫폼 판별 테스트
const test = require("node:test");
const assert = require("node:assert/strict");
const Fn = require("../src/shared/filename.js");
const P = require("../src/shared/platforms.js");

test("sanitize: 금지 문자 제거와 공백 정리", () => {
  assert.equal(Fn.sanitize("  A: B/C? *D*  "), "A BC D");
  assert.equal(Fn.sanitize("...trailing..."), "trailing");
});

test("cleanTitle: 서비스 접미사 제거", () => {
  assert.equal(Fn.cleanTitle("서브스턴스 | 디즈니+"), "서브스턴스");
  assert.equal(Fn.cleanTitle("Some Video - YouTube"), "Some Video");
  assert.equal(Fn.cleanTitle("Plain Title"), "Plain Title");
});

test("buildFilename: 제목만 사용, 시리즈는 SxxExx 추가", () => {
  assert.equal(Fn.buildFilename({ title: "서브스턴스 | 디즈니+", ext: "srt" }), "서브스턴스.srt");
  assert.equal(Fn.buildFilename({ seriesTitle: "Show Name", season: 1, episode: 2, ext: "srt" }), "Show Name S01E02.srt");
  assert.equal(Fn.buildFilename({ title: "Movie", ext: "vtt" }), "Movie.vtt");
  assert.equal(Fn.buildFilename({ ext: "" }), "subtitle.srt");
});

test("Platforms.detect", () => {
  assert.equal(P.detect("https://www.youtube.com/watch?v=abc"), "youtube");
  assert.equal(P.detect("https://www.netflix.com/watch/1234"), "netflix");
  assert.equal(P.detect("https://www.disneyplus.com/play/xyz"), "disneyplus");
  assert.equal(P.detect("https://example.com/"), null);
});

test("Platforms.detect: 비활성 플랫폼(Prime Video, Apple TV+, HBO Max)은 감지하지 않음", () => {
  assert.equal(P.detect("https://www.primevideo.com/detail/abc"), null);
  assert.equal(P.detect("https://www.amazon.com/gp/video/detail/abc"), null);
  assert.equal(P.detect("https://tv.apple.com/kr/show/x"), null);
  assert.equal(P.detect("https://play.hbomax.com/video/watch/a/b"), null);
  assert.deepEqual(P.ENABLED.map((p) => p.id), ["youtube", "netflix", "disneyplus"]);
});

test("Platforms.isNativeHost", () => {
  assert.equal(P.isNativeHost("ipv6-c001.nflxvideo.net"), true);
  assert.equal(P.isNativeHost("www.disneyplus.com"), true);
  assert.equal(P.isNativeHost("cdn.example.com"), false);
  assert.equal(P.isNativeHost("www.primevideo.com"), false);
  assert.equal(P.isNativeHost("play.max.com"), false);
});
