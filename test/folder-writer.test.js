const assert = require("node:assert/strict");
const { test } = require("node:test");
const { write } = require("../src/shared/folder-writer.js");

function directory({ failOpen = false, failWrite = false, closeGate } = {}) {
  const entries = new Map();
  let aborted = 0;
  return {
    entries,
    get aborted() { return aborted; },
    async getDirectoryHandle(name) {
      if (!entries.has(name)) entries.set(name, directory());
      return entries.get(name);
    },
    async getFileHandle(name, options) {
      if (!entries.has(name)) {
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        entries.set(name, Buffer.alloc(0));
      }
      return {
        async createWritable() {
          if (failOpen) throw new DOMException("denied", "NotAllowedError");
          const chunks = [];
          const sink = {
            write(chunk) {
              if (failWrite) throw new Error("disk full");
              chunks.push(Buffer.from(chunk));
            },
            async close() {
              await closeGate;
              entries.set(name, Buffer.concat(chunks));
            },
            abort() { aborted += 1; }
          };
          const stream = new WritableStream(sink);
          stream.write = async (chunk) => sink.write(chunk);
          stream.close = () => sink.close();
          return stream;
        }
      };
    },
    async removeEntry(name) { entries.delete(name); }
  };
}

test("한글 자막 이름과 UTF-8 내용을 유지하고 기존 파일을 보존", async () => {
  const root = directory();
  assert.equal(await write(root, "제목 S01E02.srt", "기존 자막\n"), "제목 S01E02.srt");
  assert.equal(await write(root, "제목 S01E02.srt", "다른 언어 자막\n"), "제목 S01E02 (1).srt");
  assert.equal(root.entries.get("제목 S01E02.srt").toString(), "기존 자막\n");
  assert.equal(root.entries.get("제목 S01E02 (1).srt").toString(), "다른 언어 자막\n");
});

test("파일 close가 끝난 후에만 저장 성공", async () => {
  let close;
  const root = directory({ closeGate: new Promise((resolve) => { close = resolve; }) });
  let finished = false;
  const saving = write(root, "subtitle.srt", "자막").then(() => { finished = true; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  close();
  await saving;
  assert.equal(root.entries.get("subtitle.srt").toString(), "자막");
});

test("권한 거절과 쓰기 실패 시 기존 자막을 보존하고 새 파일만 정리", async () => {
  for (const failure of [{ failOpen: true }, { failWrite: true }]) {
    const root = directory(failure);
    root.entries.set("subtitle.srt", Buffer.from("기존 자막"));
    await assert.rejects(write(root, "subtitle.srt", "새 자막"));
    assert.deepEqual([...root.entries.keys()], ["subtitle.srt"]);
    assert.equal(root.entries.get("subtitle.srt").toString(), "기존 자막");
  }
});

test("잘못된 경로와 시작 전 취소는 파일 생성 없이 거절", async () => {
  const root = directory();
  for (const path of ["../outside.txt", "/absolute.txt", "a//file.txt", "a\\b.txt", "./file.txt"]) {
    await assert.rejects(write(root, path, "text"), /Invalid save path/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(write(root, "cancelled.txt", "text", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(root.entries.size, 0);
});
