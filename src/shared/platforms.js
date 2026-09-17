// 지원 플랫폼 정의 및 URL 기반 플랫폼 판별
var Platforms = (() => {
  "use strict";

  const AMAZON_HOSTS = [
    "amazon.com", "amazon.ca", "amazon.com.mx", "amazon.com.br", "amazon.co.uk", "amazon.de", "amazon.fr",
    "amazon.it", "amazon.es", "amazon.nl", "amazon.se", "amazon.pl", "amazon.com.tr", "amazon.co.jp",
    "amazon.in", "amazon.sg", "amazon.com.au", "amazon.ae", "amazon.sa",
  ];

  // enabled: false 인 플랫폼은 미검증 상태로 비활성화됨 (manifest에도 등록하지 않음)
  const LIST = [
    { id: "youtube", name: "YouTube", enabled: true, hosts: ["youtube.com"], cdnHosts: ["googlevideo.com"] },
    { id: "netflix", name: "Netflix", enabled: true, hosts: ["netflix.com"], cdnHosts: ["nflxvideo.net"] },
    { id: "disneyplus", name: "Disney+", enabled: true, hosts: ["disneyplus.com"], cdnHosts: ["dssott.com", "dssedge.com", "bamgrid.com"] },
    { id: "primevideo", name: "Prime Video", enabled: false, hosts: ["primevideo.com", ...AMAZON_HOSTS], cdnHosts: ["pv-cdn.net", "aiv-cdn.net", "aiv-delivery.net"], pathRequired: { hosts: AMAZON_HOSTS, path: "/gp/video" } },
    { id: "appletv", name: "Apple TV+", enabled: false, hosts: ["tv.apple.com"], cdnHosts: ["itunes.apple.com"] },
    { id: "hbomax", name: "HBO Max", enabled: false, hosts: ["play.hbomax.com", "play.max.com"], cdnHosts: ["hbomax.com", "max.com", "discomax.com"] },
  ];

  const ENABLED = LIST.filter((p) => p.enabled);

  // 범용 감지에서 제외할 호스트 (활성 플랫폼의 페이지 및 자막 CDN)
  const NATIVE_HOST_SUFFIXES = ENABLED.flatMap((p) => [...p.hosts, ...(p.cdnHosts || [])]);

  function hostMatches(hostname, suffix) {
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }

  function detect(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    for (const p of ENABLED) {
      for (const h of p.hosts) {
        if (!hostMatches(host, h)) continue;
        if (p.pathRequired && p.pathRequired.hosts.includes(h) && !u.pathname.startsWith(p.pathRequired.path)) continue;
        return p.id;
      }
    }
    return null;
  }

  function nameOf(id) {
    return LIST.find((p) => p.id === id)?.name || id;
  }

  function isNativeHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return NATIVE_HOST_SUFFIXES.some((s) => hostMatches(host, s));
  }

  return { LIST, ENABLED, detect, nameOf, isNativeHost };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Platforms;
