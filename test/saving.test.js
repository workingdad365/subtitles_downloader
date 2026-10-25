const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Formats = require("../src/shared/formats.js");
const Filename = require("../src/shared/filename.js");
const Platforms = require("../src/shared/platforms.js");
const source = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");
const tick = () => new Promise(setImmediate);
const text = "1\n00:00:01,000 --> 00:00:02,000\n한글 자막\n";

test("플랫폼 자막은 변환한 텍스트를 반환하고 브라우저 다운로드를 호출하지 않음", async () => {
  let listener;
  const context = vm.createContext({
    window: { addEventListener() {}, postMessage() {} },
    location: { href: "https://www.youtube.com/watch?v=test" },
    document: { title: "제목 - YouTube" },
    Platforms, FilenameUtils: Filename, SubtitleFormats: Formats, URL,
    setTimeout() {}, clearTimeout() {}, console: { info() {} },
    chrome: { i18n: { getMessage: (key) => key }, runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        assert.equal(message.type, "PROXY_FETCH");
        return { ok: true, text };
      }
    } }
  });
  vm.runInContext(source("src/content/content-script.js"), context);
  const response = await new Promise((resolve) => listener({ type: "PREPARE_SUBTITLE", track: { url: "https://www.youtube.com/api/timedtext", format: "srt" }, format: "vtt" }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.filename, "제목.vtt");
  assert.match(response.content, /^WEBVTT/);
  assert.match(response.content, /한글 자막/);
  assert.equal(response.cueCount, 1);
});

test("일반 사이트 감지 자막도 저장 창에 텍스트를 반환", async () => {
  let listener;
  let detected;
  let clicked;
  const windows = [];
  const event = { addListener() {} };
  const context = vm.createContext({ URL, TextDecoder, AbortController, setTimeout, clearTimeout, console: { info() {} },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/plain" }, arrayBuffer: async () => new TextEncoder().encode(text).buffer }),
    chrome: {
      action: { onClicked: { addListener(fn) { clicked = fn; } } },
      windows: { create(options) { windows.push(options); } },
      runtime: {
        getURL: (url) => `chrome-extension://subtitles/${url}`,
        onMessage: { addListener(fn) { listener = fn; } }, onInstalled: event, onStartup: event,
        sendMessage: async () => {}
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      permissions: { contains: async () => true, onAdded: event, onRemoved: event },
      tabs: { get: async () => ({ id: 7, url: "https://example.com/video", title: "제목" }), onUpdated: event, onRemoved: event },
      webRequest: { onCompleted: { addListener(fn) { detected = fn; } } }
    }
  });
  context.importScripts = (...scripts) => scripts.forEach((script) => vm.runInContext(source(`src/background/${script}`), context));
  vm.runInContext(source("src/background/service-worker.js"), context);
  await tick();
  clicked({ id: 7 });
  assert.match(windows[0].url, /popup.html\?tabId=7$/);
  detected({ tabId: 7, statusCode: 200, url: "https://cdn.example.com/ko.srt", responseHeaders: [] });
  await tick();
  const state = await new Promise((resolve) => listener({ type: "GET_UNIVERSAL_STATE", tabId: 7 }, {}, resolve));
  assert.equal(state.tracks.length, 1);
  const response = await new Promise((resolve) => listener({ type: "PREPARE_UNIVERSAL_SUBTITLE", tabId: 7, trackId: state.tracks[0].id, format: "srt" }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.filename, "제목.srt");
  assert.match(response.content, /한글 자막/);
});

function popup({ universal = false, cancel = false, writeError = false, writeGate } = {}) {
  const elements = new Map();
  const created = [];
  function element() {
    const listeners = new Map();
    return { textContent: "", value: "", children: [], options: [], disabled: false,
      append(...children) { this.children.push(...children); },
      addEventListener(type, fn) { listeners.set(type, fn); },
      click() { return listeners.get("click")?.(); }
    };
  }
  for (const id of source("src/popup/popup.html").matchAll(/id="([^"]+)"/g)) elements.set(id[1], element());
  const requests = [];
  const writes = [];
  let picked = 0;
  const track = { id: "track", language: "ko", source: "primary", format: "srt" };
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id),
      querySelectorAll: (selector) => selector === "button, select" ? [...elements.values(), ...created] : [],
      createElement() { const el = element(); created.push(el); return el; }
    },
    window: {
      addEventListener() {},
      async showDirectoryPicker() {
        picked += 1;
        if (cancel) throw new DOMException("cancel", "AbortError");
        return { name: "선택한 폴더", requestPermission: async () => "granted" };
      }
    },
    location: { search: "?tabId=7" }, URLSearchParams, Intl, AbortController, Platforms,
    FolderWriter: { async write(directory, filename, content) {
      writes.push({ directory: directory.name, filename, content });
      if (writeError) throw new DOMException("denied", "NotAllowedError");
      await writeGate;
      return "제목 (1).srt";
    } },
    chrome: {
      i18n: { getUILanguage: () => "ko", getMessage: (key, subs) => `${key}${subs ? `:${subs.join(",")}` : ""}` },
      storage: { local: { get: async () => ({ format: "srt" }), set: async () => {} } },
      tabs: {
        async get(id) { assert.equal(id, 7); return { id, url: universal ? "https://example.com/video" : "https://www.youtube.com/watch?v=test" }; },
        async sendMessage(id, message) {
          assert.equal(id, 7);
          if (message.type === "GET_STATE") return { tracks: [track], videoInfo: { title: "제목" } };
          requests.push(message);
          return { ok: true, filename: "제목.srt", content: text };
        }
      },
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          if (message.type === "GET_UNIVERSAL_STATE") return { enabled: true, tracks: [track] };
          requests.push(message);
          return { ok: true, filename: "제목.srt", content: text };
        }
      }
    }
  });
  vm.runInContext(source("src/popup/popup.js"), context);
  return { elements, requests, writes, picked: () => picked,
    download: () => elements.get(universal ? "universalTracks" : "tracks").children[0].children[1].click() };
}

