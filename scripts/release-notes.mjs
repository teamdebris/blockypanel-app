import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repository = process.env.GITHUB_REPOSITORY || "teamdebris/blockypanel-app";
const notes = `Two distributions are available for Blocky Panel ${version}:

- **Linux Docker (amd64 and arm64):** \`docker pull ghcr.io/${repository}:${version}\`. Use the attached Compose files or the installer at https://blockypanel.com/#install.
- **Windows x64:** download and run \`BlockyPanel-windows-x64.exe\`. No Docker or separate Node installation is needed. Check the download against \`SHA256SUMS.txt\`.

Windows includes all seven native server types, server controls, console, gameplay settings, files, Modrinth dependency management, schedules/activity, world import/reset/seed tools, full-copy or encrypted incremental backups, and off-site folder/S3 copy and recovery. Accounts/roles/2FA, SFTP, remote administration, and Blocky Cloud are not yet included. **The editions do not yet have full feature parity.** Windows stays localhost-only and builds are unsigned.

Existing Windows data remains in \`%LOCALAPPDATA%\\Blocky Panel\`. Existing folder backups remain usable. Keep the complete data folder, including backup passwords and \`secret.key\`, for recovery. Do not point Docker and Windows installations at the same data directory.

See [distribution details](https://github.com/${repository}/blob/v${version}/docs/DISTRIBUTIONS.md) and the [changelog](https://github.com/${repository}/blob/v${version}/CHANGELOG.md).
`;
if (process.argv[2]) writeFileSync(process.argv[2], notes);
else process.stdout.write(notes);
