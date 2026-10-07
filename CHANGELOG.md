# Changelog

## 0.2.0 (2026-10-07)

- Pick a server's icon in Settings > General. It saves as soon as you click and doesn't restart anything.
- Security: the key that recovery sign-ins are checked against is now stored as a slow scrypt hash, like
  account passwords. If you're signed in with `BLOCKY_ADMIN_PASSWORD`, you'll be signed out once and can
  sign in again. Normal accounts aren't affected.
- The `latest` image now changes only when a release is published. `main` builds are tagged `main`.

## 0.1.0 (2026-10-06)

Initial release.
