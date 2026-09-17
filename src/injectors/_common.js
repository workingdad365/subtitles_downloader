// MAIN world 인젝터 공용 헬퍼
// 페이지 컨텍스트에서 fetch/XHR/JSON.parse를 후킹하고 콘텐츠 스크립트와 postMessage로 통신함
(() => {
  "use strict";
  if (window.__subtitlesDownloader__) return;

  const NS = "subtitles_downloader";

  const api = {
    NS,

    // 콘텐츠 스크립트로 이벤트 전송
    post(type, payload) {
      window.postMessage({ ns: NS, dir: "page", type, payload }, "*");
    },

    // 요청에 대한 응답 전송
    reply(requestId, type, payload) {
      window.postMessage({ ns: NS, dir: "page", type, payload, requestId }, "*");
    },

    // 콘텐츠 스크립트에서 오는 요청 수신
    onRequest(handler) {
      window.addEventListener("message", (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.ns !== NS || d.dir !== "content") return;
        try {
          handler(d.type, d.payload || {}, d.requestId);
        } catch (err) {
          api.log("request handler error", err);
        }
      });
    },

    log(...args) {
      console.info("[subtitles_downloader]", ...args);
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // window.fetch 후킹: 응답 객체를 복제해 콜백에 전달 (콜백은 동기적으로 clone 여부를 결정함)
    hookFetch(callback) {
      const original = window.fetch;
      window.fetch = async function patchedFetch(...args) {
        const response = await original.apply(this, args);
        try {
          const input = args[0];
          const url = typeof input === "string" ? input : input && input.url ? input.url : String(input || "");
          callback(url, response, args[1]);
        } catch (err) {
          api.log("fetch hook error", err);
        }
        return response;
      };
      return original;
    },

    // XMLHttpRequest 후킹: load 시점에 URL과 xhr 객체를 콜백에 전달
    hookXhr(callback) {
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
        this.__sdUrl = String(url || "");
        this.__sdMethod = method;
        if (!this.__sdHooked) {
          this.__sdHooked = true;
          this.addEventListener("load", () => {
            try {
              callback(this.__sdUrl, this);
            } catch (err) {
              api.log("xhr hook error", err);
            }
          });
        }
        return originalOpen.call(this, method, url, ...rest);
      };
    },

    // XHR 응답을 문자열로 추출 (텍스트/JSON 응답만 지원)
    xhrText(xhr) {
      try {
        if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText;
        if (xhr.responseType === "json") return JSON.stringify(xhr.response);
      } catch {
        // 응답 접근 실패 시 null 반환
      }
      return null;
    },

    // Response.prototype.json 후킹: fetch().json()으로 소비되는 응답도 콜백에 전달
    hookResponseJson(callback) {
      const original = Response.prototype.json;
      Response.prototype.json = function patchedJson(...args) {
        const url = this.url;
        return original.apply(this, args).then((result) => {
          try {
            callback(result, url);
          } catch (err) {
            api.log("Response.json hook error", err);
          }
          return result;
        });
      };
    },

    // JSON.parse 후킹: 파싱 결과를 콜백에 전달
    hookJsonParse(callback) {
      const original = JSON.parse;
      JSON.parse = function patchedParse(text, reviver) {
        const result = original.call(this, text, reviver);
        try {
          callback(result);
        } catch (err) {
          api.log("JSON.parse hook error", err);
        }
        return result;
      };
    },
  };

  window.__subtitlesDownloader__ = api;
})();
