# Changelog

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
