// Fetches the ConPTY that otterm ships on Windows (decision M3): conpty.dll and OpenConsole.exe from
// Microsoft's Microsoft.Windows.Console.ConPTY NuGet package (MIT). The version and hash are pinned;
// bump both together after checking the release notes.
//
//   node scripts/fetch-conpty.js            # no-op outside Windows
//
// Output: crates/otterm-app/resources/windows/<arch>/{conpty.dll,OpenConsole.exe} (git-ignored).
// crates/otterm-app/build.rs copies them next to the built executable.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VERSION = "1.25.260930003";
const SHA256 = "02b07b349af66d801159bdf9e440d4a1ce78bb951f37fc8609731665afdae7ee";
const URL = `https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/${VERSION}/microsoft.windows.console.conpty.${VERSION}.nupkg`;
// NuGet runtime folder → our folder name, for the architectures Windows builds target.
const ARCHES = { "win-x64": "x64", "win-arm64": "arm64" };

const root = path.resolve(__dirname, "..");
const outRoot = path.join(root, "crates", "otterm-app", "resources", "windows");
const stamp = path.join(outRoot, "VERSION");

async function main() {
  if (process.platform !== "win32" && !process.argv.includes("--force")) {
    console.log("fetch-conpty: not on Windows, nothing to do");
    return;
  }
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === VERSION) {
    console.log(`fetch-conpty: ${VERSION} already present`);
    return;
  }

  console.log(`fetch-conpty: downloading ${VERSION}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const pkg = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash("sha256").update(pkg).digest("hex");
  if (hash !== SHA256) throw new Error(`hash mismatch: expected ${SHA256}, got ${hash}`);

  // Extract in a fresh temporary folder; Windows' bsdtar reads zip files (a .nupkg is one).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "otterm-conpty-"));
  try {
    const zip = path.join(tmp, "conpty.zip");
    fs.writeFileSync(zip, pkg);
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zip, "-C", tmp], { stdio: "inherit" });

    for (const [runtime, arch] of Object.entries(ARCHES)) {
      const dest = path.join(outRoot, arch);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(tmp, "runtimes", runtime, "native", "conpty.dll"), path.join(dest, "conpty.dll"));
      fs.copyFileSync(
        path.join(tmp, "build", "native", "runtimes", arch, "OpenConsole.exe"),
        path.join(dest, "OpenConsole.exe"),
      );
    }
    fs.writeFileSync(stamp, `${VERSION}\n`);
    console.log(`fetch-conpty: wrote ${path.relative(root, outRoot)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`fetch-conpty: ${e.message}`);
  process.exit(1);
});
