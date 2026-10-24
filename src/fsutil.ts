import { openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync, unlinkSync, writeFileSync, mkdirSync, constants } from "node:fs";
import { dirname, join, basename } from "node:path";

/**
 * Replaces a file all at once: temp in the SAME folder (rename across folders
 * is not atomic), 0600, fsync, rename. A reader sees the old file or the new
 * one, never half of either. When the rename is refused because the path is a
 * bind mount inside a box (EBUSY, EXDEV, EPERM), the file is overwritten in
 * place instead: not atomic, but it still lands.
 */
export function atomicWrite(path: string, data: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(tmp, mode); // the create mode is cut by the umask
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    if (!["EBUSY", "EXDEV", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    writeFileSync(path, data, { mode });
    chmodSync(path, mode);
  }
}
