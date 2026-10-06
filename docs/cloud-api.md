# Blocky Cloud API

The contract between a self-hosted panel (`lib/cloud.ts`) and Blocky Cloud
(cloud.blockypanel.com, a separate Laravel project). All endpoints are under `/v1`, take and return
JSON, and are served over HTTPS only. The panel sets `BLOCKY_CLOUD_URL` to point elsewhere for
development (http is allowed only for localhost).

The panel authenticates with a bearer token after linking. The token is 64 hex characters.
Blocky Cloud stores only its SHA-256 hash, so it can't be recovered, only replaced by linking again.

## Linking (device code, RFC 8628)

### `POST /v1/link/start`

No token. Rate limited per IP.

```json
{ "panelId": "3f2a9c1e-…", "name": "Home server", "version": "0.1.0" }
```

`panelId` is the panel's stable ID (the `panel-id` setting, also used in offsite indexes). Linking
the same panel to the same account again keeps its names.

`201`:

```json
{
  "deviceCode": "<64 hex>",
  "userCode": "KQ7M-4XRT",
  "verificationUri": "https://cloud.blockypanel.com/link",
  "verificationUriComplete": "https://cloud.blockypanel.com/link?code=KQ7M-4XRT",
  "expiresIn": 600,
  "interval": 5
}
```

The panel shows `userCode` and a link to `verificationUriComplete`. It only opens links that start
with its configured Blocky Cloud address.

### `POST /v1/link/token`

No token. The panel polls this every `interval` seconds.

```json
{ "deviceCode": "<64 hex>" }
```

| Status | Body | Meaning |
|--------|------|---------|
| `202` | `{ "status": "pending" }` | Not approved yet. Keep polling. |
| `200` | `{ "token": "<64 hex>", "account": { "email": "…" } }` | Approved. The token is returned once. |
| `410` | `{ "error": "expired" \| "invalid", "message": "…" }` | Start again. |

## Check-in

### `POST /v1/checkin`

