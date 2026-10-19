# Windows guide

The Windows executable includes Node and the UI; no Node installation, Docker, or WSL is required
to use it. This guide describes the development source tree. Stable 0.2.6 has the earlier Windows MVP.

## Start and create a server

Run `BlockyPanel.exe`. The panel opens on `http://127.0.0.1:3080` or the next free port. Opening it again
reuses the instance that owns this data folder. Close an older Blocky version before launching an update.

Create Paper/Purpur for plugins, Fabric/Quilt/Forge/NeoForge for mods, or Vanilla for the official server.
The version picker lists release Minecraft versions supported by each service. Loader availability
still depends on the vendor. First start downloads and verifies Java, then downloads or installs the
chosen server software. Quilt, Forge, and NeoForge installation can take longer than a simple JAR download.
The console shows progress; later starts reuse the installation. No firewall or router settings are changed.

Use Start/Stop/Restart and the console as usual. Close the panel normally to save and stop running
servers; forcibly ending processes can lose unsaved game data. The panel must remain open for schedules.

## Files, plugins, and mods

Stop the server before opening Files or changing JARs. Files supports folders, uploads up to 256 MB,
downloads, text editing up to 2 MB, renames and deletes. Editing refuses stale revisions rather than
overwriting changes made outside the editor. Links, junctions, alternate data streams, reserved device
names, and paths outside the server folder are refused. Blocky's own metadata is hidden/protected.

The Plugins/Mods tab searches Modrinth for the selected Minecraft version and compatible loader.
Preview a project to see additions, updates, removed dependencies, and download size. Required
dependencies are included; optional dependencies are a separate choice. Only stable releases are chosen.
Conflicting pins and incompatible projects are refused before files change. Downloads are staged and
checksummed; a safety backup precedes JAR changes. Shared dependencies and manually uploaded JARs are kept
when still needed. Updating/removing refuses managed JARs changed outside the panel. Native addons run
with your Windows account's permissions, so choose projects you trust.

## Worlds and gameplay

World imports accept Java ZIP, TAR, TAR.GZ, and TGZ files up to 4 GB, with extraction limits of 200,000
entries and 64 GB plus a free-space margin. Bedrock archives require conversion first. Imports preserve
Nether/End data included in Bukkit sibling folders and normalize it into the Java world; Paper/Purpur
perform their usual dimension migration on start. Ambiguous layouts and Windows filename conflicts are refused.

Imports and resets require a stopped server and create a safety backup. Reset accepts a new seed or
an empty seed for random generation, and removes the configured Overworld/Nether/End folders. The running
server can report its actual seed for a Chunkbase link. Settings controls gameplay, resource limits,
network port, and appearance. Managed `server.properties` keys are reapplied from Settings on start;
editing those keys in Files does not override the panel. Changing a seed does not rewrite an existing world.

## Schedules and activity

Schedule supports restarts, console commands, and chat messages. Choose an hourly interval or a daily
wall-clock time with weekdays and an IANA time zone such as `America/Chicago`. Timing uses the same
daylight-saving and missed-run rules as Linux. Restarts can warn online players before the scheduled time.
Tasks skip stopped servers and do not start a server on their own. Intervals missed during downtime are
not replayed in a burst. Activity keeps the latest 200 actions/results without recording command text.

## Local backups

Backups settings offers **Full folder copies** (the existing format) or **Encrypted incremental**
snapshots. Incremental storage downloads the official Windows restic runtime on first use and verifies
its pinned archive checksum. Unchanged chunks are reused; existing folder copies remain available.
Worlds, configuration files, and plugin/mod JARs are backed up; downloaded server binaries/libraries,
logs/caches, and temporary world uploads are excluded. Panel-managed settings still apply on start.

Live backups ask Minecraft to save and pause world writes, then resume them even on failure. Scheduled
retention removes only old scheduled copies, keeping manual and safety copies separately. A deleted
incremental snapshot releases its reference; use **Reclaim unused space** to prune unreferenced data.
**Check repository** validates the encrypted repository. Restores stage and verify files before replacing
current files, keep a safety copy, and restore the managed addon selection where backup metadata exists.

Keep the **complete** `%LOCALAPPDATA%\Blocky Panel` folder. Each encrypted repository's
`backups/<server-id>/restic-password` is required to unlock it. Losing that file cannot be fixed by
generating a different password. `secret.key` unlocks saved off-site credentials. These files are local
recovery material; avoid copying only encrypted repository packs and discarding the keys.

## Off-site copies and recovery

Off-site backups supports a dedicated folder outside Blocky's own data tree (including a network share
already connected in Windows) or HTTPS S3-compatible storage: B2, R2, Wasabi, AWS, MinIO, or another provider.
Create the bucket first and use its region/endpoint. Choose a separate folder or bucket prefix per panel.

Configure a recovery passphrase of at least 20 characters or five words and keep it separately. The panel
does not save it: a second restic key lets the passphrase open the encrypted index on another machine.
Saved destination credentials are encrypted locally. Choose manual copies or copies after manual/scheduled
incremental backups. Each server must use incremental storage; **Copy now** takes a fresh snapshot first.
Local backup success is retained when an off-site copy fails; the off-site page/activity shows the failure.

To recover, enter the destination and passphrase under **Configure or recover**, then choose **Find
existing backups**. Select the source server and snapshot, and a stopped local server with matching
server software and Minecraft version. Create that local server first if needed. Confirm its name to
replace its files. A safety backup preserves its current files. Disconnecting a destination stops future
copies without deleting its existing backups. The recovery format uses the shared restic/index helpers;
complete panel data directories are still platform-specific.

## Data and development

- `servers.json`: server definitions; `control-state.json`: schedules, backup policies, addon tracking and activity.
- `servers/`: native server files; `backups/`: folder copies and encrypted repositories.
- `runtime/`: downloaded Java, restic and cached runtime files; `staging/`: temporary transactions.
- `offsite.json`: encrypted destination configuration and copy status; `secret.key`: local sealing key.
- `panel.lock`: the running instance's PID/port. Stale locks from ended processes are reclaimed automatically.

`BLOCKY_DATA`, `BLOCKY_PORT`, and `BLOCKY_NO_BROWSER=1` override data folder, panel port, and automatic
browser opening. `BLOCKY_RESTIC_BINARY` can point to an administrator-provided restic executable.
Backups and other metadata use serialized atomic writes with recovery copies; unreadable state is not
silently overwritten. A failed rollback preserves staging data and reports its location for recovery.

Build with Node.js 24: `npm run windows:install`, `npm run windows:check`, `npm run windows:build`, then
`npm run windows:test`. Tests cover the real executable, Windows paths/junctions, scheduling, dependency
transactions, archive imports, and real encrypted restic copy/recovery. The optional network integration
check `node windows/scripts/verify-installers.mjs 1.21.8` downloads Java and runs actual Quilt/Forge/NeoForge
installers, verifies their Windows launch files, and cleans up. It does not accept the Minecraft EULA or
start a game server. A live S3 provider check needs credentials and is not part of the automated suite.

Accounts/roles/2FA, remote panel access, SFTP, and Blocky Cloud/Obsidian are not implemented. The panel
continues to bind only to localhost, and Windows builds remain unsigned.
