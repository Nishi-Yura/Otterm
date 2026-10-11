---
title: Kotsume (Pebble)
description: The otterm mascot, Kotsume (Pebble), and how to configure it.
sidebar:
  order: 8
---

Kotsume (called Pebble in English) is the otter who lives in otterm. The model is the Asian small-clawed otter. Kotsume is not a sea otter.

Kotsume guides you with short messages, stops you before dangerous commands, and waits with you during long tasks. It never runs a command or presses Enter for you.

```toml
[mascot]
visible = "auto"          # auto | always | never
position = "assist-bar"   # assist-bar | statusbar | float | hidden
speech = "auto"
outfit = "default"
```

Hiding Kotsume removes nothing. Its messages appear as normal interface text. Outfits can be added by mods, and the built-in ones are `default`, `developer`, and `pixel`.