test("폴더 선택 취소 시 자막 요청과 파일 쓰기를 실행하지 않음", async () => {
  const fixture = popup({ cancel: true });
  await tick();
  await fixture.download();
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.elements.get("status").textContent, "saveCancelled");
});

test("네이티브와 범용 자막 모두 선택한 폴더에 저장하고 같은 창에서는 재사용", async () => {
  for (const universal of [false, true]) {
    const fixture = popup({ universal });
    await tick();
    await fixture.download();
    await fixture.download();
    assert.equal(fixture.picked(), 1);
    assert.equal(fixture.writes.length, 2);
    assert.equal(fixture.writes[0].directory, "선택한 폴더");
    assert.equal(fixture.writes[0].content, text);
    assert.equal(fixture.requests[0].type, universal ? "PREPARE_UNIVERSAL_SUBTITLE" : "PREPARE_SUBTITLE");
    assert.equal(fixture.elements.get("status").textContent, "downloaded:제목 (1).srt");
  }
});

test("쓰기 완료 전에는 성공 표시 없이 조작을 잠그고 실패 시 오류 표시", async () => {
  let finish;
  const fixture = popup({ writeGate: new Promise((resolve) => { finish = resolve; }) });
  await tick();
  const downloading = fixture.download();
  await tick();
  assert.equal(fixture.elements.get("chooseFolder").disabled, true);
  assert.equal(fixture.elements.get("status").textContent, "downloading");
  finish();
  await downloading;
  assert.equal(fixture.elements.get("chooseFolder").disabled, false);
  const failed = popup({ writeError: true });
  await tick();
  await failed.download();
  assert.match(failed.elements.get("status").textContent, /errPrefix.*denied/);
  assert.equal(failed.elements.get("chooseFolder").disabled, false);
});
