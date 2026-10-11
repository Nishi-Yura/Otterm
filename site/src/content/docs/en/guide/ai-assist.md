---
title: AI assist
description: Asking Pebble for help, supported providers, and how data is sent.
sidebar:
  order: 9
---

AI assist lets you ask Pebble. It ships as the official mod `otterm.ai-assist` and is **off by default**. Without it, explanations, error hints, and the danger guard still work from the built-in dictionary.

## Providers

You can use a local model (for example through Ollama), or your own API key for Claude, OpenAI, Gemini, or any OpenAI-compatible endpoint. API keys are stored in the OS keychain, not in `config.toml`. Otterm checks for a local model only when you open the provider screen.

## What it does

- Turn a request into a command, such as "Pebble, find the process using this port". The command goes to the input line.
- Explain a failed command and suggest a fix.
- Answer questions about output.

## What it does not do

It never runs commands. You see a preview of what will be sent, and secrets such as tokens and passwords are replaced with `[REDACTED]` first. Answers from the dictionary are used when they are enough.
