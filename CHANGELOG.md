# Changelog

## Unreleased — Windows feature expansion

- Native Purpur, Fabric, Quilt, Forge, and NeoForge support alongside Paper/Vanilla; verified vendor
  downloads, cached loader installations, and Java extraction without a PowerShell module dependency.
- File manager with bounded streaming uploads/downloads, text editing with conflict detection,
  rename/delete, and Windows path/junction checks. Servers must be stopped for file/JAR changes.
- Modrinth search and installation with shared Linux compatibility rules, required/optional
  dependency previews, conflicting-version checks, checksummed downloads, safety backups, and rollback.
- Scheduled restarts with player warnings, console commands and chat messages, time-zone-aware daily
  schedules, interval schedules, automatic backups/retention, and per-server activity history.
- World ZIP/TAR imports, Bukkit dimension normalization, resets with safety copies, seed queries/maps,
  and gameplay settings including PvP, mode, distances, online mode, flight, and command blocks.
- Optional encrypted incremental restic backups, repository checks/pruning, off-site folder/S3 copies,
  and passphrase-based recovery. Existing full folder backups remain usable.
- Serialized/recoverable state writes, per-server operation locks, transaction rollback for restores,
  encrypted destination credentials, and a single-instance guard for each data folder.
- Windows remains localhost-only; accounts/roles/2FA, SFTP, and Blocky Cloud are not included.
- Version the UI asset URLs on startup so an executable update does not keep an older cached UI.

## 0.2.6 (2026-10-19)

- Include the native Windows application in `windows/`, using the same release version as the Docker panel.
- Build Linux amd64/arm64 Docker images and a Windows x64 executable from the same release tag.
- Document the Windows MVP feature differences; this release does not add feature parity.

## 0.2.5 (2026-10-08)

- The Plugins/Mods tab shows what each one downloads with it, its optional dependencies, and plugins it
  doesn't work with. If one of them, or something it needs, has no release for the server's Minecraft
  version, it says so before you apply, instead of the server failing to start.
- New switch in the Plugins/Mods tab to also install optional dependencies. Off by default.
- Servers set to LATEST show the Minecraft version they're running, like "Paper 26.3 (latest)", and
  plugin search and checks use it.
- Paper and Purpur searches no longer list plugins that only support Bukkit, which the server can't
  download.

## 0.2.2 (2026-10-07)

- A server that can't start because of a setting, such as a mod or plugin with no file for its Minecraft
  version, is now stopped after a few tries and shows why, instead of restarting forever.

## 0.2.1 (2026-10-07)

- Obsidian backups: a backup key whose address can't be reached is now replaced on the next try, instead
  of every connection test and copy timing out until the key expired.

## 0.2.0 (2026-10-07)

- Pick a server's icon in Settings > General. It saves as soon as you click and doesn't restart anything.
- Security: the key that recovery sign-ins are checked against is now stored as a slow scrypt hash, like
  account passwords. If you're signed in with `BLOCKY_ADMIN_PASSWORD`, you'll be signed out once and can
  sign in again. Normal accounts aren't affected.
- The `latest` image now changes only when a release is published. `main` builds are tagged `main`.

## 0.1.0 (2026-10-06)

Initial release.
