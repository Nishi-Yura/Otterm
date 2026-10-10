# otterm shell integration for PowerShell (decision B6: loaded through the start arguments; no
# user file is changed). For now it only reports the working directory (OSC 7), so new tabs and
# splits open where you are. The rest of the integration (OSC 133) comes with M2.
#
# It runs after your profile, so it wraps whatever prompt the profile set up (oh-my-posh too).

if ($env:OTTERM -and -not $global:__OttermIntegration) {
    $global:__OttermIntegration = $true
    $global:__OttermOriginalPrompt = $function:prompt

    function global:prompt {
        $location = $executionContext.SessionState.Path.CurrentLocation
        $report = ''
        if ($location.Provider.Name -eq 'FileSystem') {
            # file:///C:/Users/you/project, percent-encoded.
            $uri = ([System.Uri]$location.ProviderPath).AbsoluteUri
            $report = "$([char]27)]7;$uri$([char]27)\"
        }
        $report + (& $global:__OttermOriginalPrompt)
    }
}