Every five minutes (Blocky Cloud's `nextCheckinSeconds`), with backoff from 1 to 60 minutes after
failures. Blocky Cloud takes the caller's IPv4 address as the address for the account's names that
point at this panel, unless the owner pinned one.

```json
{
  "version": "0.1.0",
  "name": "Home server",
  "servers": [{ "id": "a7c31e481f20", "name": "Survival", "port": 25565, "bedrockPort": 19132, "icon": "creeper" }]
}
```

Server IDs match `^[A-Za-z0-9-]{1,64}$`. At most 200 servers. `bedrockPort` is optional: the UDP port Bedrock players use (Geyser, or a Bedrock server). `icon` is optional: the server's picture, one of `grass`, `dirt`, `stone`, `sand`, `snow`, `water`, `oak-log`, `copper-ore`, `creeper`, `zombie`, `skeleton`, `enderman`, `pig`, `cow`, `sheep`, `villager`. It changes nothing in DNS. Servers the owner turned off on the panel's Blocky Cloud page aren't sent, so Blocky Cloud removes their records. Each server becomes an SRV record
`_minecraft._tcp.<label>.<name>.blockylink.net` pointing at `<name>.blockylink.net` and its port. The
label comes from the server name the first time it's seen and keeps its value after that. The owner
can rename it on Blocky Cloud.

`200`:

```json
{
  "account": { "email": "alex@example.com" },
  "entitlements": { "names": 1, "serversPerName": 1, "storageBytes": 5368709120 },
  "names": [{
    "name": "alex", "fqdn": "alex.blockylink.net", "state": "active", "ip": "203.0.113.10", "published": true,
    "servers": [{
      "id": "a7c31e481f20", "label": "survival", "fqdn": "survival.alex.blockylink.net", "port": 25565,
      "published": true, "reachable": true, "checkedAt": "2026-10-05T10:00:00+00:00",
      "bedrockPort": 19132, "bedrockReachable": true
    }]
  }],
  "backup": {
    "available": true, "readOnly": false, "quotaBytes": 5368709120, "usedBytes": 1073741824,
    "deleteAfter": null, "renewCredentials": false, "copiesPerDay": 1,
    "folders": [{ "id": "3f2a9c1e-…", "name": "Home server", "lastKeyAt": "2026-10-02T06:00:00+00:00" }]
  },
  "minPanelVersion": "0.1.0",
  "notices": [{ "level": "warning", "message": "…" }],
  "nextCheckinSeconds": 300
}
```

- **`names[].state`** is `active`, `frozen` (beyond what the account includes: kept at the last
  address, not following changes), `reserved` (no records, name held), or `suspended`.
- **Reachability.** Blocky Cloud pings each server at the panel's public address, the way the Minecraft
  server list does: Java over TCP, `bedrockPort` over UDP (RakNet). A server's SRV record is published
  (`servers[].published`) once its Java server answers. The name's address (`names[].published`) is
  published once any server answers on Java or Bedrock, so Bedrock players can join with the name and
  `bedrockPort`. A server that answered stays published for seven days. Servers are pinged at most
  every ten minutes, after a check-in; pinning an address clears earlier results.
- **`backup.available`** is `false` when the account has no backup space. Then the object has no other fields.
- **`backup.copiesPerDay`** is how many copies a day Blocky Cloud allows the account, or `null`
  for no limit. The panel enforces it. Only successful copies count, so a failed copy still retries.
- **`backup.folders`** lists every panel folder in the account's space, including unlinked panels,
  so a replacement panel can restore them.

`401 { "error": "unlinked" }` means the token is no longer valid, for example because the panel was
unlinked from Blocky Cloud. The panel forgets the token and shows that it was unlinked.

## Blocky Cloud backup (Obsidian backups)

### `POST /v1/backup/credentials`

Returns a new Backblaze B2 key that only reaches the account's folder in the bucket. The previous
key keeps working until the next renewal, so a copy in progress isn't cut off. Older keys are
revoked.

```json
{
  "provider": "b2", "region": "us-west-004", "endpoint": "s3.us-west-004.backblazeb2.com", "bucket": "blocky-cloud",
  "prefix": "accounts/01jabc…/",
  "keyId": "…", "applicationKey": "…",
  "expiresAt": "2026-12-01T06:00:00+00:00",
  "readOnly": false
}
```

The panel stores the key in panel.db, outside the offsite settings, and asks for a new one when
less than a week is left, when check-in sets `renewCredentials`, or when `readOnly` changes. Keys
are read-only while the account is over quota or lapsed.

The panel uses `<prefix>panels/<panelId>/` as its offsite destination. The layout below that is the
usual offsite layout from `lib/offsite-core.ts`: `index/` and `servers/<id>/`, all encrypted by
restic before upload.

`403` means the account has no backup space.

## Unlinking

### `DELETE /v1/panel`

Unlinks from the panel's side. Keys are revoked. Names stay with the account and stop pointing
anywhere. Backups already stored are kept. `200 { "ok": true }`.

## Certificates (DNS-01)

These are for panels that want a certificate for their name without opening port 80. With port 80
open, Caddy's normal HTTP challenge works with no extra setup.

- `PUT /v1/acme/{name}` with `{ "value": "<token>" }` sets `_acme-challenge.<name>.blockylink.net`.
- `DELETE /v1/acme/{name}` with the same body clears it.
- `POST /v1/acme-dns/update` speaks the acme-dns protocol for clients that support it. Send
  `X-Api-User: <panelId>` and `X-Api-Key: <token>`, with body `{ "subdomain": "<name>", "txt": "<token>" }`.

The panel doesn't use these yet.

## Limits

| Endpoint | Limit |
|----------|-------|
| `link/start`, `link/token` | 30 a minute per IP |
| Everything with a token | 60 a minute per panel |
