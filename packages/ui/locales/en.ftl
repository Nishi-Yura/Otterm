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
mod-permission-output = read everything the terminal prints, as it happens
mod-permission-nothing = It uses no special permissions.
mod-write-confirm-title = { $name } wants to type into the terminal
mod-write-confirm-body = It could run commands as you. Allow it for this session?
mod-clipboard-confirm-title = { $name } wants to read the clipboard
mod-clipboard-confirm-body = Allow it for this session?
mod-crashed-toast = { $name } stopped: { $message }
mod-status-inactive = Off
mod-status-starting = Starting
mod-status-active = Running
mod-status-enabled = On
mod-status-crashed = Stopped (error)
mod-status-disabled = Disabled
mod-status-needs-grant = Waiting for permission
mod-status-error = Cannot load
mod-status-stopping = Stopping
mod-enable = Enable
mod-disable = Disable
mod-uninstall = Remove
mod-logs = Logs ({ $n })
mod-linked = linked
mods-none = No mods are installed. Put a mod folder in the mods directory, or link one with create-otterm-mod's `pnpm dev`.
mods-title = Mods
panel-close = Close panel
status-folder = Current folder
status-exit = Exit code of the last command
status-mods = Open the mods list
status-mods-count = { $n } mods
status-mods-broken = { $n } stopped
scope-cwd = the current folder
completion-recommended = recommended
completion-danger = danger
palette-title = Command palette
palette-placeholder = Search commands (start with ! to run in the shell)
palette-run-shell = Run in the shell: { $command }
palette-empty = Nothing found
palette-source-mod = mod
palette-cmd-new-tab = New tab
palette-cmd-close-tab = Close tab
palette-cmd-split-vertical = Split vertically
palette-cmd-split-horizontal = Split horizontally
palette-cmd-settings = Open settings
palette-cmd-settings-file = Open the settings file (config.toml) in the editor
palette-cmd-restart-safe = Restart in safe mode
palette-cmd-restart-normal = Restart normally
safe-mode-banner = Safe mode: themes, CSS overrides and mods are not loaded.
settings-safe-mode = Safe mode
settings-safe-mode-hint = For when a theme, CSS or a mod made the window unusable. You can also start it with otterm --safe-mode.
palette-cmd-mods = Mods
palette-cmd-history = Search history
palette-cmd-tutorial = Start the tutorial
palette-cmd-profile = New tab: { $name }
palette-cmd-guide = Guide level: { $level }
palette-cmd-editor = Editor: use { $name }
palette-prefix-line = go to line
palette-prefix-help = explain a command
palette-prefix-file = open a file
palette-prefix-block = find a block
palette-goto-line = Go to line { $line }
history-filter-cwd = This folder
history-filter-ok = Succeeded
history-filter-today = Today
history-filter-shell = Shell history too
history-from-shell = { $shell } history
history-title = History
history-placeholder = Search commands you ran
history-empty = No history yet
history-exit-ok = ok
history-exit-failed = exit { $code }
multiline-title = Multi-line input
multiline-hint = Ctrl+Enter sends, Esc closes
multiline-send = Send
multiline-unclosed-single = an ' is not closed
multiline-unclosed-double = a " is not closed
multiline-unbalanced-brackets = brackets are not balanced
status-guide = Guide level (click to change)
status-guide-level = Lv{ $level }
danger-run = Run anyway
danger-cancel = Cancel
scope-home = your home folder
scope-workspace = the workspace
scope-mod = its own folder
scope-data = its own data area

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
launch-unknown = Could not use these arguments: { $args }
store-title = Store (mod registry)
store-consent = The store reads the list of mods (the registry) on GitHub. Besides checking for updates, this is the only connection otterm makes by itself. Press the button if that is fine.
store-connect = Connect to the registry
store-search = Find mods
store-refresh = Refresh
store-error = Could not load the list: { $error }
store-empty = Nothing found
store-reviewed = reviewed
store-permissions = Permissions: { $list }
store-incompatible = It does not say it runs on this otterm
store-installed = Installed
store-install = Install
store-update = Update (you have { $version })
palette-cmd-update = Check for updates
update-title = otterm { $version } is available
update-body = You have { $current }. { $notes }
update-install = Update and restart
update-later = Later
update-installing = Downloading the update…
update-none = otterm is up to date
update-failed = Could not check for updates: { $error }
crash-title = otterm quit unexpectedly last time
crash-body = The log is saved at { $path }. otterm sent nothing anywhere. Reporting it helps fix the problem.
crash-issue = Open an issue (copies the log)
crash-copy = Copy the log
crash-close = Close
crash-issue-title = Crash report
crash-issue-body = ## What I was doing{"\u000A\u000A"}## Log{"\u000A\u000A"}(Paste the log from the clipboard here, after checking what it contains)
ai-unavailable = To ask the AI, install and turn on the AI mod (otterm.ai-assist)
command-unknown = There is no command { $id }
workspace-trust-title = Trust the workspace “{ $name }”?
workspace-trust-body = The .otterm/workspace.toml in { $root } wants to run commands, turn on mods or change settings. Until you trust it, only its theme is used. Trust only folders you made or whose contents you checked.
workspace-trust-yes = Trust
workspace-trust-no = Don’t trust
copy-failed = Could not copy to the clipboard: { $error }

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
menu-reset-modes = Reset terminal state
menu-open-config = Open settings file
menu-search = Find
menu-open-link = Open link
menu-copy-link = Copy link
menu-rerun = Run again: { $command }
menu-copy-command = Copy command
menu-copy-output = Copy output
menu-save-output = Save output
menu-copy-markdown = Copy as Markdown
menu-fold = Fold output
menu-unfold = Unfold output
menu-select-block = Select block
block-folded = { $n } lines folded (click to show)
block-actions = Block actions
block-more = More actions
block-saved = Saved to { $path }
block-running = running

