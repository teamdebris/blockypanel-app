# Known issues and gaps

Blocky is in **beta**. It runs real servers every day, but it's young, and this page lists what it
doesn't do yet, what's rough, and the trade-offs made on purpose. If something here bites you, or you
find something that isn't listed, please [open an issue](https://github.com/teamdebris/blockypanel-app/issues).
Security problems go through [SECURITY.md](../SECURITY.md) instead.

## What beta means here

- **Keep backups.** Automatic local backups are on by default; off-site copies (Blocky Cloud, a NAS,
  cloud storage, or another disk) are worth turning on too.
- **Things can change between 0.x releases**, including settings and how data is stored. Release notes
  say when an update needs a step from you. To stay put, pin a release with `BLOCKY_VERSION`.
- **`dev` is for testing.** `BLOCKY_VERSION=dev` gets changes first and is less tested than a release.

## Reaching your servers from outside

- **Friends outside your home need port forwarding.** Blocky can't open ports on your router. Blocky
  Cloud names (`survival.you.blockylink.net`) save players from typing a port, but the port still has
  to be forwarded.
- **CGNAT isn't supported yet.** Some internet providers (and most mobile and satellite connections)
  share one public address between customers, which makes port forwarding impossible. A relay that
  works without forwarding is planned but not available. Until then, a tunnel service or a VPN such as
  Tailscale for your players is the workaround.
- **The panel itself isn't meant to be open to the internet** without HTTPS in front of it. See
  "Serve it over HTTPS" in the [guide](GUIDE.md), or use a VPN.

## Servers

- **Java Edition only.** Paper, Purpur, Vanilla, Fabric, Quilt, Forge, and NeoForge. Bedrock players
  can join through the Geyser plugin, but Bedrock Dedicated Server isn't supported.
- **One machine per panel.** A panel manages the servers on the machine it runs on; there's no
  multi-machine or cluster mode.
- **The seed map link** uses Chunkbase's list of map versions as of this release. A Minecraft version
  newer than that list opens the newest map Blocky knows. A world made with a random seed shows its
  seed (and map) once the server has run, because Blocky asks the game for it.

## Backups

- **Deleting backups frees disk space at the next cleanup**, not immediately. Backups share data, so
  the space is reclaimed by the periodic repository cleanup.
- **Switching off off-site copies for a server keeps the copies already made.** There's no button yet
  to delete one server's off-site copies; they follow the destination's retention.
- **Restoring from Blocky Cloud is new.** Off-site restores are tested, but restoring from Blocky Cloud
  storage hasn't had much real-world use yet. Try it with a spare world before you depend on it.

## Files and SFTP

- **SFTP uses one password per server and person**, shown on the server's SFTP tab. SSH keys aren't
  supported; that's a deliberate choice to keep things simple.
- **That password is stored encrypted, not hashed**, so the panel can show it again. Someone signed in
  to your admin account can read it (they could already change your files). Re-roll it any time.

## Alerts

- **No email alerts.** Alerts go to a Discord webhook (or any webhook) and, while the panel is open in
  a background tab, to the browser.

## Platforms

- **Mainly tested on Linux** with Docker, on amd64 and arm64. Docker Desktop on Windows and macOS works
  for trying Blocky out, but file permissions and performance differ, and it gets less testing.

## Look and accessibility

- **The logo is a placeholder** and will change before 1.0.
- **Keyboard and screen-reader support** covers the basics (labels, focus, live updates), but there
  hasn't been a full accessibility audit.

## Blocky Cloud

Blocky Cloud (names and Obsidian backups, its off-site backup space) is an optional service, also in beta.

- **It's new and small.** Expect occasional maintenance, and limits may change while
  it's in beta; you'll be told before anything changes.
- **Your panel never depends on it.** Everything works without Blocky Cloud, and backups can go to
  your own storage instead.
- **Backups are encrypted by your panel before upload**, so Blocky Cloud can't read your worlds.
