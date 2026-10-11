---
title: Manifest (otmod.toml)
description: Writing otmod.toml with identity, compatibility, additions, and settings.
sidebar:
  order: 2
---

```toml
[mod]
id = "example.git-status-bar"   # <GitHub user>.<name>, lowercase letters, digits, and hyphens
name = "Git Status Bar"
version = "1.2.0"
description = "Shows the branch and changed-file count in the status bar"
author = "example"
license = "MIT"
kind = "extension"

[compat]
otterm = ">=1.0.0 <2.0.0"
api = "1"
platforms = ["windows", "macos", "linux"]

[entry]
main = "dist/main.js"

[permissions]
process = ["git"]
fs.read = ["${cwd}/**"]
terminal.read = true

[settings.schema]
show_dirty_count = { type = "boolean", default = true, label = "Show dirty count" }
```

- `id` must start with your GitHub user name. `otterm.*` is reserved for official mods.
- `api = "1"` selects the API major version.
- `[settings.schema]` supports `boolean`, `integer`, `number`, `string`, `enum`, `path`, `color`, and `keychord`. Every setting needs `default` and `label`.
