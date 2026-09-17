// 자막 포맷 파서/직렬화기 테스트
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/shared/formats.js");

test("parseClockTime: 다양한 시각 표기 처리", () => {
  assert.equal(F.parseClockTime("00:01:02.500"), 62500);
  assert.equal(F.parseClockTime("00:01:02,500"), 62500);
  assert.equal(F.parseClockTime("01:02.250"), 62250);
  assert.equal(F.parseClockTime("5.5"), 5500);
  assert.equal(F.parseClockTime("abc"), null);
});

test("parseTtmlTime: tick, 초, 프레임 표기 처리", () => {
  assert.equal(F.parseTtmlTime("107607500t", { tickRate: 10000000 }), 10761);
  assert.equal(F.parseTtmlTime("1.5s"), 1500);
  assert.equal(F.parseTtmlTime("500ms"), 500);
  assert.equal(F.parseTtmlTime("00:00:01:15", { frameRate: 30 }), 1500);
  assert.equal(F.parseTtmlTime("00:00:05.130"), 5130);
});

test("parseVtt: 헤더/NOTE/식별자 무시, 태그 정리", () => {
  const vtt = [
    "WEBVTT",
    "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000",
    "",
    "NOTE 설명 블록",
    "",
    "1",
    "00:00:01.000 --> 00:00:03.000 line:90% align:center",
    "<c.white>안녕하세요</c> <i>세계</i>",
    "",
    "00:00:04.000 --> 00:00:05.000",
    "<v 화자>두 번째 &amp; 줄</v>",
    "",
  ].join("\n");
  const cues = F.parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1000, end: 3000, text: "안녕하세요 <i>세계</i>" });
  assert.equal(cues[1].text, "두 번째 & 줄");
});

test("parseSrt: 위치 태그 제거 및 다중 줄 유지", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n{\\an8}첫 줄\n둘째 줄\n\n2\n00:00:03,000 --> 00:00:04,000\n<b>굵게</b>\n";
  const cues = F.parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "첫 줄\n둘째 줄");
  assert.equal(cues[1].text, "<b>굵게</b>");
});

test("parseTtml: Netflix DFXP(tick 기반, 다중 region, 스타일 italic) 처리", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
  <head>
    <styling>
      <style xml:id="style0" tts:fontStyle="italic"/>
      <style xml:id="style1" tts:fontWeight="bold"/>
    </styling>
  </head>
  <body>
    <div>
      <p begin="10000000t" end="30000000t" region="bottom"><span style="style0">기울임</span><br/>둘째 줄</p>
      <p begin="10000000t" end="30000000t" region="top">위쪽 자막</p>
      <p begin="40000000t" end="50000000t">일반 &amp; 텍스트</p>
    </div>
  </body>
</tt>`;
  const cues = F.parseTtml(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1000);
  assert.equal(cues[0].end, 3000);
  assert.equal(cues[0].text, "<i>기울임</i>\n둘째 줄\n위쪽 자막");
  assert.equal(cues[1].text, "일반 & 텍스트");
});

test("parseTtml: Prime Video TTML2(clock 기반) 처리", () => {
  const xml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ko"><body><div>
    <p begin="00:00:05.130" end="00:00:07.000">한 줄</p>
    <p begin="00:00:08.000" dur="00:00:02.000">둘째<br/>줄</p>
  </div></body></tt>`;
  const cues = F.parseTtml(xml);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 5130, end: 7000, text: "한 줄" });
  assert.deepEqual(cues[1], { start: 8000, end: 10000, text: "둘째\n줄" });
});

test("parseYoutubeSrv1: 이중 인코딩 엔티티 복원", () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1.5" dur="2">Hello &amp;amp; world\n둘째</text><text start="4" dur="1">   </text></transcript>`;
  const cues = F.parseYoutubeSrv1(xml);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0], { start: 1500, end: 3500, text: "Hello & world\n둘째" });
});

test("parseYoutubeJson3: aAppend 이벤트 제외 및 segs 결합", () => {
  const json = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "안녕 " }, { utf8: "세계" }] },
      { tStartMs: 500, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "\n" }] },
    ],
  });
  const cues = F.parseYoutubeJson3(json);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0], { start: 0, end: 1000, text: "안녕 세계" });
});

test("parseYoutubeSrv3: append 문단 제외", () => {
  const xml = `<timedtext format="3"><body><p t="100" d="900">첫 문장</p><p t="500" d="10" a="1">\n</p><p t="2000" d="1000"><s ac="0">단어</s><s> 둘</s></p></body></timedtext>`;
  const cues = F.parseYoutubeSrv3(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].text, "단어 둘");
});

