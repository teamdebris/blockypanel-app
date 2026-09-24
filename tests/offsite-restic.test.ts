import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repositoryFor, type OffsiteIndex } from "../lib/offsite-core.ts";
import { addKey, copyServer, createIndex, createLocalFromOffsite, listWorldSnapshots, readIndex, readSettingsSnapshot, removeKey, repositoryExists, restoreWorld, ResticError, writeIndex, writeSettingsSnapshot, directRunner } from "../lib/offsite-restic.ts";

// Drives real restic against a folder destination. Skipped when restic isn't installed
// (set RESTIC_BIN to point at a binary that isn't on PATH).
const binary = process.env.RESTIC_BIN || "restic";
const available = spawnSync(binary, ["version"]).status === 0;

test("offsite round trip: set up, copy, change passphrase, recover on a new machine", { skip: !available && "restic isn't installed" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "blocky-offsite-"));
  try {
    const machine = (name: string) => directRunner({
      binary,
      cacheDir: path.join(root, name, "cache"),
      localRepository: (id) => path.join(root, name, "backups", id, "restic"),
      dataFolder: (id) => path.join(root, name, "servers", id, "data"),
    });
    const oldMachine = machine("old");
    const newMachine = machine("new");
    const destination = { kind: "folder" as const, path: path.join(root, "destination") };
    const indexRepository = repositoryFor(destination, "index");
    const panelPassword = "panel-random-key-0001";
    const passphrase = "correct horse battery staple glacier";

    // Two servers with local snapshots of their data folders.
    const servers = { alpha: "pw-alpha-0123456789", bravo: "pw-bravo-0123456789" };
    for (const [id, password] of Object.entries(servers)) {
      const data = oldMachine.dataFolder(id);
      await mkdir(path.join(data, "world"), { recursive: true });
      await writeFile(path.join(data, "world", "level.dat"), `level of ${id}`);
      await oldMachine.run(["init"], { repository: oldMachine.localRepository(id), password });
      await oldMachine.run(["backup", "--quiet", "--tag", "kind:scheduled", data], { repository: oldMachine.localRepository(id), password });
    }

    assert.equal(await repositoryExists(oldMachine, indexRepository, panelPassword), false);
    const index: OffsiteIndex = { version: 1, panelId: "old-panel", updatedAt: new Date().toISOString(), servers: {} };
    let passphraseKey = await createIndex(oldMachine, indexRepository, panelPassword, passphrase, index);

    for (const [id, password] of Object.entries(servers)) {
      const repository = repositoryFor(destination, { server: id });
      await copyServer(oldMachine, { serverId: id, repository, password, keep: 5 });
      await copyServer(oldMachine, { serverId: id, repository, password, keep: 5 }); // idempotent
      await writeSettingsSnapshot(oldMachine, repository, password, { id, name: `Server ${id}`, type: "PAPER" });
      index.servers[id] = { name: `Server ${id}`, type: "PAPER", version: "1.21.8", repositoryPassword: password, lastCopyAt: new Date().toISOString() };
    }
    await writeIndex(oldMachine, indexRepository, panelPassword, index);

    // Change the passphrase: only the index is re-keyed.
    const newPassphrase = "purple otter lantern river mountain";
    const newKey = await addKey(oldMachine, indexRepository, panelPassword, newPassphrase);
    await removeKey(oldMachine, indexRepository, panelPassword, passphraseKey);
    passphraseKey = newKey;
    await assert.rejects(readIndex(oldMachine, indexRepository, passphrase), (error) => error instanceof ResticError);

    // A new machine knows only the destination and the passphrase.
    const recovered = await readIndex(newMachine, indexRepository, newPassphrase);
    assert.deepEqual(Object.keys(recovered.servers).sort(), ["alpha", "bravo"]);
    for (const [id, entry] of Object.entries(recovered.servers)) {
      const repository = repositoryFor(destination, { server: id });
      const settings = await readSettingsSnapshot(newMachine, repository, entry.repositoryPassword);
      assert.equal(settings.name, `Server ${id}`);
      const [snapshot, ...rest] = await listWorldSnapshots(newMachine, repository, entry.repositoryPassword);
      assert.equal(rest.length, 0, "copying twice doesn't duplicate snapshots");
      assert.equal(snapshot.kind, "scheduled");
      await restoreWorld(newMachine, { serverId: id, repository, password: entry.repositoryPassword, snapshotId: snapshot.id, path: snapshot.path });
      assert.equal(await readFile(path.join(newMachine.dataFolder(id), "world", "level.dat"), "utf8"), `level of ${id}`);
      await createLocalFromOffsite(newMachine, { serverId: id, repository, password: entry.repositoryPassword });
      assert.equal(await repositoryExists(newMachine, newMachine.localRepository(id), entry.repositoryPassword), true);
    }

    // The new panel adds its own key and keeps copying.
    const newPanelPassword = "new-panel-random-key-02";
    await addKey(newMachine, indexRepository, newPassphrase, newPanelPassword);
    assert.equal((await readIndex(newMachine, indexRepository, newPanelPassword)).panelId, "old-panel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
