# otterm shell integration for zsh (decision B6: loaded through ZDOTDIR; no user file is
# changed). The .zshrc in the zsh directory sources this after the user's own .zshrc, so the
# prompt set here wins over the user's theme settings.
#
# Before each prompt it sends OSC 133;D (exit status, only if a command ran), OSC 133;A, OSC 7
# (working directory) and the Kitty keyboard reset. With shell.prompt = "otterm" it also sends
# OSC 7777;bar and draws its own prompt. When a command line is accepted it sends OSC 7777;cmd
# and OSC 133;C. The prompt ends with OSC 133;B. preexec gets the whole line, so unlike bash the
# recorded command text is complete.

if [[ -n $OTTERM && -z $OTTERM_SHELL_INTEGRATION ]]; then

    __OTTERM_ESC=$'\e'
    __OTTERM_ST=$'\e\\'
    __OTTERM_PROMPT_MODE=${OTTERM_PROMPT:-shell}
    # Computed once: running hostname at every prompt would cost a fork.
    __OTTERM_HOST=${HOST:-${HOSTNAME:-$(hostname 2>/dev/null)}}
    __OTTERM_STATUS=0
    __OTTERM_CMD_RUNNING=0
    # Ends the prompt. %{ %} keeps it out of the width count; PROMPT_SUBST is not needed.
    __OTTERM_B="%{${__OTTERM_ESC}]133;B${__OTTERM_ST}%}"

    # Sets REPLY to $1 percent-encoded, keeping the unreserved set and "/". LC_ALL=C makes the
    # loop work on bytes, so a UTF-8 directory name is escaped byte by byte.
    __otterm_urlencode() {
        emulate -L zsh
        local LC_ALL=C s=$1 out='' c hex i
        if [[ $s != *[!A-Za-z0-9/._~-]* ]]; then
            REPLY=$s
            return 0
        fi
        for (( i = 1; i <= ${#s}; i++ )); do
            c=${s[i]}
            case $c in
                [A-Za-z0-9/._~-]) out+=$c ;;
                *) printf -v hex '%%%02X' "'$c"; out+=$hex ;;
            esac
        done
        REPLY=$out
    }

    # Sets REPLY to $1 with backslash and double quote escaped for a JSON string.
    __otterm_json_escape() {
        emulate -L zsh
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
        emulate -L zsh
        local dir=$PWD head='' line target ref
        while true; do
            if [[ -d $dir/.git ]]; then
                head=$dir/.git/HEAD
                break
            fi
            if [[ -f $dir/.git ]]; then
                # A worktree or submodule: ".git" is a file holding "gitdir: <path>".
                read -r line < "$dir/.git"
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
            dir=${dir:h}
        done

        REPLY=''
        if [[ -z $head || ! -r $head ]]; then
            return 0
        fi
        read -r ref < "$head"
        ref=${ref%$'\r'}
        case $ref in
            'ref: refs/heads/'*) REPLY=${ref#ref: refs/heads/} ;;
            'ref: '*) REPLY='' ;;
            *) REPLY=${ref[1,7]} ;;
        esac
    }

    # First precmd hook (prepended below). Captures $? before anything else runs and reports the
    # end of the previous command. It returns the status so later hooks still see it.
    __otterm_precmd_start() {
        # Must stay the first statement: any command before it would overwrite $?.
        __OTTERM_STATUS=$?
        if (( __OTTERM_CMD_RUNNING )); then
            printf '%s' "${__OTTERM_ESC}]133;D;${__OTTERM_STATUS}${__OTTERM_ST}"
            __OTTERM_CMD_RUNNING=0
        fi
        return $__OTTERM_STATUS
    }

    # Last precmd hook (appended with add-zsh-hook). It runs after the user's hooks, so the prompt
    # set here is the one shown, even if their hooks rebuilt PROMPT.
    __otterm_precmd_end() {
        emulate -L zsh
        local st=$__OTTERM_STATUS enc branch cwd home color
        printf '%s' "${__OTTERM_ESC}]133;A${__OTTERM_ST}"
        __otterm_urlencode "$PWD"
        enc=$REPLY
        # OSC 7, then the Kitty reset: a crashed TUI may have left keyboard modes on (see otterm.ps1).
        printf '%s' "${__OTTERM_ESC}]7;file://${__OTTERM_HOST}${enc}${__OTTERM_ST}${__OTTERM_ESC}[<99u"
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
            printf '%s' "${__OTTERM_ESC}]7777;bar;${REPLY}${__OTTERM_ST}"
            if (( st )); then
                color=31
            else
                color=36
            fi
            # A newline, then the chevron in bold color, then the end of the prompt.
            PROMPT=$'\n'"%{${__OTTERM_ESC}[1;${color}m%}❯%{${__OTTERM_ESC}[0m%} ${__OTTERM_B}"
            RPROMPT=''
        elif [[ $PROMPT != *"$__OTTERM_B" ]]; then
            # shell mode: keep the user's prompt and add OSC 133;B at its end, once.
            PROMPT+=$__OTTERM_B
        fi
        return $st
    }

    # preexec gets the command line as typed in $1. Enter on an empty line runs nothing, so it
    # sends nothing.
    __otterm_preexec() {
        emulate -L zsh
        [[ $1 == *[![:space:]]* ]] || return 0
        __OTTERM_CMD_RUNNING=1
        __otterm_b64 "$1"
        printf '%s' "${__OTTERM_ESC}]7777;cmd;${REPLY}${__OTTERM_ST}${__OTTERM_ESC}]133;C${__OTTERM_ST}"
    }

    # The line as zle holds it, after every change (method A of docs/02 §6): OSC 7777 line with
    # the cursor and the percent-encoded buffer. Percent-encoding is done in zsh, so a keystroke
    # costs no fork; unchanged buffers send nothing.
    __OTTERM_LAST_LINE=
    __otterm_line() {
        emulate -L zsh
        local state="$CURSOR;$BUFFER"
        [[ $state == "$__OTTERM_LAST_LINE" ]] && return 0
        __OTTERM_LAST_LINE=$state
        __otterm_urlencode "$BUFFER"
        printf '%s' "${__OTTERM_ESC}]7777;line;${CURSOR};${REPLY}${__OTTERM_ST}" > /dev/tty
    }
    __otterm_line_init() {
        __OTTERM_LAST_LINE=
        __otterm_line
    }
    # add-zle-hook-widget arrived in zsh 5.3; older shells fall back to reading the screen.
    if autoload -Uz add-zle-hook-widget 2>/dev/null; then
        add-zle-hook-widget line-pre-redraw __otterm_line
        add-zle-hook-widget line-init __otterm_line_init
    fi

    autoload -Uz add-zsh-hook
    add-zsh-hook precmd __otterm_precmd_end
    add-zsh-hook preexec __otterm_preexec
    # Prepend the status hook, so $? is still the command's status when it runs.
    precmd_functions=(__otterm_precmd_start $precmd_functions)

    export OTTERM_SHELL_INTEGRATION=1
fi
