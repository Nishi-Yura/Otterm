# otterm — Pebble's lines and UI strings (English)
# Host UI strings and mascot lines. Mascot lines move to mods/otterm.mascot/locales/en.ftl in M4.5
# Spec: docs/08-character.md §5
#
# Rules
# - Two sentences max. Plain words. Do not start with a negation. Prompts always come with an action button.
# - .mood attribute selects the face (calm | thinking | alert | happy); default calm.
# - Exclamation marks only in happy lines, and sparingly.

## Common

mascot-name = Pebble
app-name = otterm

action-insert = Insert into terminal
action-run-anyway = Run anyway
action-cancel = Cancel
action-show-more = Show more
action-open-settings = Open settings
action-dont-show-again = Don't ask again for this command
action-trust = Trust
action-not-now = Not now
action-yes = Yes
action-no = No

## Onboarding

onboarding-hello = Hi, I'm { mascot-name }. Let's decide how much I should help.
    .mood = happy
onboarding-level-question = Have you used a terminal before?
onboarding-level-first = Never
onboarding-level-first-desc = I'll explain each step and stop risky actions.
onboarding-level-sometimes = Sometimes
onboarding-level-sometimes-desc = I'll show what commands mean and confirm risky ones.
onboarding-level-daily = Every day
onboarding-level-daily-desc = A normal terminal. I only step in for risky actions.
onboarding-shell-question = Which shell (the program that runs your commands) do you want?
onboarding-shell-recommended = Recommended
onboarding-integration-title = About shell integration
onboarding-integration-body = { app-name } loads a small hook only into the shells it starts. Your config files stay untouched.
onboarding-integration-rc = Also use { app-name } integration in other terminals (adds one line to your rc file)
onboarding-theme-question = Pick a look. You can change it any time.
onboarding-network-question = May I check for updates on startup?
onboarding-network-body = This is the only time { app-name } connects anywhere on its own.
onboarding-tutorial-offer = Want to try "Your first terminal" with me? It takes about 10 minutes.
    .mood = happy
onboarding-ai-offer = Give { mascot-name } AI powers? You can decide later in Settings.
onboarding-done = All set. Type something and see.
    .mood = happy

## Empty tab (first time)

empty-tab-first = Type here and press Enter to run. Try { $command }.
empty-tab-first-hint = What you type is explained right below.

## Assist bar

assist-estimated = (estimated)
assist-unknown-command = Not in my dictionary yet. Run it once and I'll learn its help text.
assist-integration-off = Shell integration is off
assist-explain-format = { $command }: { $summary }

## Danger guard

danger-title-confirm = Please check
    .mood = alert
danger-title-block = This command can't be run
    .mood = alert
danger-rm-recursive = Everything inside this folder will be deleted, bypassing the trash.
    .mood = alert
danger-rm-recursive-alt = Move it to the trash instead?
danger-force-push = This overwrites remote history. Other people's commits may be lost.
    .mood = alert
danger-reset-hard = All uncommitted changes will be lost for good.
    .mood = alert
danger-pipe-to-shell = This runs downloaded code directly. It's safer to look at it first.
    .mood = alert
danger-generic = { $message }
    .mood = alert
danger-alternative-label = Instead: { $command }
danger-blocked-body = { $message } I stopped it.

## Error hints

error-hint-title = That didn't work
    .mood = alert
error-command-not-found = { $command } wasn't found. It may not be installed, or the name is different.
    .mood = alert
error-command-not-found-install = To install: { $install }
error-permission-denied = Permission denied. The file may belong to someone else, or you need admin rights.
    .mood = alert
error-no-such-file = { $path } wasn't found. Check the spelling and your current folder.
    .mood = alert
error-not-git-repo = This isn't a git repository. Move into one, or start with { $fix }.
error-port-in-use = Port { $port } is in use. You can see which program has it.
error-module-not-found = { $module } isn't installed. { $fix } will add it.
error-ask-ai = Ask { mascot-name }
error-interrupted = Stopped with Ctrl+C. That's not an error.
    .mood = calm

## Waiting and done

waiting-long = Still running. I'll let you know when it's done.
    .mood = thinking
done-long = Done! It took { $seconds ->
        [one] 1 second
       *[other] { $seconds } seconds
    }.
    .mood = happy
done-long-failed = Finished, but with an error (exit code { $code }).
    .mood = alert
notify-done-title = { $command } finished
notify-done-body = { $seconds } s, exit code { $code }

## Blocks

block-collapse = Collapse
block-expand = Expand
block-copy = Copy
block-rerun = Run again
block-save-output = Save output
block-share = Copy for sharing
block-truncated = { $hidden } lines hidden. Click to show.
block-exit-code = Exit code { $code }

## File tree learning hints

learn-cd = Moved with { $command }.
learn-mkdir = Folder created. The command for that is { $command }.
learn-touch = File created. The command for that is { $command }.
learn-mv = Renamed. The command for that is { $command }.
learn-trash = Moved to the trash. { $rm } can't be undone, so { app-name } uses the trash instead.
learn-run-inserted = I put the run command in the input. Press Enter to run it.

## Links

link-hint-first = Hold Ctrl and click a link or file name to open it.
link-open-file = Open { $path }
link-open-url = Open in browser
link-copy-path = Copy path

## Paste

paste-multiline-title = You're about to paste several lines
    .mood = alert
paste-multiline-body = { $lines } lines may run one after another. Please check them.
paste-confirm = Paste
paste-as-single-line = Paste as one line

