// 자막 포맷 파서 및 직렬화기
// DOM API를 사용하지 않아 서비스 워커, 콘텐츠 스크립트, Node 테스트에서 공용으로 사용함
// 내부 큐 모델: { start: ms, end: ms, text: "줄1\n줄2" } (텍스트에는 <i>, <b>, <u> 태그만 허용)
var SubtitleFormats = (() => {
  "use strict";

  const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

  // HTML/XML 엔티티 복원
  function decodeEntities(text) {
    return String(text)
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-z]+);/gi, (m, name) => ENTITY_MAP[name.toLowerCase()] ?? m);
  }

  function pad(n, width) {
    return String(n).padStart(width, "0");
  }

  function splitMs(ms) {
    const total = Math.max(0, Math.round(ms));
    return {
      h: Math.floor(total / 3600000),
      m: Math.floor((total % 3600000) / 60000),
      s: Math.floor((total % 60000) / 1000),
      ms: total % 1000,
    };
  }

  function msToSrtTime(ms) {
    const t = splitMs(ms);
    return `${pad(t.h, 2)}:${pad(t.m, 2)}:${pad(t.s, 2)},${pad(t.ms, 3)}`;
  }

  function msToVttTime(ms) {
    const t = splitMs(ms);
    return `${pad(t.h, 2)}:${pad(t.m, 2)}:${pad(t.s, 2)}.${pad(t.ms, 3)}`;
  }

  function msToAssTime(ms) {
    const t = splitMs(ms);
    return `${t.h}:${pad(t.m, 2)}:${pad(t.s, 2)}.${pad(Math.floor(t.ms / 10), 2)}`;
  }

  // "HH:MM:SS.mmm", "MM:SS.mmm", "SS.mmm" 형태를 ms로 변환 (구분자 ',' 허용)
  function parseClockTime(str) {
    if (str == null) return null;
    const s = String(str).trim().replace(",", ".");
    if (!s) return null;
    const parts = s.split(":");
    if (parts.length > 3 || parts.some((p) => p === "" || Number.isNaN(Number(p)))) return null;
    let h = 0;
    let m = 0;
    let sec = 0;
    if (parts.length === 3) {
      h = Number(parts[0]);
      m = Number(parts[1]);
      sec = parseFloat(parts[2]);
    } else if (parts.length === 2) {
      m = Number(parts[0]);
      sec = parseFloat(parts[1]);
    } else {
      sec = parseFloat(parts[0]);
    }
    return Math.round((h * 3600 + m * 60 + sec) * 1000);
  }

  // TTML 시간 표현 처리: "123t", "1.5s", "500ms", "2m", "1h", "HH:MM:SS.mmm", "HH:MM:SS:FF"
  function parseTtmlTime(str, opts = {}) {
    if (str == null) return null;
    const s = String(str).trim();
    if (!s) return null;
    const tickRate = opts.tickRate || 10000000;
    const frameRate = opts.frameRate || 30;
    let m;
    if ((m = s.match(/^([\d.]+)t$/))) return Math.round((parseFloat(m[1]) / tickRate) * 1000);
    if ((m = s.match(/^([\d.]+)ms$/))) return Math.round(parseFloat(m[1]));
    if ((m = s.match(/^([\d.]+)s$/))) return Math.round(parseFloat(m[1]) * 1000);
    if ((m = s.match(/^([\d.]+)m$/))) return Math.round(parseFloat(m[1]) * 60000);
    if ((m = s.match(/^([\d.]+)h$/))) return Math.round(parseFloat(m[1]) * 3600000);
    if ((m = s.match(/^(\d+):(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/))) {
      const frames = parseInt(m[4], 10) + (m[5] ? parseFloat(`0.${m[5]}`) : 0);
      const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frames / frameRate;
      return Math.round(secs * 1000);
    }
    return parseClockTime(s);
  }

  // 속성 문자열에서 값 추출 (name="value" 또는 name='value')
  function getAttr(attrString, name) {
    if (!attrString) return null;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
    const m = attrString.match(re);
    if (!m) return null;
    return m[2] !== undefined ? m[2] : m[3];
  }

  // <i>, <b>, <u> 이외의 태그 제거
  function stripTagsKeepBasic(text) {
    let t = String(text).replace(/<\s*(\/?)\s*([ibu])(?:\.[^>\s]*)?(?:\s[^>]*)?>/gi, (_, slash, tag) => `\u0001${slash}${tag.toLowerCase()}\u0002`);
    t = t.replace(/<[^>]*>/g, "");
    return t.replace(/\u0001/g, "<").replace(/\u0002/g, ">");
  }

  // 모든 태그 및 ASS 오버라이드 블록 제거
  function stripAllTags(text) {
    return String(text).replace(/\{[^}]*\}/g, "").replace(/<[^>]*>/g, "");
  }

  function normalizeNewlines(text) {
    return String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }

  // 큐 텍스트 정리: 줄 단위 트림, 연속 공백 축소, 빈 줄 제거
  function cleanCueText(text) {
    return normalizeNewlines(text)
      .split("\n")
      .map((line) => line.replace(/[ \t\u00A0]+/g, " ").trim())
      .filter((line) => line !== "")
      .join("\n");
  }

  function sortCues(cues) {
    return cues.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // 시작/종료 시각이 동일한 인접 큐 병합 (TTML 다중 region 대응)
  function mergeSameTiming(cues) {
    const out = [];
    for (const cue of cues) {
      const last = out[out.length - 1];
      if (last && last.start === cue.start && last.end === cue.end) {
        last.text = `${last.text}\n${cue.text}`;
      } else {
        out.push({ ...cue });
      }
    }
    return out;
  }

  // 내용이 완전히 같은 큐 제거 (HLS 세그먼트 병합 대응)
  function dedupeCues(cues) {
    const seen = new Set();
    const out = [];
    for (const cue of cues) {
      const key = `${cue.start}|${cue.end}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
    return out;
  }

  function finalizeCues(cues) {
    return sortCues(cues.filter((c) => c && c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end >= c.start));
  }

  // ---------------------------------------------------------------------------
  // 파서
  // ---------------------------------------------------------------------------

  // WebVTT / SRT 공용 파서 (타임라인 줄을 기준으로 블록 추출)
  function parseTimedBlocks(text, { stripBraces }) {
    const lines = normalizeNewlines(text).split("\n");
    const cues = [];
    for (let i = 0; i < lines.length; i++) {
      const timing = lines[i].match(/^\s*(\S+)\s+-->\s+(\S+)/);
      if (!timing) continue;
      const start = parseClockTime(timing[1]);
      const end = parseClockTime(timing[2]);
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        body.push(lines[i]);
        i++;
      }
      if (start == null || end == null) continue;
      let raw = body.join("\n").replace(/<\d{1,2}:\d{2}[:\d.]*>/g, "");
      if (stripBraces) raw = raw.replace(/\{[^}]*\}/g, "");
      const cueText = cleanCueText(decodeEntities(stripTagsKeepBasic(raw)));
      if (cueText) cues.push({ start, end, text: cueText });
    }
    return cues;
  }

  function parseVtt(text) {
    return parseTimedBlocks(text, { stripBraces: false });
  }

  function parseSrt(text) {
    return parseTimedBlocks(text, { stripBraces: true });
  }

  // TTML / DFXP / IMSC 파서 (Netflix dfxp, Prime Video ttml2 대응)
  function parseTtml(xml) {
    const src = normalizeNewlines(xml);
    const tickRateMatch = src.match(/ttp:tickRate\s*=\s*"(\d+)"/i);
    const frameRateMatch = src.match(/ttp:frameRate\s*=\s*"(\d+)"/i);
    const timeOpts = {
      tickRate: tickRateMatch ? parseInt(tickRateMatch[1], 10) : 10000000,
      frameRate: frameRateMatch ? parseInt(frameRateMatch[1], 10) : 30,
    };
    const styles = {};
    for (const m of src.matchAll(/<style\b([^>]*?)\/?>/gi)) {
      const attrs = m[1];
      const id = getAttr(attrs, "xml:id") || getAttr(attrs, "id");
      if (!id) continue;
      styles[id] = {
        italic: /tts:fontStyle\s*=\s*"italic"/i.test(attrs),
        bold: /tts:fontWeight\s*=\s*"bold"/i.test(attrs),
      };
    }
    const styleFlags = (attrs) => {
      const ref = styles[getAttr(attrs, "style")] || {};
      return {
        italic: ref.italic || /tts:fontStyle\s*=\s*"italic"/i.test(attrs),
        bold: ref.bold || /tts:fontWeight\s*=\s*"bold"/i.test(attrs),
      };
    };
    const cues = [];
    for (const m of src.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      const attrs = m[1];
      let inner = m[2];
      const begin = parseTtmlTime(getAttr(attrs, "begin"), timeOpts);
      let end = parseTtmlTime(getAttr(attrs, "end"), timeOpts);
      const dur = parseTtmlTime(getAttr(attrs, "dur"), timeOpts);
      if (begin == null) continue;
      if (end == null && dur != null) end = begin + dur;
      if (end == null) continue;
      inner = inner.replace(/<br\s*\/?>/gi, "\n");
      // 가장 안쪽 span부터 반복 치환하여 중첩 span 처리
      const spanRe = /<span\b([^>]*)>((?:(?!<span\b)[\s\S])*?)<\/span>/gi;
      for (let guard = 0; guard < 10 && spanRe.test(inner); guard++) {
        spanRe.lastIndex = 0;
        inner = inner.replace(spanRe, (_, sa, content) => {
          const f = styleFlags(sa);
          let c = content;
          if (f.italic) c = `<i>${c}</i>`;
          if (f.bold) c = `<b>${c}</b>`;
          return c;
        });
      }
      let cueText = inner.replace(/<(?!\/?[ibu]>)[^>]+>/g, "");
      cueText = cleanCueText(decodeEntities(cueText));
      if (!cueText) continue;
      const pf = styleFlags(attrs);
      if (pf.italic) cueText = `<i>${cueText}</i>`;
      if (pf.bold) cueText = `<b>${cueText}</b>`;
      cues.push({ start: begin, end, text: cueText });
    }
    return mergeSameTiming(sortCues(cues));
  }

  // YouTube srv1 (<text start dur>) 파서
  function parseYoutubeSrv1(xml) {
    const cues = [];
    for (const m of String(xml).matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
      const start = parseFloat(getAttr(m[1], "start"));
      const dur = parseFloat(getAttr(m[1], "dur"));
      if (!Number.isFinite(start)) continue;
      const end = start + (Number.isFinite(dur) ? dur : 0);
      const cueText = cleanCueText(stripTagsKeepBasic(decodeEntities(decodeEntities(m[2]))));
      if (cueText) cues.push({ start: Math.round(start * 1000), end: Math.round(end * 1000), text: cueText });
    }
    return cues;
  }

  // YouTube srv3 (<p t d>) 파서
  function parseYoutubeSrv3(xml) {
    const cues = [];
    for (const m of String(xml).matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      const attrs = m[1];
      if (getAttr(attrs, "a") === "1") continue;
      const start = parseInt(getAttr(attrs, "t"), 10);
      const dur = parseInt(getAttr(attrs, "d"), 10);
      if (!Number.isFinite(start)) continue;
      const cueText = cleanCueText(decodeEntities(m[2].replace(/<[^>]*>/g, "")));
      if (cueText) cues.push({ start, end: start + (Number.isFinite(dur) ? dur : 0), text: cueText });
    }
    return cues;
  }

  // YouTube json3 파서
  function parseYoutubeJson3(text) {
    let json;
    try {
      json = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      return [];
    }
    const events = Array.isArray(json?.events) ? json.events : [];
    const cues = [];
    for (const ev of events) {
      if (ev.aAppend === 1 || !Array.isArray(ev.segs)) continue;
      const cueText = cleanCueText(ev.segs.map((s) => s.utf8 ?? "").join(""));
      if (!cueText) continue;
      const start = ev.tStartMs ?? 0;
      cues.push({ start, end: start + (ev.dDurationMs ?? 0), text: cueText });
    }
    return cues;
  }

  // SBV 파서 (0:00:00.000,0:00:02.000)
  function parseSbv(text) {
    const cues = [];
    for (const block of normalizeNewlines(text).trim().split(/\n{2,}/)) {
      const lines = block.split("\n");
      const m = lines[0].match(/^\s*(\d+:\d{2}:\d{2}\.\d{3})\s*,\s*(\d+:\d{2}:\d{2}\.\d{3})/);
      if (!m) continue;
      const cueText = cleanCueText(lines.slice(1).join("\n"));
      if (cueText) cues.push({ start: parseClockTime(m[1]), end: parseClockTime(m[2]), text: cueText });
    }
    return cues;
  }

  // ASS/SSA 파서 (Dialogue 줄만 추출)
  function parseAss(text) {
    const cues = [];
    for (const line of normalizeNewlines(text).split("\n")) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.substring(9).split(",");
      if (parts.length < 10) continue;
      const start = parseClockTime(parts[1]);
      const end = parseClockTime(parts[2]);
      const body = parts.slice(9).join(",");
      const cueText = cleanCueText(body
        .replace(/\{\\i1\}/g, "<i>").replace(/\{\\i0\}/g, "</i>")
        .replace(/\{\\b1\}/g, "<b>").replace(/\{\\b0\}/g, "</b>")
        .replace(/\{\\u1\}/g, "<u>").replace(/\{\\u0\}/g, "</u>")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " "));
      if (start != null && end != null && cueText) cues.push({ start, end, text: cueText });
    }
    return cues;
  }

  // SAMI 파서 (<SYNC Start=ms>)
  function parseSami(text) {
    const items = [];
    for (const m of String(text).matchAll(/<SYNC\s+Start\s*=\s*"?(\d+)"?[^>]*>([\s\S]*?)(?=<SYNC|<\/BODY|$)/gi)) {
      const body = m[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
      const cueText = cleanCueText(decodeEntities(body));
      items.push({ start: parseInt(m[1], 10), text: cueText });
    }
    const cues = [];
    for (let i = 0; i < items.length; i++) {
      if (!items[i].text) continue;
      const end = i + 1 < items.length ? items[i + 1].start : items[i].start + 3000;
      cues.push({ start: items[i].start, end, text: items[i].text });
    }
    return cues;
  }

  // 텍스트 내용으로 포맷 판별
  function detectFormat(text) {
    const t = normalizeNewlines(text).trim();
    if (!t) return "unknown";
    if (t.startsWith("WEBVTT")) return "vtt";
    if (t.startsWith("#EXTM3U")) return "m3u8";
    if (/^<\?xml[^>]*>\s*<MPD|^<MPD\b/.test(t)) return "mpd";
    if (t.includes("[Script Info]") || t.includes("[Events]")) return "ass";
    if (t.startsWith("{") && (t.includes("\"events\"") || t.includes("\"wireMagic\""))) return "json3";
    if (/<tt[\s>]/.test(t) && (t.includes("ttml") || t.includes("ttaf1") || t.includes("<body"))) return "ttml";
    if (/<timedtext\b/i.test(t)) return "srv3";
    if (/<transcript\b/i.test(t) || /<text\s+start=/i.test(t)) return "srv1";
    if (/<SAMI\b/i.test(t) || /<SYNC\b/i.test(t)) return "smi";
    if (/^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t)) return "srt";
    if (/^\d+:\d{2}:\d{2}\.\d{3}\s*,\s*\d+:\d{2}:\d{2}\.\d{3}/.test(t)) return "sbv";
    if (/\d{1,2}:\d{2}[:\d.,]*\s+-->\s+\d{1,2}:\d{2}/.test(t)) return "vtt";
    return "unknown";
  }

  const CUE_FORMATS = new Set(["vtt", "srt", "ttml", "srv1", "srv3", "json3", "sbv", "ass", "smi"]);

  function isCueFormat(format) {
    return CUE_FORMATS.has(format);
  }

  function parseByFormat(text, format) {
    switch (format) {
      case "vtt": return parseVtt(text);
      case "srt": return parseSrt(text);
      case "ttml": return parseTtml(text);
      case "srv1": return parseYoutubeSrv1(text);
      case "srv3": return parseYoutubeSrv3(text);
      case "json3": return parseYoutubeJson3(text);
      case "sbv": return parseSbv(text);
      case "ass": return parseAss(text);
      case "smi": return parseSami(text);
      default: return [];
    }
  }

  // 포맷 힌트가 있으면 우선 사용하고, 없으면 자동 판별하여 파싱
  // 힌트로 파싱한 결과가 비어 있으면 자동 판별 결과로 재시도함
  function parse(text, formatHint) {
    const detected = detectFormat(text);
    let format = formatHint && CUE_FORMATS.has(formatHint) ? formatHint : detected;
    let cues = parseByFormat(text, format);
    if (cues.length === 0 && format !== detected && CUE_FORMATS.has(detected)) {
      format = detected;
      cues = parseByFormat(text, format);
    }
    return { format, cues: finalizeCues(cues) };
  }

  // 여러 세그먼트 텍스트를 파싱해 하나의 큐 목록으로 병합 (세그먼트별 오프셋 적용 가능)
  function mergeSegments(segmentTexts, formatHint, offsetsMs) {
    const all = [];
    segmentTexts.forEach((text, index) => {
      if (!text) return;
      const offset = Array.isArray(offsetsMs) ? offsetsMs[index] || 0 : 0;
      for (const cue of parse(text, formatHint).cues) {
        all.push({ start: cue.start + offset, end: cue.end + offset, text: cue.text });
      }
    });
    return dedupeCues(finalizeCues(all));
  }

  // ---------------------------------------------------------------------------
  // 직렬화
  // ---------------------------------------------------------------------------

  function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${msToSrtTime(c.start)} --> ${msToSrtTime(c.end)}\n${c.text}\n`).join("\n");
  }

  function toVtt(cues) {
    return `WEBVTT\n\n${cues.map((c) => `${msToVttTime(c.start)} --> ${msToVttTime(c.end)}\n${c.text}\n`).join("\n")}`;
  }

  function toTxt(cues) {
    return cues.map((c) => stripAllTags(c.text).replace(/\n/g, " ")).join("\n");
  }

  function toAss(cues, title = "Subtitles") {
    const header = [
      "[Script Info]",
      `Title: ${title}`,
      "ScriptType: v4.00+",
      "WrapStyle: 0",
      "ScaledBorderAndShadow: yes",
      "PlayResX: 1920",
      "PlayResY: 1080",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1,2,2,10,10,10,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];
    const lines = cues.map((c) => {
      const text = c.text
        .replace(/<i>/g, "{\\i1}").replace(/<\/i>/g, "{\\i0}")
        .replace(/<b>/g, "{\\b1}").replace(/<\/b>/g, "{\\b0}")
        .replace(/<u>/g, "{\\u1}").replace(/<\/u>/g, "{\\u0}")
        .replace(/\n/g, "\\N");
      return `Dialogue: 0,${msToAssTime(c.start)},${msToAssTime(c.end)},Default,,0,0,0,,${text}`;
    });
    return `${header.concat(lines).join("\n")}\n`;
  }

  const OUTPUT_EXTENSIONS = { srt: "srt", vtt: "vtt", txt: "txt", ass: "ass" };

  const RAW_EXTENSIONS = { vtt: "vtt", srt: "srt", ttml: "xml", srv1: "xml", srv3: "xml", json3: "json", sbv: "sbv", ass: "ass", smi: "smi" };

  function serialize(cues, format, title) {
    switch (format) {
      case "vtt": return toVtt(cues);
      case "txt": return toTxt(cues);
      case "ass": return toAss(cues, title);
      case "srt":
      default: return toSrt(cues);
    }
  }

  function extensionFor(format) {
    return OUTPUT_EXTENSIONS[format] || "srt";
  }

  function rawExtensionFor(rawFormat) {
    return RAW_EXTENSIONS[rawFormat] || "txt";
  }

  return {
    decodeEntities,
    parseClockTime,
    parseTtmlTime,
    msToSrtTime,
    msToVttTime,
    msToAssTime,
    detectFormat,
    isCueFormat,
    parse,
    parseVtt,
    parseSrt,
    parseTtml,
    parseYoutubeSrv1,
    parseYoutubeSrv3,
    parseYoutubeJson3,
    parseSbv,
    parseAss,
    parseSami,
    mergeSegments,
    dedupeCues,
    toSrt,
    toVtt,
    toTxt,
    toAss,
    serialize,
    extensionFor,
    rawExtensionFor,
    stripAllTags,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SubtitleFormats;
