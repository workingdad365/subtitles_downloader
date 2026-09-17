// DASH(MPD) 매니페스트 파서
// DOM 없이 정규식으로 텍스트 AdaptationSet의 세그먼트 URL 목록을 추출함
// Period가 여러 개인 경우(광고 삽입) 오디오/자막 구성이 같은 Period 집합 중 총 길이가 가장 긴 집합을 본편으로 간주함
var DashUtils = (() => {
  "use strict";

  // ISO 8601 기간(PT1H2M3.5S)을 초로 변환
  function parseIsoDuration(str) {
    if (!str) return 0;
    const m = String(str).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
    if (!m) return 0;
    return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (parseFloat(m[4]) || 0);
  }

  // 속성 문자열 파싱 (name="value")
  function parseAttrs(str) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(str || ""))) {
      out[m[1]] = m[3] !== undefined ? m[3] : m[4];
    }
    return out;
  }

  // 같은 이름의 요소가 중첩되지 않는다는 전제로 요소 목록 추출
  function findElements(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, "g");
    let m;
    while ((m = re.exec(xml))) {
      out.push({ attrs: parseAttrs(m[1]), inner: m[3] || "", outer: m[0] });
    }
    return out;
  }

  // 자식 요소 중 첫 BaseURL 텍스트 (하위 요소 내부는 제외)
  function directBaseUrl(inner, childTags) {
    let stripped = inner;
    for (const tag of childTags) {
      stripped = stripped.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "g"), "");
    }
    const m = stripped.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/);
    return m ? m[1].trim() : null;
  }

  function resolve(base, ref) {
    try {
      return new URL(ref, base).toString();
    } catch {
      return ref;
    }
  }

  function joinBase(base, ref) {
    if (!ref) return base;
    if (/^https?:\/\//i.test(ref)) return ref;
    return resolve(base, ref);
  }

  function roleToSource(role, label) {
    const r = String(role || "").toLowerCase();
    const l = String(label || "").toLowerCase();
    if (r.includes("forced") || l.includes("forced")) return "forced";
    if (r.includes("caption") || /\bsdh\b|\bcc\b/.test(l)) return "sdh";
    return "primary";
  }

  function mimeToKind(mime, codecs, sampleUrl) {
    const m = String(mime || "").toLowerCase();
    const c = String(codecs || "").toLowerCase();
    if (m.includes("vtt") || /\.(vtt|webvtt)(\?|$)/i.test(sampleUrl || "")) return "vtt";
    if (m.includes("ttml") || c.includes("stpp") || /\.(ttml|xml|dfxp)(\?|$)/i.test(sampleUrl || "")) return "ttml";
    if (m.includes("mp4") || c.includes("wvtt")) return "mp4";
    return "vtt";
  }

  function expandTemplate(template, vars) {
    return String(template).replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_, name, width) => {
      const value = vars[name];
      if (value === undefined) return "";
      return width ? String(value).padStart(parseInt(width, 10), "0") : String(value);
    });
  }

  // SegmentTemplate에서 세그먼트 URL 목록 생성
  function segmentsFromTemplate(templateEl, baseUrl, representationId, periodDurationSec) {
    const attrs = templateEl.attrs;
    const media = attrs.media;
    if (!media) return [];
    const timescale = Number(attrs.timescale) || 1;
    const startNumber = attrs.startNumber !== undefined ? parseInt(attrs.startNumber, 10) : 1;
    const urls = [];
    const timeline = findElements(templateEl.inner, "SegmentTimeline")[0];
    if (timeline) {
      let number = startNumber;
      let time = 0;
      for (const s of findElements(timeline.inner, "S")) {
        if (s.attrs.t !== undefined) time = Number(s.attrs.t);
        const d = Number(s.attrs.d) || 0;
        const r = parseInt(s.attrs.r || "0", 10);
        for (let i = 0; i <= r; i++) {
          urls.push(joinBase(baseUrl, expandTemplate(media, { RepresentationID: representationId, Number: number, Time: time })));
          number++;
          time += d;
        }
      }
      return urls;
    }
    const duration = Number(attrs.duration);
    if (duration > 0 && periodDurationSec > 0) {
      const count = Math.ceil(periodDurationSec / (duration / timescale));
      for (let i = 0; i < count; i++) {
        urls.push(joinBase(baseUrl, expandTemplate(media, { RepresentationID: representationId, Number: startNumber + i, Time: i * duration })));
      }
      return urls;
    }
    // 단일 세그먼트로 간주
    urls.push(joinBase(baseUrl, expandTemplate(media, { RepresentationID: representationId, Number: startNumber, Time: 0 })));
    return urls;
  }

  function isTextAdaptationSet(attrs, inner) {
    const contentType = String(attrs.contentType || "").toLowerCase();
    const mime = String(attrs.mimeType || "").toLowerCase();
    if (contentType === "text") return true;
    if (mime.startsWith("text/") || mime.includes("ttml")) return true;
    const rep = findElements(inner, "Representation")[0];
    const repMime = String(rep?.attrs.mimeType || "").toLowerCase();
    return repMime.startsWith("text/") || repMime.includes("ttml");
  }

  // 광고 Period 제거: (오디오 언어 수, 자막 언어 수) 서명이 같은 Period 중 총 길이가 가장 긴 집합만 유지
  function selectContentPeriods(periods) {
    if (periods.length <= 1) return periods;
    const totals = new Map();
    for (const p of periods) {
      totals.set(p.signature, (totals.get(p.signature) || 0) + p.durationSec);
    }
    let best = null;
    let bestTotal = -1;
    for (const [sig, total] of totals) {
      if (total > bestTotal) {
        best = sig;
        bestTotal = total;
      }
    }
    return periods.filter((p) => p.signature === best);
  }

  // MPD 텍스트에서 자막 트랙 목록 추출
  // 반환: [{ language, label, source, kind, segments: [{ url, offsetMs }] }]
  function parseTextTracks(mpdText, mpdUrl) {
    const xml = String(mpdText);
    const mpdEl = findElements(xml, "MPD")[0];
    if (!mpdEl) return [];
    const mpdBase = joinBase(mpdUrl, directBaseUrl(mpdEl.inner, ["Period"]));
    const rawPeriods = findElements(mpdEl.inner, "Period");
    let cursorSec = 0;
    const periods = rawPeriods.map((p) => {
      const startSec = p.attrs.start !== undefined ? parseIsoDuration(p.attrs.start) : cursorSec;
      const durationSec = p.attrs.duration !== undefined ? parseIsoDuration(p.attrs.duration) : 0;
      cursorSec = startSec + durationSec;
      const adaptationSets = findElements(p.inner, "AdaptationSet");
      const audioLangs = new Set();
      const textLangs = new Set();
      for (const a of adaptationSets) {
        const ct = String(a.attrs.contentType || a.attrs.mimeType || "").toLowerCase();
        if (ct.startsWith("audio")) audioLangs.add(a.attrs.lang || "");
        else if (isTextAdaptationSet(a.attrs, a.inner)) textLangs.add(a.attrs.lang || "");
      }
      return {
        el: p,
        id: p.attrs.id || "",
        startSec,
        durationSec,
        signature: `${audioLangs.size}a_${textLangs.size}t`,
        adaptationSets,
      };
    });
    const content = selectContentPeriods(periods);
    if (content.length === 0) return [];
    const firstStartMs = Math.round(content[0].startSec * 1000);
    const tracks = new Map();
    for (const period of content) {
      const periodBase = joinBase(mpdBase, directBaseUrl(period.el.inner, ["AdaptationSet"]));
      const offsetMs = Math.round(period.startSec * 1000) - firstStartMs;
      for (const set of period.adaptationSets) {
        if (!isTextAdaptationSet(set.attrs, set.inner)) continue;
        const lang = String(set.attrs.lang || "und").toLowerCase();
        const role = findElements(set.inner, "Role")[0]?.attrs.value || "";
        const label = findElements(set.inner, "Label")[0]?.inner.trim() || set.attrs.label || "";
        const source = roleToSource(role, label);
        const setBase = joinBase(periodBase, directBaseUrl(set.inner, ["Representation"]));
        const representations = findElements(set.inner, "Representation");
        const rep = representations[0] || { attrs: {}, inner: "" };
        const repBase = joinBase(setBase, directBaseUrl(rep.inner, []));
        const template = findElements(rep.inner, "SegmentTemplate")[0] || findElements(set.inner, "SegmentTemplate")[0];
        let urls = [];
        if (template) {
          urls = segmentsFromTemplate(template, setBase, rep.attrs.id || "", period.durationSec);
        } else if (repBase && repBase !== setBase) {
          urls = [repBase];
        } else {
          const list = findElements(rep.inner, "SegmentList")[0] || findElements(set.inner, "SegmentList")[0];
          if (list) urls = findElements(list.inner, "SegmentURL").map((s) => joinBase(setBase, s.attrs.media)).filter(Boolean);
        }
        if (urls.length === 0) continue;
        const kind = mimeToKind(rep.attrs.mimeType || set.attrs.mimeType, rep.attrs.codecs || set.attrs.codecs, urls[0]);
        if (kind === "mp4") continue;
        const key = `${lang}|${source}`;
        if (!tracks.has(key)) tracks.set(key, { language: lang, label: label || lang, source, kind, segments: [] });
        const track = tracks.get(key);
        for (const url of urls) track.segments.push({ url, offsetMs, periodId: period.id });
      }
    }
    return Array.from(tracks.values());
  }

  return { parseIsoDuration, parseAttrs, findElements, parseTextTracks };
})();

if (typeof module !== "undefined" && module.exports) module.exports = DashUtils;
