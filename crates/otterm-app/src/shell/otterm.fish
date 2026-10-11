# otterm shell integration for fish (decision B6: loaded through the start arguments; no user file
# is changed). otterm starts fish with `--init-command 'source <this file>'`, which runs after
# config.fish, so the user's own prompt and settings are already in place.
#
# Before each prompt it sends OSC 133;D (exit status, only if a command ran), OSC 133;A, OSC 7
# (working directory) and the Kitty keyboard reset. With shell.prompt = "otterm" it also sends
# OSC 7777;bar and draws its own prompt; the original fish_prompt is kept as
# __otterm_original_prompt. When a command line is accepted it sends OSC 7777;cmd and OSC 133;C.
# The prompt ends with OSC 133;B.
#
# Note: in otterm mode the right prompt (fish_right_prompt) is left as the user set it.

if set -q OTTERM; and not set -q OTTERM_SHELL_INTEGRATION
    set -g __OTTERM_CMD_RUNNING 0
    # Computed once: running hostname at every prompt would cost a fork.
    set -g __OTTERM_HOST (command hostname 2>/dev/null)
    if test "$OTTERM_PROMPT" = otterm
        set -g __OTTERM_PROMPT_MODE otterm
    else
        set -g __OTTERM_PROMPT_MODE shell
    end

    # Prints the percent-encoded path $argv[1], keeping "/". string escape --style=url encodes
    # every byte outside the unreserved set, so the slashes are put back afterwards.
    function __otterm_urlpath
        string escape --style=url -- $argv[1] | string replace -a '%2F' '/'
    end

    # Prints $argv[1] with backslash and double quote escaped for a JSON string.
    function __otterm_jsonstr
        string replace -a '\\' '\\\\' -- $argv[1] | string replace -a '"' '\"'
    end

    # Prints the base64 of $argv[1] on one line (macOS base64 has no -w0).
    function __otterm_b64
        printf '%s' $argv[1] | base64 | tr -d '\n'
    end

    # Prints the Git branch of the repository holding $argv[1], the short commit when detached, or
    # nothing. Reads the HEAD file directly: starting git on every prompt would add latency.
    function __otterm_git_branch
        set -l dir $argv[1]
        set -l head ''
        while true
            if test -d "$dir/.git"
                set head "$dir/.git/HEAD"
                break
            end
            if test -f "$dir/.git"
                # A worktree or submodule: ".git" is a file holding "gitdir: <path>".
                read -l line < "$dir/.git"
                if not string match -q 'gitdir: *' -- $line
                    return
                end
                set -l target (string replace 'gitdir: ' '' -- $line)
                if not string match -qr '^(/|[A-Za-z]:)' -- $target
                    set target "$dir/$target"
                end
                set head "$target/HEAD"
                break
            end
            if test "$dir" = /
                break
            end
            set dir (string replace -r '/[^/]*$' '' -- $dir)
            test -n "$dir"; or set dir /
        end

        if test -z "$head"; or not test -r "$head"
            return
        end
        read -l ref < "$head"
        if string match -q 'ref: refs/heads/*' -- $ref
            string replace 'ref: refs/heads/' '' -- $ref
        else if string match -q 'ref: *' -- $ref
            return
        else
            string sub -l 7 -- $ref
        end
    end

    # Puts the status back, so the original prompt reads the command's $status.
    function __otterm_restore_status
        return $argv[1]
    end

    # Sends the preexec sequences. $argv[1] is the command line as typed; an empty Enter runs
    # nothing and sends nothing.
    function __otterm_preexec --on-event fish_preexec
        if not string match -qr '\S' -- $argv[1]
            return
        end
        set -g __OTTERM_CMD_RUNNING 1
        set -l b64 (__otterm_b64 $argv[1])
        printf '\e]7777;cmd;%s\e\\\e]133;C\e\\' "$b64"
    end

    # Keep the user's prompt under another name, so both modes can call it.
    functions -c fish_prompt __otterm_original_prompt

    function fish_prompt
        # Must stay the first statement: $status is the status of the command that just ran.
        set -l st $status
        if test "$__OTTERM_CMD_RUNNING" = 1
            printf '\e]133;D;%s\e\\' $st
            set -g __OTTERM_CMD_RUNNING 0
        end
        printf '\e]133;A\e\\'
        set -l enc (__otterm_urlpath "$PWD")
        # OSC 7, then the Kitty reset: a crashed TUI may have left keyboard modes on (see otterm.ps1).
        printf '\e]7;file://%s%s\e\\\e[<99u' "$__OTTERM_HOST" "$enc"

        if test "$__OTTERM_PROMPT_MODE" = otterm
            set -l branch (__otterm_git_branch "$PWD")
            set -l cwd (__otterm_jsonstr "$PWD")
            set -l home (__otterm_jsonstr "$HOME")
            set -l bname (__otterm_jsonstr "$branch")
            set -l json "{\"cwd\":\"$cwd\",\"home\":\"$home\",\"branch\":\"$bname\"}"
            set -l b64 (__otterm_b64 "$json")
            printf '\e]7777;bar;%s\e\\' "$b64"
            # A newline, then the chevron (red after a failed command), then the end of the prompt.
            if test "$st" = 0
                printf '\n\e[1;36m❯\e[0m \e]133;B\e\\'
            else
                printf '\n\e[1;31m❯\e[0m \e]133;B\e\\'
            end
        else
            __otterm_restore_status $st
            __otterm_original_prompt
            printf '\e]133;B\e\\'
        end
    end

    set -gx OTTERM_SHELL_INTEGRATION 1
end
