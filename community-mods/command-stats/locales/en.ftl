# nishi-yura.command-stats (English)

panel-title = Command stats
cmd-open = Open command stats
cmd-reset = Clear command stats
heading-today = Today
count-today = { $n ->
    [one] { $n } command
   *[other] { $n } commands
}
heading-recent = Last { $days } days
count-recent = { $n ->
    [one] { $n } command
   *[other] { $n } commands
} over { $days ->
    [one] { $days } day
   *[other] { $days } days
}
heading-top = Most used programs
empty = Nothing counted yet. Run a command in a shell with shell integration.
note-privacy = Only program names are counted. Arguments and output are never stored, and nothing leaves this PC.
reset-title = Clear command stats?
reset-body = Every count kept by this mod is deleted. This cannot be undone.
reset-confirm = Clear
reset-cancel = Cancel