## Tabs and panes

tab-new = New tab
tab-new-profile = New tab with…
profile-pwsh = PowerShell 7
profile-powershell = Windows PowerShell
profile-cmd = Command Prompt
profile-git-bash = Git Bash
tab-close = Close tab
tab-rename = Tab name
tab-untitled = Terminal
close-running-title = A program is still running
close-running-body = { $program } is running. Closing ends it.
close-running-confirm = Close

## Clipboard (OSC 52)

osc52-ask = The running program wants to put { $chars } characters on the clipboard.
osc52-allow = Allow
osc52-allow-always = Always allow in this tab
osc52-deny = Deny

## Settings screen: labels for the generated form

set-schema = Settings version
    .desc = Version of the settings file format. Do not edit by hand.
set-general = General
set-general--language = Language
    .desc = Display language of the interface. Auto follows the OS setting.
set-general--guide_level = Help level
    .desc = 0 is off and 3 gives the most guidance.
set-general--check_updates = Check for updates on startup
    .desc = Checks for a new version at startup. This is the only network access otterm starts itself.
set-general--update_channel = Update channel
    .desc = Which kind of updates to receive. Beta includes test builds.
set-general--restore_session = Restore previous session
    .desc = Reopens the tabs, panes and folders from the last run.
set-general--confirm_close_running = Confirm before closing
    .desc = Asks before closing a tab whose program is still running.
set-general--remember_window = Remember window position
    .desc = Remembers the window size and position for each display.
set-appearance = Appearance
set-appearance--theme = Dark theme
    .desc = Theme for dark mode, or the theme always when following the system is off.
set-appearance--theme_light = Light theme
    .desc = Theme used when the OS is in light mode.
set-appearance--follow_system = Follow the OS appearance
    .desc = Switches between the light and dark themes with the OS setting.
set-appearance--minimum_contrast = Minimum contrast
    .desc = Text closer to its background than this is adjusted to stay readable. 1 turns it off.
set-appearance--renderer = Rendering
    .desc = How the terminal grid is drawn. Changes apply to panes opened after the change.
set-appearance--layout = Layout
    .desc = A layout preset name, or the name of a saved layout.
set-appearance--ui_scale = UI scale
    .desc = Scale of tabs, panels and dialogs. Terminal text size is set in Font.
set-appearance--assist_bar = Input assist bar
    .desc = Shows a bar under the terminal for explanations and warnings. Auto follows the layout.
set-appearance--blocks = Block style
    .desc = Chooses whether each command is shown with a plain line or a card.
set-appearance--panels = Panel placement
    .desc = Records where each panel is placed. Changes when you drag a panel.
set-appearance--custom_css = Load user.css
    .desc = Loads user.css after the theme to override its appearance.
