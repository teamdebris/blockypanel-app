# Blocky Panel for Windows

Blocky Panel as one Windows executable, next to the Docker version. Minecraft servers run directly on
Windows: no Docker, no WSL, nothing else to install. Same look as the Docker panel.

Maintained in the `windows/` directory of `blockypanel-app`. This is the native Windows MVP; see [the distribution comparison](../docs/DISTRIBUTIONS.md) for feature differences.

Uses the repository root version. Published Windows builds target Windows x64 and are built with Node.js 24.

## Use it

Run `dist\BlockyPanel.exe`. It opens `http://127.0.0.1:3080` in your browser (the next port if that one is
taken). Close its window, or press Ctrl+C, to stop Blocky; running servers are told to save and stop first.

- **Create a server:** Paper or Vanilla, any recent release, memory, and port. The first start downloads
  the Java version that Minecraft release needs (Eclipse Temurin) and the server jar, checking their
  checksums. Later starts skip that.
- **Run it:** start, stop, and restart, a live console with commands and history, players online, and
  memory in use.
- **Backups:** a full copy of the world and settings, made while the server runs (it saves and pauses
  writes first). Restore makes a safety backup of the current world first.
- **Settings:** name, memory, port, message of the day, max players, difficulty, icon, and "open folder".

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

## Not in the MVP

Accounts and remote access, plugins/mods from Modrinth, a file manager, scheduled tasks and backups,
off-site copies, Blocky Cloud, Fabric/Forge, and a tray icon. If Blocky is ended forcefully (Task Manager),
its servers stop without saving.
