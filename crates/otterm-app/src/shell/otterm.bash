# otterm shell integration for bash (decision B6: loaded through the start arguments; no user
# file is changed). otterm starts bash with `--rcfile <this file>`, which replaces ~/.bashrc, so
# this file first sources the user's own startup files the way bash would have, and only then
# installs the hooks.
#
# Before each prompt it sends OSC 133;D (exit status, only if a command ran), OSC 133;A, OSC 7
# (working directory) and the Kitty keyboard reset. With shell.prompt = "otterm" it also sends
# OSC 7777;bar, and draws its own prompt. When a command line starts it sends OSC 7777;cmd and
# OSC 133;C. The prompt ends with OSC 133;B, so the terminal knows where the input begins.
#
# Limitation: bash only exposes the simple command being run ($BASH_COMMAND). For a line such as
# `cd x && make` the recorded command text is the first simple command (`cd x`). zsh and fish
# get the whole line.

# Only inside otterm, and only once. __OTTERM_LOADING stops a user rc file that sources this file
# from loading it again.
if [[ -n ${OTTERM:-} && -z ${OTTERM_SHELL_INTEGRATION:-} && -z ${__OTTERM_LOADING:-} ]]; then
    __OTTERM_LOADING=1

    # Emulate what bash would have read without --rcfile. otterm removed -l/--login from the
    # arguments, so OTTERM_SHELL_LOGIN says the shell was a login shell.
    if [[ -n ${OTTERM_SHELL_LOGIN:-} ]]; then
        if [[ -r /etc/profile ]]; then
            source /etc/profile
        fi
        for __otterm_rc in ~/.bash_profile ~/.bash_login ~/.profile; do
            # shell.user_startup_files off (decision M24): only the system files above.
            if [[ ${OTTERM_USER_STARTUP:-1} == 0 ]]; then
                break
            fi
            if [[ -r $__otterm_rc ]]; then
                source "$__otterm_rc"
                break
            fi
        done
        unset __otterm_rc
    else
        # /etc/bash.bashrc is Debian's system-wide interactive rc; absent elsewhere, which is fine.
        if [[ -r /etc/bash.bashrc ]]; then
            source /etc/bash.bashrc
        fi
        if [[ ${OTTERM_USER_STARTUP:-1} != 0 && -r ~/.bashrc ]]; then
            source ~/.bashrc
        fi
    fi

    __OTTERM_PROMPT_MODE=${OTTERM_PROMPT:-shell}
    # Computed once: running hostname at every prompt would cost a fork.
    __OTTERM_HOST=${HOSTNAME:-${HOST:-$(hostname 2>/dev/null)}}
    __OTTERM_STATUS=0
    __OTTERM_CMD_RUNNING=
    __OTTERM_IN_PRECMD=

    # otterm mode: a newline, then the chevron (red after a failed command), then OSC 133;B.
    # PS1 escapes: \e is ESC, \\ a backslash, \[ and \] mark the non-printing parts.
    __OTTERM_PS1_OK='\n\[\e[1;36m\]❯\[\e[0m\] \[\e]133;B\e\\\]'
    __OTTERM_PS1_FAIL='\n\[\e[1;31m\]❯\[\e[0m\] \[\e]133;B\e\\\]'
    # shell mode: the user's PS1 is kept and this is appended to it.
    __OTTERM_PS1_END='\[\e]133;B\e\\\]'

    # Sets REPLY to $1 percent-encoded, keeping the unreserved set and "/". LC_ALL=C makes the
    # loop work on bytes, so a UTF-8 directory name is escaped byte by byte.
    __otterm_urlencode() {
        local LC_ALL=C s=$1 out='' c hex i
        case $s in
            *[!a-zA-Z0-9/._~-]*) ;;
            *) REPLY=$s; return 0 ;;
        esac
        for (( i = 0; i < ${#s}; i++ )); do
            c=${s:i:1}
            case $c in
                [a-zA-Z0-9/._~-]) out+=$c ;;
                *) printf -v hex '%%%02X' "'$c"; out+=$hex ;;
            esac
        done
        REPLY=$out
    }

    # Sets REPLY to $1 with backslash and double quote escaped for a JSON string.
    __otterm_json_escape() {
        local s=$1 bs='\' q='"'
        s=${s//"$bs"/"$bs$bs"}
        s=${s//"$q"/"$bs$q"}
        REPLY=$s
    }

    # Sets REPLY to the base64 of $1 without line breaks (macOS base64 has no -w0).
    __otterm_b64() {
        REPLY=$(printf '%s' "$1" | base64 | tr -d '\n')
    }

    # Sets REPLY to the Git branch of $PWD, the short commit when detached, or "". Reads the HEAD
    # file directly: starting git on every prompt would add noticeable latency.
    __otterm_git_branch() {
        local dir=$PWD head='' line target ref
        while :; do
            if [[ -d $dir/.git ]]; then
                head=$dir/.git/HEAD
                break
            fi
            if [[ -f $dir/.git ]]; then
                # A worktree or submodule: ".git" is a file holding "gitdir: <path>".
                IFS= read -r line < "$dir/.git"
                if [[ $line != 'gitdir: '* ]]; then
                    REPLY=''
                    return 0
                fi
                target=${line#gitdir: }
                if [[ $target != /* && $target != [A-Za-z]:* ]]; then
                    target=$dir/$target
                fi
                head=$target/HEAD
                break
            fi
            if [[ $dir == / ]]; then
                break
            fi
            dir=${dir%/*}
            dir=${dir:-/}
        done

        REPLY=''
        if [[ -z $head || ! -r $head ]]; then
            return 0
        fi
        IFS= read -r ref < "$head"
        ref=${ref%$'\r'}
        case $ref in
            'ref: refs/heads/'*) REPLY=${ref#ref: refs/heads/} ;;
            'ref: '*) REPLY='' ;;
            *) REPLY=${ref:0:7} ;;
        esac
    }

    # First PROMPT_COMMAND entry. Captures the exit status before anything else runs, reports the
    # end of the previous command, and returns the status so the user's own entries still see $?.
    __otterm_precmd_start() {
        # Must stay the first statement: any command before it would overwrite $?.
        __OTTERM_STATUS=$?
        __OTTERM_IN_PRECMD=1
        if [[ -n $__OTTERM_CMD_RUNNING ]]; then
            printf '\033]133;D;%s\033\\' "$__OTTERM_STATUS"
            __OTTERM_CMD_RUNNING=
        fi
        return "$__OTTERM_STATUS"
    }

    # Last PROMPT_COMMAND entry. It runs after the user's entries, so the prompt set here is the
    # one that is shown, even if their entries rebuilt PS1.
    __otterm_precmd_end() {
        local st=$__OTTERM_STATUS enc branch cwd home
        printf '\033]133;A\033\\'
        __otterm_urlencode "$PWD"
        enc=$REPLY
        # OSC 7, then the Kitty reset: a crashed TUI may have left keyboard modes on (see otterm.ps1).
        printf '\033]7;file://%s%s\033\\\033[<99u' "$__OTTERM_HOST" "$enc"
        if [[ $__OTTERM_PROMPT_MODE == otterm ]]; then
            __otterm_git_branch
            branch=$REPLY
            __otterm_json_escape "$PWD"
            cwd=$REPLY
            __otterm_json_escape "$HOME"
            home=$REPLY
            __otterm_json_escape "$branch"
            branch=$REPLY
            __otterm_b64 "{\"cwd\":\"$cwd\",\"home\":\"$home\",\"branch\":\"$branch\"}"
            printf '\033]7777;bar;%s\033\\' "$REPLY"
            if (( st )); then
                PS1=$__OTTERM_PS1_FAIL
            else
                PS1=$__OTTERM_PS1_OK
            fi
        else
            # Append OSC 133;B to the user's prompt, unless it is already there (the user's
            # PROMPT_COMMAND may have rebuilt PS1 from scratch).
            if [[ $PS1 != *"$__OTTERM_PS1_END" ]]; then
                PS1+=$__OTTERM_PS1_END
            fi
        fi
        __OTTERM_IN_PRECMD=
        return "$st"
    }

    # DEBUG trap: runs before every simple command. Only the first command of a line is the one
    # the user typed. The rest, and everything the prompt code runs, are ignored.
    __otterm_debug() {
        local cmd=$BASH_COMMAND
        # A DEBUG trap the user already had (saved at load time) keeps running for every command.
        if [[ -n $__OTTERM_CHAIN ]]; then
            eval "eval $__OTTERM_CHAIN"
        fi
        if [[ -n $__OTTERM_IN_PRECMD || -n $__OTTERM_CMD_RUNNING ]]; then
            return 0
        fi
        case $cmd in
            __otterm_*) return 0 ;;
        esac
        __OTTERM_CMD_RUNNING=1
        __otterm_b64 "$cmd"
        printf '\033]7777;cmd;%s\033\\\033]133;C\033\\' "$REPLY"
        return 0
    }

    # Keep an existing DEBUG trap: trap -p prints "trap -- '<command>' DEBUG"; keep the quoted
    # command, which __otterm_debug evaluates. bash has one DEBUG slot, so chaining is the only way
    # to keep bash-preexec-style tools working.
    __OTTERM_CHAIN=
    __otterm_saved=$(trap -p DEBUG)
    if [[ -n $__otterm_saved ]]; then
        __otterm_saved=${__otterm_saved#trap -- }
        __OTTERM_CHAIN=${__otterm_saved% DEBUG}
    fi
    unset __otterm_saved

    # Our two entries go around the user's: the first captures $?, the last draws the prompt.
    # bash 5.1+ keeps PROMPT_COMMAND as an array; older bash has a string.
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
        PROMPT_COMMAND=(__otterm_precmd_start "${PROMPT_COMMAND[@]}" __otterm_precmd_end)
    else
        PROMPT_COMMAND="__otterm_precmd_start${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __otterm_precmd_end"
    fi

    export OTTERM_SHELL_INTEGRATION=1
    unset __OTTERM_LOADING

    # Installed last: any simple command run after this point would be reported as a user command.
    # shopt extdebug is left off, so the trap never skips a command.
    trap '__otterm_debug' DEBUG
fi
