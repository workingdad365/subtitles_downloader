const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "..", "src", "shared", "folder-store.js"), "utf8");
const tick = () => new Promise(setImmediate);

function storage() {
  const values = new Map();
  const transactions = [];
  let created = false;
  let closed = 0;
  const database = {
    createObjectStore() { created = true; },
    close() { closed += 1; },
    transaction(_name, mode) {
      let pending;
      const transaction = {
        objectStore() {
          return {
            get(key) { return { result: values.get(key) }; },
            put(value, key) {
              assert.equal(mode, "readwrite");
              pending = { value, key };
              return { result: key };
            }
          };
        },
        commit() {
          if (pending) values.set(pending.key, pending.value);
          transaction.oncomplete();
        },
        abort() {
          transaction.error = new DOMException("디스크 쓰기 실패", "UnknownError");
          transaction.onabort();
        }
      };
      transactions.push(transaction);
      return transaction;
    }
  };
  const indexedDB = { open() {
    const request = { result: database };
    queueMicrotask(() => {
      if (!created) request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  } };
  return {
    transactions, closed: () => closed,
    openWindow() {
      const context = vm.createContext({ indexedDB, DOMException });
      vm.runInContext(source, context);
      return context.FolderStore;
    }
  };
}

test("폴더 핸들은 트랜잭션 완료 후 저장되며 새 실행 컨텍스트에서 복원", async () => {
  const fixture = storage();
  const first = fixture.openWindow();
  const handle = { kind: "directory", name: "저장 폴더" };
  let saved = false;
  const saving = first.save(handle).then(() => { saved = true; });
  await tick();
  assert.equal(saved, false);
  assert.equal(fixture.closed(), 0);
  fixture.transactions[0].commit();
  await saving;
  assert.equal(fixture.closed(), 1);
  const restored = fixture.openWindow().load();
  await tick();
  fixture.transactions[1].commit();
  assert.equal(await restored, handle);
  assert.equal(fixture.closed(), 2);
});

test("폴더 설정 트랜잭션 실패는 오류로 전달하며 기존 설정을 보존", async () => {
  const fixture = storage();
  const store = fixture.openWindow();
  const original = { kind: "directory", name: "기존 폴더" };
  const saving = store.save(original);
  await tick();
  fixture.transactions[0].commit();
  await saving;
  const rejected = assert.rejects(store.save({ kind: "directory", name: "새 폴더" }), /디스크 쓰기 실패/);
  await tick();
  fixture.transactions[1].abort();
  await rejected;
  const restored = fixture.openWindow().load();
  await tick();
  fixture.transactions[2].commit();
  assert.equal(await restored, original);
  assert.equal(fixture.closed(), 3);
});
