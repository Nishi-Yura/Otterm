# otterm's ZDOTDIR for zsh: interactive stage. See .zshenv for how the stages hand over ZDOTDIR.

ZDOTDIR=${OTTERM_USER_ZDOTDIR:-$HOME}
[[ ${OTTERM_USER_STARTUP:-1} != 0 && -f $ZDOTDIR/.zshrc ]] && builtin source $ZDOTDIR/.zshrc

# The hook comes after the user's .zshrc, so its prompt settings are the ones that apply.
if [[ -n $OTTERM_ZSH_HOOK && -r $OTTERM_ZSH_HOOK ]]; then
    builtin source $OTTERM_ZSH_HOOK
fi

if [[ -o login ]]; then
    # A login shell still reads .zlogin, from $ZDOTDIR.
    ZDOTDIR=$__OTTERM_ZDOTDIR
else
    unset __OTTERM_ZDOTDIR
fi
