---
title: Packaging (.otmod)
description: Building a .otmod archive and the limits otterm applies.
sidebar:
  order: 6
---

A `.otmod` file is a zip archive of the mod folder. Include `otmod.toml`, the built `dist/` files, and the assets your mod needs. Source files and `node_modules` are not needed.

`otterm mod publish` produces `<id>-<version>.otmod` and a registry entry JSON. Submit the JSON as a pull request to the registry repository.

otterm refuses archives that are larger than 50 MB compressed or 200 MB expanded, paths that contain `../`, and symbolic links. Executables other than the `entry` file are ignored.

You can also distribute a mod from a Git URL (with an optional tag), from a `.otmod` file, or from a local folder during development with `otterm mod install ./path --link`.