set-appearance--tabbar = Tab bar
set-appearance--tabbar--position = Tab bar position
    .desc = Places the tab bar at the top, bottom or left, or hides it when only one tab is open.
set-appearance--tabbar--title_idle = Idle tab title
    .desc = Template for the title of an idle tab. Variables such as cwd_name can be used.
set-appearance--tabbar--title_running = Running tab title
    .desc = Template for the title of a tab that runs a command. Variables such as command can be used.
set-appearance--sidebar = Sidebars
set-appearance--sidebar--left = Left sidebar
set-appearance--sidebar--left--visible = Show left sidebar
    .desc = Shows the left sidebar. Auto follows the layout.
set-appearance--sidebar--left--width = Left sidebar width
    .desc = Width of the left sidebar in pixels.
set-appearance--sidebar--right = Right sidebar
set-appearance--sidebar--right--visible = Show right sidebar
    .desc = Shows the right sidebar. Auto follows the layout.
set-appearance--sidebar--right--width = Right sidebar width
    .desc = Width of the right sidebar in pixels.
set-appearance--panel = Panels
set-appearance--panel--bottom = Bottom panel
set-appearance--panel--bottom--visible = Show bottom panel
    .desc = Shows a panel along the bottom of the window. Auto follows the layout.
set-appearance--panel--bottom--height = Bottom panel height
    .desc = Height of the bottom panel in pixels.
set-appearance--statusbar = Status bar
set-appearance--statusbar--visible = Show status bar
    .desc = Shows the status bar at the bottom of the window. Auto follows the layout.
set-appearance--window = Window
set-appearance--window--opacity = Window opacity
    .desc = 1 is fully opaque. Lower values let the background show through.
set-appearance--window--blur = Blur background
    .desc = When the window is translucent, blurs what is behind it to keep text readable.
set-appearance--window--background_image = Background image
    .desc = Path to a local image used as the background. A theme may override it.
set-appearance--window--background_fit = Background image fit
    .desc = How the background image is laid out in the window.
set-appearance--window--background_image_opacity = Background image strength
    .desc = How much the background image shows through the terminal background.
set-appearance--window--padding = Padding
    .desc = Space around the terminal text in pixels.
set-font = Font
set-font--family = Font families
    .desc = Fonts to use, in order of preference. Leave empty to use the OS default.
set-font--size = Font size
    .desc = Terminal font size in pixels. Follows the OS display scale.
set-font--weight = Regular weight
    .desc = Weight of regular text, from 100 to 900.
set-font--weight_bold = Bold weight
    .desc = Weight of bold text, from 100 to 900.
set-font--line_height = Line height
    .desc = Line height as a multiple of the font size.
set-font--letter_spacing = Letter spacing
    .desc = Adjustment to the space between letters. 0 is the standard spacing.
set-font--ligatures = Use ligatures
    .desc = Draws sequences such as "->" as joined glyphs.
set-font--cjk_family = Japanese font
    .desc = Font for CJK characters. Auto picks a font provided by the OS.
set-font--emoji_family = Emoji font
    .desc = Font for emoji. Auto picks a font provided by the OS.
set-terminal = Terminal
set-terminal--scrollback = Scrollback lines
    .desc = Lines kept for each session. 0 means unlimited, with the overflow saved to disk.
set-terminal--scrollback_spill_limit_mb = Scrollback disk limit
    .desc = Total size limit in MB for scrollback saved to disk. The oldest data is removed first.
set-terminal--cursor = Cursor
set-terminal--cursor--style = Cursor shape
    .desc = Chooses a block, underline or bar cursor.
set-terminal--cursor--blink = Blink cursor
    .desc = Makes the cursor blink.
set-terminal--cursor--smooth = Smooth cursor movement
    .desc = Animates cursor movement. Turned off when reduce motion is on.
set-terminal--bell = Bell behavior
    .desc = What happens when a program rings the bell.
set-terminal--copy_on_select = Copy on select
    .desc = Copies selected text to the clipboard as soon as it is selected.
set-terminal--trim_trailing_whitespace = Trim trailing spaces
    .desc = Removes trailing spaces at the end of lines when copying.
set-terminal--confirm_multiline_paste = Confirm multi-line paste
    .desc = Asks before pasting text that contains line breaks. Auto follows the help level.
set-terminal--word_separators = Word separators
    .desc = Characters that end a word when you double-click to select.
