---
title: AI assist
description: Asking an AI for help, supported providers, what is sent and what is not.
sidebar:
  order: 9
---

AI assist lets you ask the AI you configured. It ships as the official mod `otterm.ai-assist` and is off by default. Without it, explanations, error hints and the danger guard still work from the built-in dictionary.

## Turning it on

At the end of the first-run guide you are asked "Want to ask an AI model questions from here? You see what is sent each time." The default is "Later". If you say yes, the provider screen opens.

You can use a local model (for example through Ollama), or your own API key for Claude, OpenAI, Gemini or any OpenAI-compatible endpoint. API keys are stored in the OS keychain, not in `config.toml`. otterm checks for a local model only when you open the provider screen.

## What it does

Describe what you want in plain words, such as "find the process using this port", and a suggested command goes to the input line. For a failed command it gives a likely cause and a possible fix, and `fix` suggests a corrected version of the last command. You can also ask what a long output means.

Replies are labelled "The AI's answer". They are the AI's text, not Pebble speaking. Each suggested command carries a note to read it before you run it.

## What is sent, and what is not

- Nothing runs. A suggestion only goes to the input line, and you press Enter.
- When a task needs several steps, you confirm them one at a time.
- You see the exact text in a preview before it is sent.
- Strings that look like passwords or tokens are replaced with `[REDACTED]` first.
- If the dictionary can answer, it answers without calling the AI.

## Logs

AI usage logs are kept for 30 days by default. Change this with `ai.log_retention_days`.
