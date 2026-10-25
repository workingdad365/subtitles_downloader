(() => {
  async function write(root, path, source, { signal } = {}) {
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
      throw new Error("Invalid save path");
    }
    const save = async () => {
      signal?.throwIfAborted();
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      const original = parts.at(-1);
      const dot = original.lastIndexOf(".");
      const stem = dot > 0 ? original.slice(0, dot) : original;
      const extension = dot > 0 ? original.slice(dot) : "";
      let name = original;
      for (let index = 1; ; index += 1) {
        signal?.throwIfAborted();
        try {
          await directory.getFileHandle(name);
        } catch (error) {
          if (error.name === "NotFoundError") break;
          if (error.name !== "TypeMismatchError") throw error;
        }
        name = `${stem} (${index})${extension}`;
      }
      signal?.throwIfAborted();
      const file = await directory.getFileHandle(name, { create: true });
      let writable;
      try {
        writable = await file.createWritable();
        signal?.throwIfAborted();
        if (source && typeof source.pipeTo === "function") {
          await source.pipeTo(writable, { signal });
        } else {
          await writable.write(source);
          signal?.throwIfAborted();
          await writable.close();
        }
      } catch (error) {
        if (writable) await writable.abort().catch(() => {});
        await directory.removeEntry(name).catch(() => {});
        throw error;
      }
      return [...parts.slice(0, -1), name].join("/");
    };
    // 같은 확장의 여러 저장 창에서 파일명 확인과 생성을 직렬화함
    return globalThis.navigator?.locks
      ? navigator.locks.request("folder-writer", { signal }, save)
      : save();
  }

  globalThis.FolderWriter = { write };
  if (typeof module !== "undefined") module.exports = { write };
})();