set-terminal--ambiguous_width = Ambiguous-width characters
    .desc = Width used for symbols whose width is unclear between half-width and full-width.
set-terminal--osc52_clipboard = Clipboard writes
    .desc = How programs may write to the clipboard.
set-terminal--images = Show images
    .desc = Displays inline images in Sixel, iTerm2 and Kitty formats.
set-terminal--close_behavior = When the shell exits
    .desc = Whether the tab closes, stays open, or restarts when the shell exits.
set-terminal--right_click = Right-click action
    .desc = What a right click does. Auto opens the context menu.
set-terminal--wheel_to_arrows_in_alt_screen = Wheel sends arrow keys
    .desc = In full-screen apps that do not use the mouse, sends wheel scrolling as arrow keys.
set-terminal--kitty_keyboard = Kitty keyboard
    .desc = Uses the Kitty keyboard protocol when an app asks for it.
set-terminal--fold_lines = Fold output longer than
    .desc = Folds the middle of output longer than this many lines. 0 never folds.
set-accessibility = Accessibility
set-accessibility--screen_reader = Screen reader support
    .desc = Lets a screen reader read new terminal output aloud.
set-accessibility--reduce_motion = Reduce motion
    .desc = Turns off animations and transitions. Auto follows the OS setting.
set-accessibility--high_contrast = High contrast
    .desc = Uses the high contrast theme. Auto follows the OS setting.
set-shell = Shell
set-shell--default_profile = Default profile
    .desc = ID of the profile used for new tabs. Leave empty to use the recommended shell.
set-shell--integration = Enable shell integration
    .desc = Turns on blocks, folder tracking and the input line features.
set-shell--integration_install = How integration loads
    .desc = How the integration hooks are loaded into the shell. Passing arguments does not touch your files.
set-shell--prompt = Prompt drawn by
    .desc = Whether otterm draws the prompt or the shell does. Requires shell integration.
set-profiles = Profiles
set-profiles--id = ID
    .desc = Identifier used by the default profile and workspaces.
set-profiles--name = Name
    .desc = Name shown in the menu.
set-profiles--command = Command
    .desc = Program to start.
set-profiles--args = Arguments
    .desc = Arguments passed to the command, in order.
set-profiles--cwd = Starting folder
    .desc = Working folder when a tab opens. Leave empty to use the default.
set-profiles--env = Environment variables
    .desc = Environment variables added only for this profile.
set-profiles--icon = Icon
    .desc = Icon shown on the tab.
set-profiles--color = Tab color
    .desc = Accent color of the tab, in #rrggbb format.
set-profiles--shell_kind = Shell type
    .desc = Type of shell. Leave empty to detect it automatically.
set-profiles--hidden = Hidden
    .desc = Hides the profile from the new tab menu without deleting it.
set-mascot = Mascot (Pebble)
set-mascot--visible = Show Pebble
    .desc = Shows the Pebble mascot. Auto follows the help level.
set-mascot--position = Pebble position
    .desc = Where the mascot sits: the assist bar, the status bar, or floating.
set-mascot--speech = Speech bubbles
    .desc = When the mascot shows speech bubbles. Auto follows the help level.
set-mascot--mood_changes = Mood changes
    .desc = Changes the mascot's expression based on command results.
set-mascot--happy_threshold_ms = Celebrate after
    .desc = The mascot celebrates only when a successful command took at least this many milliseconds.
set-mascot--outfit = Outfit
    .desc = ID of an installed outfit mod.
set-assist = Input assist
set-assist--explain = Command explanations
    .desc = Whether command explanations appear in the assist bar. Auto follows the help level.
set-assist--completion = Completion
    .desc = Shows otterm completion suggestions while you type.
set-assist--completion_key = Completion key
    .desc = Key that accepts a completion. Auto uses Ctrl+Space, or Tab at help level 3.
set-assist--history_key = Ctrl+R handled by
    .desc = Whether otterm or the shell handles Ctrl+R history search.
set-assist--danger_guard = Warn about dangerous commands
    .desc = Shows a warning before running commands such as deletions.
set-assist--error_hint = Error hints
    .desc = Suggests likely causes when a command fails.
set-assist--learn_hints = Action hints
    .desc = Shows the equivalent command after a file action in the GUI. Auto follows the help level.
