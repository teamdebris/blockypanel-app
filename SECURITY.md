# Security

## Reporting a problem

Please report security issues privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue for them. Include the steps to reproduce and what an attacker could do.

## What to know before you run it

Blocky Panel controls Docker through its socket, and access to the Docker socket is equivalent to root on the host. Anyone with an **admin** account in the panel effectively controls the machine. So:

- **Keep the panel off the open internet** unless it's behind HTTPS. The Compose file binds it to `127.0.0.1` by default; put a reverse proxy (Caddy, nginx) or a VPN (Tailscale, WireGuard) in front of it. See "Serve it over HTTPS" in the README.
- **Use a long random `BLOCKY_ADMIN_PASSWORD`.** It proves ownership at first setup and works as a recovery sign-in. The panel refuses the example value and anything under 16 characters.
- **Give roles carefully.** Operators get the full server console, including Minecraft's `op`. Admins can install plugins, which run code on the server.
- **Rootless Docker** limits what a compromised panel could reach to one unprivileged user.

## How the panel defends itself

- **Accounts:** scrypt password hashes. Session, invite, and reset tokens are random, and only their hashes are stored. Sessions end on sign-out, role changes, disabling, or password resets.
- **Access:** every API route and method has a minimum role, and anything unlisted is refused.
- **Requests:** state-changing API calls must come from the panel's own origin and carry a custom header, which blocks forged requests from other sites and from other apps on the same host.
- **Sign-in throttling:** per address (behind a trusted proxy), per username, and overall. Attempts are counted before the password check, and recovery can't be locked out.
- **Docker:** users can't set images, mounts, or container options. Only validated settings reach a container, and each server's mounts are derived from its ID.
- **Files:** the file manager is confined to each server's data folder and never follows symlinks.
- **Container:** the Compose service runs with `no-new-privileges` and only the Linux capabilities it needs to manage file ownership.
