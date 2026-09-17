// 확장 프로그램 아이콘(PNG) 생성 스크립트
// 외부 의존성 없이 zlib로 PNG를 직접 인코딩함. 파란 둥근 사각형 위에 자막을 뜻하는 흰 막대 두 줄을 그림
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(__dirname, "..", "icons");

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 픽셀 중심 좌표(0..1)에 대한 도형 판정
function inRoundedRect(u, v, radius) {
  const cx = Math.min(Math.max(u, radius), 1 - radius);
  const cy = Math.min(Math.max(v, radius), 1 - radius);
  return (u - cx) ** 2 + (v - cy) ** 2 <= radius ** 2;
}

function inBar(u, v, x0, x1, y0, y1) {
  return u >= x0 && u <= x1 && v >= y0 && v <= y1;
}

function makeIcon(size) {
  const SS = 4;
  return encodePng(size, (x, y) => {
    let bg = 0;
    let bar = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS) / size;
        const v = (y + (sy + 0.5) / SS) / size;
        if (!inRoundedRect(u, v, 0.22)) continue;
        bg++;
        if (inBar(u, v, 0.2, 0.8, 0.5, 0.62) || inBar(u, v, 0.2, 0.58, 0.7, 0.82)) bar++;
      }
    }
    const total = SS * SS;
    const alpha = Math.round((bg / total) * 255);
    if (alpha === 0) return [0, 0, 0, 0];
    const t = bar / Math.max(bg, 1);
    const r = Math.round(37 + (255 - 37) * t);
    const g = Math.round(99 + (255 - 99) * t);
    const b = Math.round(235 + (255 - 235) * t);
    return [r, g, b, alpha];
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log(`written ${file}`);
}
