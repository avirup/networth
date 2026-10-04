import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKUP_FORMAT, backupManifestSchema, createBackupWriter, sha256, verifyBackup } from "@/lib/backup/format";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("encrypted backup format", () => {
  it("authenticates the manifest and every bounded structured part", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "networth-backup-test-")); directories.push(parent);
    const directory = path.join(parent, "backups", "first-export"); const exportId = randomUUID(); const createdAt = new Date().toISOString(); const passphrase = "synthetic backup passphrase";
    const writer = await createBackupWriter(directory, { exportId, createdAt, passphrase });
    const plaintext = Buffer.from('{"id":"00000000-0000-0000-0000-000000000001"}\n');
    await writer.part("part-000001.enc", plaintext);
    const manifest = backupManifestSchema.parse({ format: BACKUP_FORMAT, exportId, createdAt, schemaVersion: 11,
      installationId: randomUUID(), householdId: randomUUID(), sourceRevision: 0,
      ruleVersions: { bankImport: "bank-v1", bankMovement: "bank-movements-v1", bankBalance: "bank-balance-v1" }, exclusions: ["credentials"],
      tables: [{ name: "core.household", rowCount: 1, parts: ["part-000001.enc"] }],
      parts: [{ name: "part-000001.enc", table: "core.household", rowCount: 1, plaintextBytes: plaintext.length, plaintextSha256: sha256(plaintext) }],
      controls: { postingCount: 0, postingBookTotalInr: "0", eventCount: 0, sourceRecordCount: 0, reconciliationCount: 0 } });
    await writer.finish(manifest);
    await expect(createBackupWriter(directory, { exportId, createdAt, passphrase })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await verifyBackup(directory, passphrase)).manifest).toEqual(manifest);
    await expect(verifyBackup(directory, "incorrect synthetic passphrase")).rejects.toThrow(/incorrect|changed/);
    const filename = path.join(directory, "part-000001.enc"); const changed = await readFile(filename); changed[0] = (changed[0] ?? 0) ^ 1; await writeFile(filename, changed);
    await expect(verifyBackup(directory, passphrase)).rejects.toThrow(/checksum/);
  });
});
