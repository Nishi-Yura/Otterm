# otterm shell integration for PowerShell (decision B6: loaded through the start arguments; no
# user file is changed). It reports the working directory (OSC 7), so new tabs and splits open
# where you are, and resets the Kitty keyboard flags at each prompt. OSC 133 comes with M2.
#
# It runs after your profile. With shell.prompt = "otterm" (decision M4) it replaces the prompt:
# otterm draws the folder and the Git branch as a bar of its own UI, and the shell prints only ❯.
# With "shell" it wraps whatever prompt the profile set up (oh-my-posh too).
# otterm puts `$global:__OttermPromptMode = 'otterm' | 'shell'` in front of this script.

if ($env:OTTERM -and -not $global:__OttermIntegration) {
    $global:__OttermIntegration = $true
    $global:__OttermOriginalPrompt = $function:prompt
    $global:__OttermLastHistory = (Get-History -Count 1).Id

    # OSC 7 and the Kitty reset, in front of every prompt.
    function global:__OttermReport {
        $esc = [char]27
        $report = ''
        $location = $executionContext.SessionState.Path.CurrentLocation
        if ($location.Provider.Name -eq 'FileSystem') {
            # file:///C:/Users/you/project, percent-encoded.
            $uri = ([System.Uri]$location.ProviderPath).AbsoluteUri
            $report = "$esc]7;$uri$esc\"
        }
        # A program that crashed with the Kitty keyboard protocol on would leave Ctrl+C and friends
        # encoded for it (issue #6); PowerShell never turns it on, so drop whatever is left.
        $report + "$esc[<99u"
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
            $out = ''
            # The command that just ended, if one ran (an empty Enter adds no history).
            $last = Get-History -Count 1
            if ($last -and $last.Id -ne $global:__OttermLastHistory) {
                $global:__OttermLastHistory = $last.Id
                $exit = if ($ok) { 0 } elseif ($code) { $code } else { 1 }
                $ms = [uint32][Math]::Min([uint32]::MaxValue, ($last.EndExecutionTime - $last.StartExecutionTime).TotalMilliseconds)
                $out += "$esc]7777;done;$exit;$ms$esc\"
            }
            $location = $executionContext.SessionState.Path.CurrentLocation
            $info = @{ cwd = $location.Path; home = $HOME; branch = '' }
            if ($location.Provider.Name -eq 'FileSystem') {
                $info.cwd = $location.ProviderPath
                $info.branch = __OttermGitBranch $location.ProviderPath
            }
            $json = ConvertTo-Json $info -Compress
            $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
            $out += (__OttermReport) + "$esc]7777;bar;$b64$esc\"
            # The bar's row, then the line you type on.
            $color = if ($ok) { '36' } else { '31' }
            $out + "`r`n$esc[1;${color}m❯$esc[0m "
        }
    } else {
        function global:prompt {
            (__OttermReport) + (& $global:__OttermOriginalPrompt)
        }
    }
}
