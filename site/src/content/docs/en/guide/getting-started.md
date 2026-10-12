---
title: Getting started
description: How to install otterm and take your first steps.
sidebar:
  order: 1
---

otterm is a terminal emulator for people who have never used a terminal and for people who use one all day. It runs bash, zsh, PowerShell and cmd as they are.

A fresh otterm is a plain terminal with nothing added. Pebble, the typing help, the file tree, history search and the prompt bar are all mods: turn on the ones you want on the mods screen (the "mod" item in the status bar), or use "Turn on the recommended set".

> **Note**: v1.0 is for Windows (x64). macOS and Linux builds follow in 1.0.x once they have been checked on real machines; until then, build the [repository](https://github.com/Nishi-Yura/Otterm) from source.

## Install

**Windows**

Download `otterm_<version>_x64-setup.exe` from [Releases](https://github.com/Nishi-Yura/Otterm/releases/latest) and run it (per-user, no admin rights). Once the winget submission is accepted, this works too:

```powershell
winget install otterm
```

The installer is not code-signed, so SmartScreen may ask once ("More info" → "Run anyway").

**macOS (Homebrew)**

```sh
brew install --cask nishi-yura/otterm/otterm
```

The app is not notarized: the first time, right-click otterm.app in Finder and choose Open.

**Linux (AppImage)**

```sh
chmod +x otterm-*.AppImage
./otterm-*.AppImage
```

On Windows, the installer also places `otterm.com` next to `otterm.exe`, so typing `otterm` in PowerShell or cmd works.

## First launch

You are asked for the language, a guide level, a shell, a theme, and whether otterm may check for updates. You can change all of them later. If you skip onboarding, the guide level is 1.

## First steps

1. Press `Ctrl+Shift+T` (`Cmd+T` on macOS) to open a tab.
2. Run `ls` (or `Get-ChildItem` in PowerShell).
3. Look at the prompt bar above the output. It shows success or failure and the duration.
4. Press `F1` for help mode.

Next, read [Basics](/en/guide/basics/).