set-assist--file_tree_cd = Change folder from file tree
    .desc = Sends cd to the shell when a folder is opened in the file tree.
set-open = Opening files
set-open--editor = Editor
    .desc = ID of the editor preset to use. Leave empty to detect one automatically.
set-open--editor_template = Editor command
    .desc = Launch command used when the editor is custom. Variables path, line and col can be used.
set-open--rules = Action by extension
    .desc = Chooses whether each file extension opens in the editor, as a preview, or with the system.
set-open--preview_text_limit_mb = Text preview limit
    .desc = Largest text file that opens as a preview, in MB.
set-open--preview_image_limit_mb = Image preview limit
    .desc = Largest image file that opens as a preview, in MB.
set-history = History
set-history--enabled = Record history
    .desc = Saves executed commands to a SQLite database on this computer.
set-history--retention_days = Keep history for
    .desc = Number of days to keep history. 0 keeps it forever.
set-history--redact_secrets = Hide secrets
    .desc = Replaces secret-looking arguments with masks before saving.
set-keybindings = Keyboard
set-keybindings--bindings = Key bindings
    .desc = Changes the keys for each action. An empty list removes the binding for that action.
set-keybindings--custom = Custom keys
set-keybindings--custom--key = Key
    .desc = Shortcut key, for example ctrl+shift+t.
set-keybindings--custom--command = Command
    .desc = ID of the action to run when the key is pressed.
set-keybindings--custom--args = Action arguments
    .desc = Arguments passed to the action.
set-keybindings--custom--when = Active when
    .desc = Condition under which the key is active, for example terminalFocus && !altScreen.
set-keybindings--alt_screen_passthrough = Pass keys to full-screen apps
    .desc = Sends keys that otterm would handle to full-screen apps as well.
set-mods = Mods
set-mods--enabled = Enabled mods
    .desc = List of IDs of mods to turn on.
set-mods--disabled = Disabled mods
    .desc = List of IDs of mods to turn off.
set-mods--auto_update = Update mods automatically
    .desc = Installs mod updates without asking.
set-mods--developer_mode = Developer mode
    .desc = Shows logs, timings and API calls for each mod in Settings.
set-mods--settings = Mod settings
    .desc = Settings values for each mod. They are checked against the format each mod defines.
set-ai = AI
set-ai--enabled = Enable AI
    .desc = Master switch for AI features. Off by default.
set-ai--provider = AI provider
    .desc = Type of service that returns AI responses.
set-ai--endpoint = Endpoint
    .desc = Base URL for local Ollama or an OpenAI-compatible API.
set-ai--model = Model
    .desc = Model ID for the selected provider.
set-ai--key_ref = Key reference
    .desc = Name of the entry where the API key is stored. The key itself is kept in the OS keychain.
set-ai--preview_first_n = Previews before first sends
    .desc = Shows the full request before sending it, for the first few requests.
set-ai--redact_secrets = Hide secrets
    .desc = Replaces secret-looking text with masks before sending it to AI.
set-ai--log_retention_days = Keep logs for
    .desc = Number of days to keep AI request and response logs. 0 turns logging off.
set-ai--include_recent_commands = Include recent commands
    .desc = Adds the last 5 commands to the context sent to AI.
set-ai--question_prefix = Ask with a ? prefix
    .desc = Lets you ask AI by starting the input line with ?.
setv-dark = Dark
setv-light = Light
setv-auto = Auto
setv-ja = Japanese
setv-en = English
setv-stable = Stable
setv-beta = Beta
setv-webgl = WebGL
setv-canvas = Canvas
setv-top = Top
setv-bottom = Bottom
setv-left = Left
setv-hidden-when-single = Hide when only one tab
setv-plain = Plain
setv-cards = Cards
setv-cover = Cover
setv-contain = Contain
setv-tile = Tile
setv-center = Center
setv-block = Block
setv-underline = Underline
setv-bar = Bar
setv-none = None
setv-visual = Visual flash
setv-sound = Sound
setv-both = Both
setv-narrow = Narrow
setv-wide = Wide
setv-allow = Allow
setv-deny = Deny
setv-ask = Ask
setv-close = Close
setv-keep = Keep
setv-restart = Restart
setv-context-menu = Open context menu
setv-paste = Paste
setv-copy-or-paste = Copy if selected, otherwise paste
setv-args = Pass as arguments
setv-rc = Append to rc file
setv-manual = Manual
setv-otterm = otterm
setv-shell = Shell
setv-bash = Bash
setv-zsh = Zsh
setv-fish = fish
setv-pwsh = PowerShell 7
setv-powershell = Windows PowerShell
setv-cmd = Command Prompt
setv-nushell = Nushell
setv-other = Other
setv-assist-bar = Input assist bar
setv-statusbar = Status bar
setv-float = Floating
setv-hidden = Hidden
setv-always = Always
setv-alert-only = Alerts only
setv-never = Never
setv-ctrl-space = Ctrl+Space
setv-tab = Tab
setv-off = Off
setv-danger-only = Dangerous commands only
setv-local = Local (Ollama)
setv-claude = Claude
setv-openai = OpenAI
setv-gemini = Gemini
setv-openai-compatible = OpenAI-compatible
setv-editor = Editor
setv-preview = Preview
setv-system = System

