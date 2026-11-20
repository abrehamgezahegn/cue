import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const asset = process.platform === "darwin" ? "yt-dlp_macos"
  : process.platform === "win32" ? "yt-dlp.exe"
  : process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
console.log(`Downloading ${asset}…`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) throw new Error(`Could not download yt-dlp (${response.status}).`);
const target = join(root, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
await mkdir(join(root, "bin"), { recursive: true });
await writeFile(target, Buffer.from(await response.arrayBuffer()));
await chmod(target, 0o755);
console.log(`yt-dlp is ready at ${target}`);
