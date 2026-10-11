---
title: Publishing to the registry
description: How to publish to the official registry, the namespace rule, review, and signing.
sidebar:
  order: 7
---

The official registry is a static JSON index on GitHub, with the packages on GitHub Releases. Search runs on the user's machine.

1. Choose an ID that starts with your GitHub user name.
2. Run `otterm mod doctor <id>` and fix any warnings.
3. Declare only the permissions you need.
4. Run `otterm mod publish` to build the package and the entry JSON.
5. Authenticate with GitHub so otterm can confirm you own the namespace.
6. Submit the entry as a pull request to the registry repository.

Mods with `terminal.write` or `network` are reviewed by a person before they are listed. Others are listed first, and reports from users can hide them for review.

Packages will be signed with sigstore (keyless) later. Until then otterm checks each package against the size and sha256 in its registry entry, which `otterm mod publish` writes for you; a package that does not match is not installed. Only free mods can be listed in the official registry.
