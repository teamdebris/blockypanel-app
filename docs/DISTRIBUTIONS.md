# Linux and Windows distributions

Both editions are maintained in this repository and report the version in the root `package.json`.
They currently have separate UIs and server implementations. Sharing a release number does not imply
feature parity or interchangeable panel data.

| Feature | Linux Docker | Native Windows x64 |
| --- | --- | --- |
| Paper and Vanilla | Yes | Yes |
| Purpur, Fabric, Quilt, Forge, NeoForge | Yes | No |
| Start, stop, restart, live console | Yes | Yes |
| Server settings and local backups | Yes | Yes |
| Incremental backups with restic | Yes | No; folder copies |
| Off-site backups and Blocky Cloud | Yes | No |
| Accounts, roles, two-factor sign-in | Yes | No; local access only |
| File manager, SFTP, Modrinth installation | Yes | No |
| Scheduled tasks and backups | Yes | No |
| Requires Docker | Yes | No |

## Linux Docker

Use the existing installer and Compose files described in [the guide](GUIDE.md).
Release images are published to `ghcr.io/teamdebris/blockypanel-app:<version>` for
`linux/amd64` and `linux/arm64`. For example:

```sh
docker pull ghcr.io/teamdebris/blockypanel-app:0.2.6
```

`latest` moves on release tags; `main` and `dev` retain their existing development tags.

## Windows executable

Download `BlockyPanel-windows-x64.exe` from the matching GitHub release and run it. The panel opens in
your browser on `127.0.0.1:3080` (or the next free port). It downloads Java and the Minecraft server
software on first start. No Docker, WSL, or separate Node installation is needed by the end user.

Data stays in `%LOCALAPPDATA%\Blocky Panel`, including `servers.json`, `servers`, `backups`, and
`runtime`. Existing Windows installations keep using this directory. Docker and Windows panel metadata
and backup formats are different; do not point them at the same storage directory.

The Windows panel listens only on localhost and has no accounts or remote administration. Minecraft
players can connect through the server's game port. Windows builds are currently unsigned.

### Build from this repository

Use Windows x64 and Node.js 24 with npm:

```powershell
npm run windows:install
npm run windows:check
npm run windows:build
npm run windows:test
```

The executable is `windows/dist/BlockyPanel.exe`. `npm run windows:dev` builds and runs the local
application without creating an executable. Root `npm run build`, `npm test`, and `npm run lint`
continue to target the Docker/Next.js edition. Windows dependencies have their own lockfile.

## Release process

Set the root and Windows package/lockfile versions together, update the changelog, and push a matching
`v<version>` tag. CI validates the versions, checks both editions, publishes the Linux multi-architecture
Docker image, and builds/tests the Windows executable on a Windows runner. After both distributions
succeed, CI creates or updates one GitHub release containing the executable, its SHA-256 checksum,
Compose files, and notes linking the Docker image. Pull requests build and test without publishing.

This provides two distribution formats under one release. Feature parity requires a further refactor
to share the API/UI and provide Docker and native-Java runtime implementations, followed by native
implementations of the missing features.
