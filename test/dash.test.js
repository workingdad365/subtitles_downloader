// DASH 파서 테스트
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/shared/dash.js");

test("parseIsoDuration", () => {
  assert.equal(D.parseIsoDuration("PT1H2M3.5S"), 3723.5);
  assert.equal(D.parseIsoDuration("PT30S"), 30);
  assert.equal(D.parseIsoDuration("bad"), 0);
});

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1M">
  <BaseURL>https://cdn.example.com/content/</BaseURL>
  <Period id="ad" start="PT0S" duration="PT10S">
    <AdaptationSet contentType="audio" lang="en"><Representation id="a1"/></AdaptationSet>
  </Period>
  <Period id="main1" start="PT10S" duration="PT30S">
    <BaseURL>main1/</BaseURL>
    <AdaptationSet contentType="audio" lang="en"><Representation id="a1"/></AdaptationSet>
    <AdaptationSet contentType="audio" lang="ko"><Representation id="a2"/></AdaptationSet>
    <AdaptationSet contentType="text" lang="ko" mimeType="text/vtt">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
      <SegmentTemplate media="sub_ko_$Number$.vtt" startNumber="1" timescale="1000">
        <SegmentTimeline><S t="0" d="10000" r="2"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="t_ko" bandwidth="100"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" lang="en" mimeType="application/ttml+xml">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="caption"/>
      <Representation id="t_en" bandwidth="100"><BaseURL>en_full.ttml</BaseURL></Representation>
    </AdaptationSet>
  </Period>
  <Period id="main2" start="PT40S" duration="PT20S">
    <BaseURL>main2/</BaseURL>
    <AdaptationSet contentType="audio" lang="en"><Representation id="a1"/></AdaptationSet>
    <AdaptationSet contentType="audio" lang="ko"><Representation id="a2"/></AdaptationSet>
    <AdaptationSet contentType="text" lang="ko" mimeType="text/vtt">
      <SegmentTemplate media="sub_ko_$Number%03d$.vtt" startNumber="1" duration="10000" timescale="1000"/>
      <Representation id="t_ko" bandwidth="100"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" lang="en" mimeType="application/ttml+xml">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="caption"/>
      <Representation id="t_en" bandwidth="100"><BaseURL>en_full.ttml</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test("parseTextTracks: 광고 Period 제외, 언어별 병합, 오프셋/템플릿 처리", () => {
  const tracks = D.parseTextTracks(MPD, "https://origin.example.com/manifest.mpd");
  assert.equal(tracks.length, 2);
  const ko = tracks.find((t) => t.language === "ko");
  const en = tracks.find((t) => t.language === "en");
  assert.equal(ko.kind, "vtt");
  assert.equal(ko.source, "primary");
  assert.equal(ko.segments.length, 5);
  assert.equal(ko.segments[0].url, "https://cdn.example.com/content/main1/sub_ko_1.vtt");
  assert.equal(ko.segments[0].offsetMs, 0);
  assert.equal(ko.segments[3].url, "https://cdn.example.com/content/main2/sub_ko_001.vtt");
  assert.equal(ko.segments[3].offsetMs, 30000);
  assert.equal(en.kind, "ttml");
  assert.equal(en.source, "sdh");
  assert.equal(en.segments.length, 2);
  assert.equal(en.segments[0].url, "https://cdn.example.com/content/main1/en_full.ttml");
});

test("parseTextTracks: 단일 Period 및 SegmentList", () => {
  const mpd = `<MPD><Period><AdaptationSet mimeType="text/vtt" lang="fr"><Representation id="r"><SegmentList><SegmentURL media="a.vtt"/><SegmentURL media="b.vtt"/></SegmentList></Representation></AdaptationSet></Period></MPD>`;
  const tracks = D.parseTextTracks(mpd, "https://x.example.com/dir/m.mpd");
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0].segments.map((s) => s.url), ["https://x.example.com/dir/a.vtt", "https://x.example.com/dir/b.vtt"]);
});
