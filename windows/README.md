# Blocky Panel for Windows

Blocky Panel as one Windows executable, next to the Docker version. Minecraft servers run directly on
Windows: no Docker, no WSL, nothing else to install. Same look as the Docker panel.

Maintained in the `windows/` directory of `blockypanel-app`. See the [Windows guide](../docs/WINDOWS.md)
and [distribution comparison](../docs/DISTRIBUTIONS.md) for setup and remaining differences.

Uses the repository root version. Published Windows builds target Windows x64 and are built with Node.js 24.

## Use it

Run `dist\BlockyPanel.exe`. It opens `http://127.0.0.1:3080` in your browser (the next port if that one is
taken). Close its window, or press Ctrl+C, to stop Blocky; running servers are told to save and stop first.

- **Create a server:** Paper, Purpur, Vanilla, Fabric, Quilt, Forge, or NeoForge. First start downloads
  Eclipse Temurin Java and the server software, using published vendor checksums where available.
  Forge, NeoForge, and Quilt run their native installers and retain the completed installation.
- **Run it:** start, stop, and restart, a live console with commands and history, players online, and
  memory in use.
- **Backups:** full folder copies or encrypted incremental restic snapshots; automatic backups with
  retention; integrity checks; off-site folder/S3 copies and passphrase recovery. Restores keep safety copies.
- **Files and addons:** browse, edit text, upload/download, rename/delete, and install compatible
  Modrinth plugins/mods with dependency previews, checksums, and rollback. Stop the server for changes.
- **Worlds and schedules:** Java ZIP/TAR imports, world reset with a new seed, seed-map links,
  scheduled restarts/commands/chat messages with time-zone support, and activity history.
- **Settings:** name, memory, port, MOTD, max players, difficulty, game mode, PvP, hardcore, flight,
  command blocks, online mode, view/simulation distance, spawn protection, and icon.

Players on your network join at the address the panel shows (this PC's LAN IP and the server's port).
Friends outside need that port forwarded on the router; Windows may ask to let Java through the firewall
the first time.

Everything is kept in `%LOCALAPPDATA%\Blocky Panel` (`runtime\` for Java, `servers\`, `backups\`, and
`servers.json`). `BLOCKY_DATA` and `BLOCKY_PORT` override the folder and port; `BLOCKY_NO_BROWSER=1` skips
opening the browser.

## Security

The panel only listens on `127.0.0.1`, so only this PC can open it, and it has no accounts. Two checks keep
web pages from using your browser to reach it: requests must be addressed to `127.0.0.1`/`localhost` on its
port (no DNS rebinding), and changes need a custom header that a cross-site page can't send. The page has a
strict Content Security Policy.

Only one panel can claim a data folder at a time. Backup/restore/file operations have per-server locks.
Off-site credentials are encrypted with `secret.key`; recovery passphrases are not stored. Keep the
complete data folder, including `secret.key` and each repository's `restic-password`, for recovery.

## Build

```
npm ci
npm run check
npm run build        # dist\BlockyPanel.exe
npm run dev          # build the UI and run with node, no exe
```

The server (`src/server/`) is bundled into one CommonJS file with esbuild, the UI (`src/web/`, React and
Tailwind with the Docker panel's design tokens) is built next to it, and `scripts/build.mjs` embeds both in
a copy of `node.exe` with Node's single executable applications feature (`node --experimental-sea-config`
and `postject`). The executable is about 90 MB, mostly Node itself.

Not signed: Windows SmartScreen may warn the first time it runs ("More info", then "Run anyway").

## Remaining differences

Accounts/roles/two-factor sign-in, remote administration, SFTP, Blocky Cloud linking/Obsidian backups,
and a tray icon are not implemented. Force-closing the panel can leave unsaved game data; use its
normal shutdown. Windows feature parity is not complete.
