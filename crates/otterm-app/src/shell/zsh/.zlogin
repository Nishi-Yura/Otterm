# otterm's ZDOTDIR for zsh: last startup stage of a login shell. See .zshenv for the hand-over.
# Restores ZDOTDIR to the user's, so nested shells and .zlogout behave as without otterm.

ZDOTDIR=${OTTERM_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zlogin ]] && builtin source $ZDOTDIR/.zlogin

unset __OTTERM_ZDOTDIR