test("parseSbv / parseAss / parseSami 기본 동작", () => {
  assert.deepEqual(F.parseSbv("0:00:01.000,0:00:02.000\n자막\n\n"), [{ start: 1000, end: 2000, text: "자막" }]);
  const ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}{\\i1}기울임{\\i0}\\N둘째, 쉼표";
  assert.deepEqual(F.parseAss(ass), [{ start: 1000, end: 2500, text: "<i>기울임</i>\n둘째, 쉼표" }]);
  const smi = "<SAMI><BODY><SYNC Start=1000><P Class=KRCC>첫째<br>줄<SYNC Start=2000><P Class=KRCC>&nbsp;<SYNC Start=3000><P>셋째</BODY></SAMI>";
  const cues = F.parseSami(smi);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1000, end: 2000, text: "첫째\n줄" });
});

test("detectFormat: 포맷 판별", () => {
  assert.equal(F.detectFormat("﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx"), "vtt");
  assert.equal(F.detectFormat("1\n00:00:01,000 --> 00:00:02,000\nx"), "srt");
  assert.equal(F.detectFormat("<?xml version=\"1.0\"?><tt xmlns=\"http://www.w3.org/ns/ttml\"><body/></tt>"), "ttml");
  assert.equal(F.detectFormat("<transcript><text start=\"0\" dur=\"1\">x</text></transcript>"), "srv1");
  assert.equal(F.detectFormat("<timedtext format=\"3\"><body/></timedtext>"), "srv3");
  assert.equal(F.detectFormat("{\"wireMagic\":\"pb3\",\"events\":[]}"), "json3");
  assert.equal(F.detectFormat("[Script Info]\n"), "ass");
  assert.equal(F.detectFormat("#EXTM3U\n#EXT-X-VERSION:3"), "m3u8");
  assert.equal(F.detectFormat("<?xml version=\"1.0\"?>\n<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\"></MPD>"), "mpd");
  assert.equal(F.detectFormat("<SAMI><BODY></BODY></SAMI>"), "smi");
  assert.equal(F.detectFormat("0:00:01.000,0:00:02.000\nx"), "sbv");
  assert.equal(F.detectFormat("hello world"), "unknown");
});

test("parse: 잘못된 힌트 시 자동 판별로 재시도", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n자막\n";
  const result = F.parse(srt, "json3");
  assert.equal(result.format, "srt");
  assert.equal(result.cues.length, 1);
});

test("mergeSegments: 중복 큐 제거, 정렬, 오프셋 적용", () => {
  const seg1 = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n";
  const seg2 = "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nB\n\n00:00:05.000 --> 00:00:06.000\nC\n";
  const merged = F.mergeSegments([seg1, seg2]);
  assert.deepEqual(merged.map((c) => c.text), ["A", "B", "C"]);
  const shifted = F.mergeSegments([seg1, seg2], "vtt", [0, 10000]);
  assert.deepEqual(shifted.map((c) => c.start), [1000, 3000, 13000, 15000]);
});

test("직렬화: SRT / VTT / TXT / ASS", () => {
  const cues = [
    { start: 1000, end: 2500, text: "<i>첫째</i>\n둘째" },
    { start: 3661000, end: 3662000, text: "한 시간 뒤" },
  ];
  assert.equal(F.toSrt(cues), "1\n00:00:01,000 --> 00:00:02,500\n<i>첫째</i>\n둘째\n\n2\n01:01:01,000 --> 01:01:02,000\n한 시간 뒤\n");
  assert.ok(F.toVtt(cues).startsWith("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>첫째</i>\n둘째\n"));
  assert.equal(F.toTxt(cues), "첫째 둘째\n한 시간 뒤");
  const ass = F.toAss(cues, "테스트");
  assert.ok(ass.includes("Title: 테스트"));
  assert.ok(ass.includes("Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}첫째{\\i0}\\N둘째"));
  assert.ok(ass.includes("Dialogue: 0,1:01:01.00,1:01:02.00,Default,,0,0,0,,한 시간 뒤"));
});

test("SRT 왕복 변환 동일성", () => {
  const cues = [{ start: 0, end: 1234, text: "왕복" }, { start: 2000, end: 3000, text: "테스트\n줄" }];
  const back = F.parseSrt(F.toSrt(cues));
  assert.deepEqual(back, cues);
});

test("extensionFor / rawExtensionFor", () => {
  assert.equal(F.extensionFor("vtt"), "vtt");
  assert.equal(F.extensionFor("unknown"), "srt");
  assert.equal(F.rawExtensionFor("ttml"), "xml");
  assert.equal(F.rawExtensionFor("json3"), "json");
});
