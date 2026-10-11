# Homebrew cask, filled in by scripts/release.mjs on macOS (docs/release.md). It goes in a tap
# repository (homebrew-otterm) first; homebrew/cask needs a notarized app, which costs money.
cask "otterm" do
  version "{{version}}"
  sha256 "{{dmgSha256}}"

  url "{{dmgUrl}}"
  name "otterm"
  desc "Terminal that is easy for beginners and fast for everyone"
  homepage "{{repository}}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  app "otterm.app"
  binary "#{appdir}/otterm.app/Contents/MacOS/otterm"

  zap trash: [
    "~/Library/Application Support/otterm",
    "~/.config/otterm",
  ]
end
