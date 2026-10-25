(() => {
  async function transact(mode, operation) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("download-folder", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("settings", mode);
        const request = operation(transaction.objectStore("settings"));
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onabort = () => reject(transaction.error || request.error || new Error("Folder storage transaction aborted"));
      });
    } finally {
      database.close();
    }
  }

  function load() {
    return transact("readonly", (store) => store.get("directory"));
  }

  function save(directory) {
    return transact("readwrite", (store) => store.put(directory, "directory"));
  }

  async function canReuse(directory) {
    if (!directory) return false;
    try {
      const options = { mode: "readwrite" };
      if (await directory.queryPermission(options) !== "granted" &&
          await directory.requestPermission(options) !== "granted") {
        throw new DOMException("Write access to the selected folder is required", "NotAllowedError");
      }
      // 삭제된 폴더는 파일을 받기 전에 다시 선택하도록 확인함
      await directory.entries().next();
      return true;
    } catch (error) {
      if (error.name === "NotFoundError") return false;
      throw error;
    }
  }

  globalThis.FolderStore = { load, save, canReuse };
  if (typeof module !== "undefined") module.exports = { load, save, canReuse };
})();
