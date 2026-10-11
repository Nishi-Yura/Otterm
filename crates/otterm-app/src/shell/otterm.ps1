# otterm shell integration for PowerShell (decision B6: loaded through the start arguments; no
# user file is changed; docs/03 §6). It sends:
#   OSC 133 A / B      the prompt starts / the user types from here
#   OSC 7777 cmd, 133 C  the command line, then the command runs (needs PSReadLine)
#   OSC 7777 done      the command ended: exit code and duration (from the history entry)
#   OSC 7              the working directory, so new tabs and splits open where you are
# and resets the Kitty keyboard flags at each prompt.
#
# It runs after your profile. With OTTERM_PROMPT=otterm (decision M4) it replaces the prompt:
# otterm draws the folder and the Git branch as a bar of its own UI, and the shell prints only ❯.
# With OTTERM_PROMPT=shell it wraps whatever prompt the profile set up (oh-my-posh too).

if ($env:OTTERM -and -not $env:OTTERM_SHELL_INTEGRATION) {
    $env:OTTERM_SHELL_INTEGRATION = '1'
    $global:__OttermPromptMode = if ($env:OTTERM_PROMPT -eq 'otterm') { 'otterm' } else { 'shell' }
    $global:__OttermOriginalPrompt = $function:prompt
    $global:__OttermLastHistory = (Get-History -Count 1).Id

    # What goes in front of every prompt: the end of the last command, OSC 133 A, OSC 7 and the
    # Kitty reset. $ok and $code are $? and $LASTEXITCODE as the prompt function saw them.
    function global:__OttermPrefix([bool]$ok, $code) {
        $esc = [char]27
        $out = ''
        # The command that just ended, if one ran (an empty Enter adds no history).
        $last = Get-History -Count 1
        if ($last -and $last.Id -ne $global:__OttermLastHistory) {
            $global:__OttermLastHistory = $last.Id
            $exit = if ($ok) { 0 } elseif ($code) { $code } else { 1 }
            $ms = [uint32][Math]::Min([uint32]::MaxValue, ($last.EndExecutionTime - $last.StartExecutionTime).TotalMilliseconds)
            $out += "$esc]7777;done;$exit;$ms$esc\"
        }
        $out += "$esc]133;A$esc\"
        $location = $executionContext.SessionState.Path.CurrentLocation
        if ($location.Provider.Name -eq 'FileSystem') {
            # file:///C:/Users/you/project, percent-encoded.
            $uri = ([System.Uri]$location.ProviderPath).AbsoluteUri
            $out += "$esc]7;$uri$esc\"
        }
        # A program that crashed with the Kitty keyboard protocol on would leave Ctrl+C and friends
        # encoded for it (issue #6); PowerShell never turns it on, so drop whatever is left.
        $out + "$esc[<99u"
    }

    # The branch (or the short commit when detached) of the repository holding $dir. Reads
    # .git/HEAD instead of starting git, which would add tens of milliseconds to every prompt.
    function global:__OttermGitBranch([string]$dir) {
        while ($dir) {
            $git = Join-Path $dir '.git'
            if (Test-Path -LiteralPath $git -PathType Container) {
                $head = Join-Path $git 'HEAD'
                break
            }
            if (Test-Path -LiteralPath $git -PathType Leaf) {
                # A worktree or submodule: ".git" is a file that says "gitdir: <path>".
                $line = Get-Content -LiteralPath $git -TotalCount 1
                if ($line -notmatch '^gitdir: (.+)$') { return '' }
                $target = $Matches[1]
                if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $dir $target }
                $head = Join-Path $target 'HEAD'
                break
            }
            $dir = Split-Path -Parent $dir
        }
        if (-not $head -or -not (Test-Path -LiteralPath $head)) { return '' }
        $ref = Get-Content -LiteralPath $head -TotalCount 1
        if ($ref -match '^ref: refs/heads/(.+)$') { return $Matches[1] }
        if ($ref.Length -ge 7) { return $ref.Substring(0, 7) }
        ''
    }

    if ($global:__OttermPromptMode -eq 'otterm') {
        # oh-my-posh redraws the previous prompt on Enter (transient prompt) by calling the prompt
        # function again, which would print a second bar. Its prompt is not shown here anyway.
        if ($env:POSH_SESSION_ID -and (Get-Module PSReadLine)) {
            Set-PSReadLineKeyHandler -Chord Enter -Function AcceptLine
            Set-PSReadLineKeyHandler -Chord Ctrl+c -Function CopyOrCancelLine
        }
        if (Get-Module PSReadLine) {
            # The bar's row is the prompt's first line; PSReadLine colors ❯ red on a syntax error.
            Set-PSReadLineOption -ExtraPromptLineCount 1 -PromptText '❯ '
        }

        function global:prompt {
            $ok = $?
            $code = $global:LASTEXITCODE
            $esc = [char]27
            $out = __OttermPrefix $ok $code
            $location = $executionContext.SessionState.Path.CurrentLocation
            $info = @{ cwd = $location.Path; home = $HOME; branch = '' }
            if ($location.Provider.Name -eq 'FileSystem') {
                $info.cwd = $location.ProviderPath
                $info.branch = __OttermGitBranch $location.ProviderPath
            }
            $json = ConvertTo-Json $info -Compress
            $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
            $out += "$esc]7777;bar;$b64$esc\"
            # The bar's row, then the line you type on.
            $color = if ($ok) { '36' } else { '31' }
            $out + "`r`n$esc[1;${color}m❯$esc[0m $esc]133;B$esc\"
        }
    } else {
        function global:prompt {
            $ok = $?
            $code = $global:LASTEXITCODE
            $esc = [char]27
            (__OttermPrefix $ok $code) + (& $global:__OttermOriginalPrompt) + "$esc]133;B$esc\"
        }
    }

    # The console host reads each line through PSConsoleHostReadLine when PSReadLine defines it;
    # wrapping it is the one place that sees the line right before it runs. Windows PowerShell
    # without PSReadLine gets no 133 C; the block still ends with 7777 done.
    if (Get-Module PSReadLine) {
        $global:__OttermOriginalReadLine = $function:PSConsoleHostReadLine
        function global:PSConsoleHostReadLine {
            $line = & $global:__OttermOriginalReadLine
            if ($line -and $line.Trim()) {
                $esc = [char]27
                $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($line))
                # Straight to the console: Write-Host would add a newline.
                [Console]::Write("$esc]7777;cmd;$b64$esc\$esc]133;C$esc\")
            }
            $line
        }
    }
}