## Settings screen

settings-title = Settings
settings-categories = Settings categories
settings-search = Search settings
settings-close = Close settings
settings-no-results = No settings match.
settings-reset = Reset to default
settings-restart = Takes effect after a restart.
settings-on = On
settings-off = Off
settings-none = None
settings-add = Add
settings-remove = Remove
settings-move-up = Move up
settings-move-down = Move down
settings-statusbar-order = Status bar order
settings-statusbar-order-hint = You can also drag items on the bar. Each item stays on its side.
settings-cancel = Cancel
settings-key = Key
settings-value = Value
settings-monospace = monospace
settings-cat-general = General
settings-cat-appearance = Appearance
settings-cat-layout = Layout
settings-cat-font = Font
settings-cat-terminal = Terminal
settings-cat-profiles = Shell and profiles
settings-cat-assist = Input assist
settings-cat-mascot = Pebble
settings-cat-keys = Key bindings
settings-cat-mods = Mods
settings-cat-ai = AI
settings-cat-accessibility = Accessibility
settings-cat-advanced = Advanced
settings-theme = Theme
settings-theme-in-use = in use
settings-theme-in-use-light = used in light mode
settings-theme-edit = Edit
settings-theme-customize = Customize
settings-theme-copy-name = { $name } (custom)
settings-theme-import = Import a color file
settings-theme-import-hint = Reads iTerm2, Windows Terminal, VS Code, Alacritty and WezTerm colors.
settings-theme-imported = Imported { $names }.
settings-theme-import-failed = Could not import: { $error }
settings-theme-name = Theme name
settings-theme-appearance = Brightness
settings-theme-terminal-colors = Terminal colors
settings-theme-ui-colors = Window colors (UI tokens)
settings-theme-ui-hint = Colors you leave alone follow the terminal colors.
settings-theme-css = CSS of this theme
settings-theme-save = Save and use
settings-theme-export = Export as a mod
settings-theme-exported = Exported to { $path }.
settings-theme-delete = Delete this theme
settings-theme-color-foreground = Text
settings-theme-color-background = Background
settings-theme-color-cursor = Cursor
settings-theme-color-selection = Selection
settings-theme-ansi-0 = Black
settings-theme-ansi-1 = Red
settings-theme-ansi-2 = Green
settings-theme-ansi-3 = Yellow
settings-theme-ansi-4 = Blue
settings-theme-ansi-5 = Magenta
settings-theme-ansi-6 = Cyan
settings-theme-ansi-7 = White
settings-theme-bright = Bright { $name }
settings-token-bg = Background
settings-token-bg-elevated = Raised surface
settings-token-fg = Text
settings-token-fg-muted = Muted text
settings-token-accent = Accent
settings-token-border = Border
settings-token-danger = Danger
settings-token-success = Success
settings-token-warning = Warning
settings-token-radius = Corner radius
settings-token-font-ui = Window font
settings-bg-pick = Choose a background image
settings-bg-clear = Remove the background image
settings-layout-presets = Layouts
settings-layout-minimal = Minimal
settings-layout-classic = Classic
settings-layout-guided = Guided
settings-layout-ide = IDE
settings-layout-cards = Cards
settings-layout-part-left = left panel
settings-layout-part-right = right panel
settings-layout-part-bottom = bottom panel
settings-layout-part-assist = assist bar
settings-layout-part-status = status bar
settings-layout-part-cards = cards
settings-layout-part-none = terminal only
settings-layout-hint = Change the items below to adjust the chosen layout.
settings-layout-name = Layout name
settings-layout-save = Save the current arrangement
settings-layout-saved = Saved the layout “{ $name }”.
settings-panels = Where panels go
settings-panels-hint = You can also drag a panel's tab.
settings-panels-none = There are no panels yet.
settings-slot-sidebar-left = Left side panel
settings-slot-sidebar-right = Right side panel
settings-slot-panel-bottom = Bottom panel
settings-font-preview = Font preview
settings-font-sample-ja = Japanese: あいうえお 漢字カナ ｶﾅ
settings-font-sample-bold = Bold text 0123456789
settings-keys-filter = Filter actions
settings-keys-none = Unassigned
settings-keys-press = Press a key
settings-keys-record = Record
settings-keys-clear = Unassign
settings-keys-conflict = Same key as another action
settings-keys-custom = Keys with arguments and conditions
settings-keys-custom-hint = Entries from [[keybindings.custom]] in config.toml (key, command, args, when). Shown here only
settings-keys-mods = Keys suggested by mods
settings-keys-mod-lost = Off: otterm or you use the same key. Change one of them in the table above
settings-mod-enabled = Enabled
settings-css = Your CSS (user.css)
settings-css-hint = Shown as you type. Select elements with [data-ot="…"].
settings-css-save = Save
settings-file = Settings file
settings-open-file = Open config.toml in the editor
settings-bundle = Export and import
settings-bundle-hint = Settings, themes, layouts, background images and the mod list in one zip. Importing keeps a backup of the current config.toml beside it
settings-export = Export to zip
settings-import = Import from zip
settings-exported = Exported: { $path }
settings-reset-all = Reset everything
settings-reset-all-hint = Puts config.toml back to the defaults. The current file stays as config.toml.bak-reset-…
settings-reset-category = Reset this category
settings-reset-confirm = Press again to reset
settings-workspace-override = The workspace “{ $name }” overrides this with { $value }. Changes here go to config.toml