## Workspace trust

trust-title = Trust this folder's settings?
    .mood = alert
trust-body = { $path } contains an { app-name } config. Trusting it enables its tab commands and mods.
trust-commands-label = Commands that will run
trust-mods-label = Mods that will be enabled
trust-later = Open without trusting

## Mods

mod-installed = { $name } is in. { $adds }
    .mood = happy
mod-installed-generic = { $name } is in.
    .mood = happy
mod-permissions-title = { $name } will
mod-permission-fs-read = read files in { $scope }
mod-permission-fs-write = write files in { $scope }
mod-permission-process = run { $commands }
mod-permission-network = connect to { $hosts }
mod-permission-clipboard = read and write the clipboard
mod-permission-terminal-read = read terminal output
mod-permission-terminal-write = type into the terminal (it can run commands)
mod-permission-ai = ask your configured AI
mod-permission-none-write = This mod does not type into the terminal.
mod-permission-none-network = This mod does not use the network.
mod-allow-enable = Allow and enable
mod-crashed = { $name } stopped. Nothing else is affected.
    .mood = alert
mod-crashed-disabled = { $name } kept stopping, so I disabled it.
    .mood = alert
mod-wrote-terminal = { $name } typed into the terminal: { $text }
mod-slow = { $name } is adding { $ms } ms to your typing.

## Settings

settings-mascot-intro = You can change how I appear here, or hide me entirely.
settings-mascot-visible = Show { mascot-name }
settings-mascot-speech = Speech bubbles
settings-mascot-mood = Change expression
settings-mascot-position = Position
settings-mascot-outfit = Outfit
settings-mascot-reset-hints = Show first-time tips again
settings-guide-level = Guide level

## Safe mode

safe-mode-started = Started with themes and mods off. You can turn them back on in Settings.
    .mood = calm

## Tutorial

tutorial-title = Your first terminal
tutorial-start = Let's do this together. You'll type the real commands.
    .mood = happy
tutorial-ch1-title = Where am I?
tutorial-ch1-intro = A terminal is always "in" some folder. Check where you are with { $command }.
tutorial-ch1-ls = Now list what's in this folder with { $command }.
tutorial-ch2-title = Moving around
tutorial-ch2-intro = { $command } enters a folder. Try entering the tutorial folder.
tutorial-ch2-up = { $command } goes back up one level.
tutorial-ch3-title = Making and reading files
tutorial-ch3-create = { $command } writes text into a file.
tutorial-ch3-read = Written. Read it back with { $command }.
tutorial-ch4-title = Running a program
tutorial-ch4-run = { $command } runs hello.py.
tutorial-ch5-title = When things go wrong
tutorial-ch5-interrupt = If something won't stop, press Ctrl+C. Run { $command } and stop it with Ctrl+C.
tutorial-ch5-error = Let's make a mistake on purpose. Run { $command } and read the error.
tutorial-ch6-title = Handy { app-name } features
tutorial-ch6-history = Ctrl+R finds commands you typed before.
tutorial-ch6-tree = The file tree on the left opens files.
tutorial-step-done = Nice!
    .mood = happy
tutorial-step-retry = Almost. Try again; I'm looking for { $expected }.
tutorial-complete = You did it all! You can now use { $commands }.
    .mood = happy
tutorial-cleanup = Delete the practice folder { $path }?

## AI (otterm.ai-assist)

ai-ask-placeholder = Describe what you want to do
ai-thinking = Thinking…
    .mood = thinking
ai-result-explain = { $summary }
ai-result-danger = This command includes a risky operation.
    .mood = alert
ai-result-unknown-option = I can't verify { $option } in my dictionary.
ai-preview-title = This will be sent to { $provider }
ai-preview-redacted = Redacted: { $count ->
        [one] 1 item
       *[other] { $count } items
    }
ai-preview-send = Send
ai-preview-dont-show = Don't ask again (you can always view what's sent)
ai-connection-failed = I couldn't connect. Check the settings?
    .mood = alert
ai-disabled-workspace = AI is turned off for this workspace.
ai-fix-title = How to fix
ai-fix-cause = Cause
ai-fix-command = Fixed command
ai-summary-title = What you've been doing
ai-step-title = Plan
ai-step-run = Run this step
ai-step-stop = Stop
ai-step-failed = Step { $n } failed, so I stopped.
    .mood = alert

## Password input

echo-off-notice = You're typing a password. It isn't shown or recorded.
    .mood = calm

## Memory and performance

memory-warning = Using { $gb } GB of memory. Largest tab: { $tab }
mod-overhead-warning = A mod is slowing down typing. Check Developer mode.

## Terminal

terminal-label = Terminal
terminal-input-label = Terminal input
process-exited = { $code ->
    [none] The process exited
   *[other] The process exited with code { $code }
}
start-failed = Could not start the shell: { $error }
config-ignored = Ignored part of config.toml: { $keys }
config-unreadable = Could not read the configuration: { $error }

## Search

search-label = Search the terminal
search-placeholder = Search
search-match-case = Match case
search-whole-word = Whole word
search-regex = Regular expression
search-invalid = Invalid pattern
search-older = Older (Enter)
search-newer = Newer (Shift+Enter)
search-close = Close (Esc)

## Context menu

menu-copy = Copy
menu-paste = Paste
menu-select-all = Select all
menu-clear-scrollback = Clear scrollback
menu-search = Find
menu-open-link = Open link
menu-copy-link = Copy link
