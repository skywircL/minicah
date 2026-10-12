import { stat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { watch } from "chokidar";
import { fail } from "../errors.js";

export interface WatchOptions { readonly stabilityMs?: number; readonly pollIntervalMs?: number; readonly usePolling?: boolean }

/** Watch the containing directory so editor rename-save and initially missing parents work. */
export async function watchFile(path: string, changed: () => void, failed: () => void, options: WatchOptions = {}): Promise<() => Promise<void>> {
  const filename = resolve(path);
  let root = dirname(filename), depth = 0;
  while (true) {
    try {
      if (!(await stat(root)).isDirectory()) fail("WATCH_PATH", "Watch parent must be a directory");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(root);
      if (parent === root) throw error;
      root = parent; depth++;
    }
  }
  const canonicalRoot = await realpath(root), target = resolve(canonicalRoot, relative(root, filename));
  const relevant = (path: string) => path === target || target.startsWith(path + sep);
  const watcher = watch(canonicalRoot, {
    depth, ignoreInitial: true, followSymlinks: false,
    ignored: path => !relevant(resolve(path)),
    awaitWriteFinish: { stabilityThreshold: options.stabilityMs ?? 250, pollInterval: options.pollIntervalMs ?? 50 },
    atomic: true,
    usePolling: options.usePolling ?? false, interval: options.pollIntervalMs ?? 100,
  });
  const change = (path: string) => { if (relevant(resolve(path))) changed(); };
  watcher.on("add", change).on("change", change).on("unlink", change).on("addDir", change).on("unlinkDir", change);
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      watcher.once("ready", () => { ready = true; resolve(); });
      watcher.on("error", error => { if (ready) failed(); else reject(error); });
    });
    return () => watcher.close();
  } catch (error) { await watcher.close(); throw error; }
}
