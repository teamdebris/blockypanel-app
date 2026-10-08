# Changelog

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
