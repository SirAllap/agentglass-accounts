import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, ftruncateSync, fstatSync, mkdirSync, constants } from "node:fs";
import { dirname, join, basename } from "node:path";

/** The syscalls a test needs to look at or break: the rename, the fsync, the cut that ends an in-place write. */
export const io = { rename: renameSync, fsync: fsyncSync, truncate: ftruncateSync };

/**
 * Replaces a file all at once: temp in the SAME folder (rename across folders
 * is not atomic), 0600, fsync, rename. A reader sees the old file or the new
 * one, never half of either. For the plugin's own files only: a file that is
 * bind-mounted into the box cannot be renamed over (see `overwriteJsonInPlace`).
 * The create mode is cut by the umask, never widened, so no chmod follows.
 */
export function atomicWrite(path: string, data: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    writeSync(fd, data);
    io.fsync(fd);
  } finally { closeSync(fd); }
  try {
    io.rename(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
}

/**
 * Overwrites a JSON file where it stands: same inode, so it works on a file the
 * box bind-mounts (a rename over one is refused) and on a symlink (the link is
 * kept, its target changes). There is no temp file and no O_TRUNC, so a reader
 * never meets an empty file:
 *  - the new text goes in with ONE write at offset 0; when it is shorter than
 *    the old file it is padded with spaces (JSON ignores them), so the file is
 *    a whole document before and after the write, and the cut to the real
 *    length comes last;
 *  - then fsync.
 * What it cannot do is survive a crash or a power cut between the write and the
 * end of it: the file may be left torn. The caller keeps a copy to restore from.
 * An existing file keeps its mode; a new one is 0600.
 */
export function overwriteJsonInPlace(path: string, data: string) {
  const buf = Buffer.from(data);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
  try {
    const old = fstatSync(fd).size;
    const out = buf.length < old ? Buffer.concat([buf, Buffer.alloc(old - buf.length, 0x20)]) : buf;
    for (let at = 0; at < out.length; ) at += writeSync(fd, out, at, out.length - at, at);
    if (buf.length < old) io.truncate(fd, buf.length);
    io.fsync(fd);
  } finally { closeSync(fd); }
}
