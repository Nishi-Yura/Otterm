# otterm's ZDOTDIR for zsh: login stage. See .zshenv for how the stages hand over ZDOTDIR.

ZDOTDIR=${OTTERM_USER_ZDOTDIR:-$HOME}
[[ ${OTTERM_USER_STARTUP:-1} != 0 && -f $ZDOTDIR/.zprofile ]] && builtin source $ZDOTDIR/.zprofile

# .zlogin always follows a login shell's .zprofile, and .zshrc follows it when interactive. Both
# are read from $ZDOTDIR, so point it back here.
ZDOTDIR=$__OTTERM_ZDOTDIR
