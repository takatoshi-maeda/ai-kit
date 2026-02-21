#!/bin/bash

set -u

WORKSPACE_DIR="$(pwd)"
CURRENT_USER="$(id -un)"
USER_HOME="${HOME:-/home/$CURRENT_USER}"

clone_or_update_repo() {
    local repo="$1"
    local target_dir="$2"

    if [ -d "$target_dir/.git" ]; then
        echo "Updating repository: $repo"
        git -C "$target_dir" pull || echo "Failed to update $repo"
        return
    fi

    echo "Cloning repository: $repo"
    gh repo clone "$repo" "$target_dir" || echo "Failed to clone $repo"
}

echo "Fixing GitHub CLI permissions..."
if [ -d "$USER_HOME/.config/gh" ]; then
    sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$USER_HOME/.config/gh"
else
    sudo mkdir -p "$USER_HOME/.config/gh"
    sudo chown "$CURRENT_USER:$CURRENT_USER" "$USER_HOME/.config/gh"
fi

if [ -d "$USER_HOME/.config/gh.org" ]; then
    sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$USER_HOME/.config/gh.org"
    cp -R "$USER_HOME/.config/gh.org/." "$USER_HOME/.config/gh/" 2>/dev/null || true
fi

echo "Setting up direnv permissions..."
if [ -f "$WORKSPACE_DIR/.envrc" ]; then
    cd "$WORKSPACE_DIR" && direnv allow
else
    echo ".envrc file not found"
fi

if [ -f .devcontainer/.github-user ]; then
    cp .devcontainer/.github-user "$USER_HOME/.github-user"
fi

if [ -n "${VIBEBOX_BOOTSTRAP_REPOS:-}" ] && command -v gh >/dev/null 2>&1; then
    IFS=',' read -r -a bootstrap_repos <<< "$VIBEBOX_BOOTSTRAP_REPOS"
    for repo in "${bootstrap_repos[@]}"; do
        repo="$(echo "$repo" | xargs)"
        if [ -z "$repo" ]; then
            continue
        fi

        repo_name="$(basename "$repo")"
        target_dir="$USER_HOME/$repo_name"
        clone_or_update_repo "$repo" "$target_dir"
    done
else
    echo "Skipping bootstrap repositories setup."
fi

dotfiles_dir="$USER_HOME/.dotfiles"
if [ -f "$USER_HOME/.github-user" ]; then
    github_user="$(cat "$USER_HOME/.github-user")"
    if [ -n "$github_user" ]; then
        clone_or_update_repo "$github_user/dotfiles" "$dotfiles_dir"
        if [ -f "$dotfiles_dir/install.sh" ]; then
            chmod +x "$dotfiles_dir/install.sh"
            (cd "$dotfiles_dir" && ./install.sh) || echo "dotfiles install.sh failed"
        fi
    fi
else
    echo ".github-user file not found, skipping dotfiles setup"
fi

echo "Setting up shell configurations..."
PATH_EXPORT='export PATH="$HOME/.local/bin:$PATH"'

add_to_shell_config() {
    local file="$1"
    local line="$2"

    if [ -f "$file" ] && ! grep -Fxq "$line" "$file"; then
        echo "$line" | sudo tee -a "$file" > /dev/null
    fi
}

add_to_shell_config "/etc/bash.bashrc" "$PATH_EXPORT"
add_to_shell_config "/etc/zsh/zshrc" "$PATH_EXPORT"

if command -v cursor-agent >/dev/null 2>&1; then
    cursor-agent update
fi

if command -v npm >/dev/null 2>&1; then
    npm update -g @openai/codex
    npm install -g @aikidosec/safe-chain
fi

if [ -f "$USER_HOME/.codex/notify.sh" ]; then
    sudo cp "$USER_HOME/.codex/notify.sh" /usr/local/bin/codex-notify.sh
fi

if command -v safe-chain >/dev/null 2>&1; then
    safe-chain setup --include-python
fi

echo "Setup completed."
