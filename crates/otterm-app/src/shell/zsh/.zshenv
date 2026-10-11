# otterm's ZDOTDIR for zsh (decision B6: loaded through ZDOTDIR; no user file is changed).
# otterm points ZDOTDIR at this directory and sets OTTERM_USER_ZDOTDIR to the user's own ZDOTDIR
# (or $HOME). Each of the four files here sources the user's file of the same name, so the user's
# config runs unchanged.
#
# zsh reads the next startup file from $ZDOTDIR, so ZDOTDIR must point here until the last of our
# files has run; otherwise the otterm hook in .zshrc would be skipped. Each file therefore sets
# ZDOTDIR to the user's while it sources their file and back to this directory only when another
# of our files is still to come. The last one leaves ZDOTDIR as the user's.

__OTTERM_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${OTTERM_USER_ZDOTDIR:-$HOME}
[[ ${OTTERM_USER_STARTUP:-1} != 0 && -f $ZDOTDIR/.zshenv ]] && builtin source $ZDOTDIR/.zshenv

# .zprofile (login), .zshrc (interactive) or .zlogin (login) is still to be read.
if [[ -o login || -o interactive ]]; then
    ZDOTDIR=$__OTTERM_ZDOTDIR
fi