## Key binding action names

keyact-tab-new = New tab
keyact-tab-new-profile = New tab with a profile
keyact-tab-close = Close tab
keyact-tab-next = Next tab
keyact-tab-prev = Previous tab
keyact-pane-split-vertical = Split left and right
keyact-pane-split-horizontal = Split top and bottom
keyact-pane-zoom = Zoom pane
keyact-pane-close = Close pane
keyact-window-fullscreen = Full screen
keyact-block-prev = Previous block
keyact-block-next = Next block
keyact-block-collapse = Fold output
keyact-settings = Open settings
keyact-palette = Command palette
keyact-history = Search history
keyact-completion-trigger = Show completions
keyact-multiline-open = Multi-line input
keyact-sidebar-left-toggle = Toggle left panel
keyact-sidebar-right-toggle = Toggle right panel
keyact-panel-bottom-toggle = Toggle bottom panel
keyact-focus-next_region = Focus next region
keyact-focus-prev_region = Focus previous region
keyact-tab-goto-1 = Go to tab 1
keyact-tab-goto-2 = Go to tab 2
keyact-tab-goto-3 = Go to tab 3
keyact-tab-goto-4 = Go to tab 4
keyact-tab-goto-5 = Go to tab 5
keyact-tab-goto-6 = Go to tab 6
keyact-tab-goto-7 = Go to tab 7
keyact-tab-goto-8 = Go to tab 8
keyact-tab-goto-9 = Go to tab 9
keyact-pane-focus-left = Focus pane left
keyact-pane-resize-left = Resize pane left
keyact-pane-focus-right = Focus pane right
keyact-pane-resize-right = Resize pane right
keyact-pane-focus-up = Focus pane up
keyact-pane-resize-up = Resize pane up
keyact-pane-focus-down = Focus pane down
keyact-pane-resize-down = Resize pane down
keyact-copy = Copy
keyact-paste = Paste
keyact-search = Search
keyact-font-bigger = Bigger text
keyact-font-smaller = Smaller text
keyact-font-reset = Reset text size
keyact-ai-ask = Ask Pebble (AI)
keyact-mascot-toggle = Show or hide Pebble
keyact-guide-help_mode = Help mode
keyact-clear = Clear the screen
