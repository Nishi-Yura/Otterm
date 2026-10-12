# Messages for otterm.onboarding. Referenced from code as ctx.i18n.t("id").
# Lines follow docs/08 §5.2: at most two sentences, short, never opening with a negative, a button for every action.
# Both files define the same ids.

## Common buttons

btn-skip = Skip
btn-ok = OK
btn-later = Later
btn-start = Start
btn-yes = Yes
btn-no = No
btn-keep-default = Keep the default
btn-done = Done
btn-keep = Keep
btn-trash = Delete the folder

## First-run guide (docs/03 §11.1)

onboarding-greeting = Hi, I'm Pebble.
onboarding-language-question = First, choose the language you'd like to use.
onboarding-lang-ja = 日本語
onboarding-lang-en = English
onboarding-level-question = Have you used a terminal before?
onboarding-level-first = Never
onboarding-level-sometimes = Sometimes
onboarding-level-daily = Every day
onboarding-level-first-desc = Never: I explain each step and stop risky actions.
onboarding-level-sometimes-desc = Sometimes: I show what commands mean and confirm risky ones.
onboarding-level-daily-desc = Every day: a normal terminal. I only stop risky actions.
onboarding-shell-question = Which shell (the program that runs your commands) do you want?
onboarding-shell-body = You're using { $shell } for now. You can start with it as it is.
onboarding-shell-unknown = Your first terminal will use the recommended shell.
onboarding-shell-cmd = cmd runs without shell integration. PowerShell 7 is recommended.
shell-name-pwsh = PowerShell 7
shell-name-powershell = Windows PowerShell
shell-name-cmd = cmd
shell-name-bash = bash
shell-name-zsh = zsh
shell-name-fish = fish
shell-name-other = this shell
onboarding-integration-title = About shell integration
onboarding-integration-body = otterm loads a small hook only into the shells it starts. Your config files stay as they are.
onboarding-integration-rc-note = To use it in other terminals too, you can add one line from Settings.
onboarding-theme-question = Pick a look. You can change it any time.
onboarding-theme-light = Light
onboarding-theme-dark = Dark
onboarding-theme-system = Match the OS
onboarding-network-question = May I check for updates when you start?
onboarding-network-body = Apart from this, otterm never connects anywhere on its own.
onboarding-tutorial-offer = Shall we try "Your first terminal" together? It takes about 10 minutes.
onboarding-ai-title = About AI
onboarding-ai-offer = Want to ask an AI model questions from here? You see what is sent each time. You can change this later in Settings.
onboarding-done = All set. Type something and see.

## Tutorial (docs/03 §11.3)

tutorial-panel-title = Tutorial
tutorial-title = Your first terminal
tutorial-progress = { $n } / 6
tutorial-ch1-title = Where am I?
tutorial-ch1-intro = A terminal is always inside some folder. Check where you are with `{ $command }`.
tutorial-ch1-ls = Now list what's in this folder with `{ $command }`.
tutorial-ch2-title = Moving around
tutorial-ch2-intro = Enter the inside folder with `{ $command }`.
tutorial-ch2-up = `{ $command }` goes back up one level.
tutorial-ch3-title = Making and reading files
tutorial-ch3-create = `{ $command }` makes hello.txt and writes hello into it.
tutorial-ch3-read = Written. Read it back with `{ $command }`.
tutorial-ch4-title = Running a program
tutorial-ch4-run = Run hello.py with `{ $command }`.
tutorial-alt-hint = If it isn't found, try one of these instead.
tutorial-ch5-title = When things go wrong
tutorial-ch5-interrupt = If something won't stop, press Ctrl+C. Run `{ $command }` and stop it with Ctrl+C.
tutorial-ch5-error = Break something on purpose: run `{ $command }` and read the error.
tutorial-ch5-card = A failed command shows a red card. The red card is advice for your next step.
tutorial-ch6-title = Handy otterm features
tutorial-ch6-history = Ctrl+R finds commands you typed before.
tutorial-ch6-tree = The file tree on the left opens files.
tutorial-ch6-rerun = Right-click a block and choose "Run again" to run the same command once more.
tutorial-step-done = Done.
tutorial-step-retry = Almost. Try again; I'm looking for `{ $expected }`.
tutorial-complete = That's all six chapters. You can now use { $commands }.
tutorial-commands-posix = cd and ls
tutorial-commands-pwsh = Set-Location and Get-ChildItem
tutorial-cleanup = Delete the practice folder { $path }?
tutorial-cleaned = Moved to the Trash.
tutorial-no-session = Open a terminal first, then try again.
tutorial-reset-done = Tutorial progress has been reset.

## Command palette

cmd-restart-title = Show the first-run guide again
cmd-tutorial-start-title = Start the tutorial
cmd-tutorial-reset-title = Reset tutorial progress
