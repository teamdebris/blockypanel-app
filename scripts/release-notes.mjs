import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repository = process.env.GITHUB_REPOSITORY || "teamdebris/blockypanel-app";
const notes = `Two distributions are available for Blocky Panel ${version}:

- **Linux Docker (amd64 and arm64):** \`docker pull ghcr.io/${repository}:${version}\`. Use the attached Compose files or the installer at https://blockypanel.com/#install.
- **Windows x64:** download and run \`BlockyPanel-windows-x64.exe\`. No Docker or separate Node installation is needed. Check the download against \`SHA256SUMS.txt\`.

The Windows edition is a localhost-only MVP with Paper/Vanilla, server controls, console, settings, and local folder-copy backups. It does not yet include accounts, other server types, Modrinth, the file manager, SFTP, scheduling, off-site backups, or Blocky Cloud. **The editions do not yet have feature parity.** Windows builds are unsigned.

Existing Windows data remains in \`%LOCALAPPDATA%\\Blocky Panel\`. Panel data and backup formats are not interchangeable between editions.

See [distribution details](https://github.com/${repository}/blob/v${version}/docs/DISTRIBUTIONS.md) and the [changelog](https://github.com/${repository}/blob/v${version}/CHANGELOG.md).
`;
if (process.argv[2]) writeFileSync(process.argv[2], notes);
else process.stdout.write(notes);
