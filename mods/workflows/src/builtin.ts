/** Built-in workflow sets (docs/03 §10). Plain typed data; the shape lives in workflows.ts. */

import type { LocalizedString } from "@otterm/api";
import type { WorkflowSet } from "./workflows";

const L = (ja: string, en: string): LocalizedString => ({ ja, en });

export const BUILTIN_SETS: WorkflowSet[] = [
  {
    id: "git",
    title: L("Git 日常セット", "Git daily set"),
    workflows: [
      {
        id: "git-new-branch",
        name: L("新しいブランチを作って切り替える", "Create a branch and switch to it"),
        command: "git checkout -b {{branch}}",
        args: {
          branch: {
            label: L("ブランチ名", "Branch name"),
            type: "string",
            placeholder: L("feature/xxx", "feature/xxx"),
          },
        },
      },
      {
        id: "git-commit-all",
        name: L("変更をすべてコミットする", "Commit all changes"),
        command: 'git add -A && git commit -m "{{message}}"',
        // Windows PowerShell 5.1 has no `&&`, so use `;` there.
        pwshCommand: 'git add -A; git commit -m "{{message}}"',
        args: {
          message: {
            label: L("コミットメッセージ", "Commit message"),
            type: "string",
            placeholder: L("変更の内容", "What changed"),
          },
        },
      },
      {
        id: "git-push",
        name: L("現在のブランチを上流へプッシュする", "Push the branch to origin"),
        command: "git push -u origin {{branch}}",
        args: {
          branch: {
            label: L("ブランチ名", "Branch name"),
            type: "string",
            placeholder: L("feature/xxx", "feature/xxx"),
          },
        },
      },
    ],
  },
  {
    id: "files",
    title: L("ファイル", "Files"),
    workflows: [
      {
        id: "files-grep",
        name: L("フォルダ内で文字を探す", "Search text in this folder"),
        command: 'grep -rn "{{text}}" .',
        pwshCommand: 'Select-String -Path . -Pattern "{{text}}" -Recurse',
        args: {
          text: { label: L("探す文字", "Text to find"), type: "string" },
        },
      },
    ],
  },
  {
    id: "python",
    title: L("Python", "Python"),
    workflows: [
      {
        id: "py-venv",
        name: L("仮想環境 .venv を作る", "Create a .venv virtual environment"),
        command: "python -m venv .venv",
      },
      {
        id: "py-run",
        name: L("Python ファイルを実行する", "Run a Python file"),
        command: "python {{file}}",
        args: {
          file: { label: L("ファイル", "File"), type: "path", placeholder: L("main.py", "main.py") },
        },
      },
    ],
  },
  {
    id: "node",
    title: L("Node", "Node"),
    workflows: [
      {
        id: "node-init",
        name: L("package.json を作る", "Create package.json"),
        command: "npm init -y",
      },
      {
        id: "node-script",
        name: L("npm スクリプトを実行する", "Run an npm script"),
        command: "npm run {{script}}",
        args: {
          script: {
            label: L("スクリプト名", "Script name"),
            type: "string",
            placeholder: L("dev", "dev"),
            default: "dev",
          },
        },
      },
    ],
  },
];
