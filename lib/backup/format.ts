import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const BACKUP_FORMAT = "networth-backup-v1" as const;
export const BACKUP_PART_BYTES = 2_500_000;
export const BACKUP_PART_ROWS = 1_000;
export const BACKUP_FILE_LIMIT = 3_000_000;
const ENVELOPE_LIMIT = 1_000_000;
const SCRYPT = { N: 32768, r: 8, p: 1 } as const;

const encryptedFileSchema = z.object({
  name: z.string().regex(/^(manifest|part-[0-9]{6})\.enc$/),
  bytes: z.number().int().positive().max(BACKUP_FILE_LIMIT),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  iv: z.string().min(16).max(32),
  tag: z.string().min(16).max(32),
}).strict();

export const backupEnvelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  exportId: z.string().uuid(),
  createdAt: z.string().datetime(),
  encryption: z.object({
    algorithm: z.literal("aes-256-gcm"),
    kdf: z.literal("scrypt"),
    salt: z.string().min(16).max(64),
    N: z.literal(SCRYPT.N), r: z.literal(SCRYPT.r), p: z.literal(SCRYPT.p),
  }).strict(),
  manifest: encryptedFileSchema,
  parts: z.array(encryptedFileSchema).max(10_000),
}).strict();

export const backupPartSchema = z.object({
  name: z.string().regex(/^part-[0-9]{6}\.enc$/),
  table: z.string().regex(/^(core|ops)\.[a-z_]+$/),
  rowCount: z.number().int().positive().max(BACKUP_PART_ROWS),
  plaintextBytes: z.number().int().positive().max(BACKUP_PART_BYTES),
  plaintextSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  exportId: z.string().uuid(),
  createdAt: z.string().datetime(),
  schemaVersion: z.number().int().positive(),
  installationId: z.string().uuid(),
  householdId: z.string().uuid(),
  sourceRevision: z.number().int().nonnegative(),
  ruleVersions: z.object({ bankImport: z.literal("bank-v1"), bankMovement: z.literal("bank-movements-v1"), bankBalance: z.literal("bank-balance-v1") }).strict(),
  exclusions: z.array(z.string()).min(1),
  tables: z.array(z.object({ name: z.string(), rowCount: z.number().int().nonnegative(), parts: z.array(z.string()) }).strict()),
  parts: z.array(backupPartSchema),
  controls: z.object({
    postingCount: z.number().int().nonnegative(),
    postingBookTotalInr: z.string(),
    eventCount: z.number().int().nonnegative(),
    sourceRecordCount: z.number().int().nonnegative(),
    reconciliationCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupPart = z.infer<typeof backupPartSchema>;

export function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function keyFor(passphrase: string, salt: Buffer) {
  if (passphrase.length < 16 || passphrase.length > 1024) throw new Error("The backup passphrase must contain 16–1024 characters.");
  return scryptSync(passphrase, salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
}

function aad(exportId: string, name: string) { return Buffer.from(`${BACKUP_FORMAT}\0${exportId}\0${name}`); }

function seal(plaintext: Buffer, key: Buffer, exportId: string, name: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(exportId, name));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function unseal(ciphertext: Buffer, key: Buffer, exportId: string, file: z.infer<typeof encryptedFileSchema>) {
  if (ciphertext.length !== file.bytes || sha256(ciphertext) !== file.sha256) throw new Error(`Encrypted backup file failed checksum: ${file.name}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
  decipher.setAAD(aad(exportId, file.name));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  try { return Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
  catch { throw new Error("The backup passphrase is incorrect or an encrypted file was changed."); }
}

async function privateWrite(filename: string, contents: Uint8Array | string) {
  await writeFile(filename, contents, { mode: 0o600, flag: "wx" });
}

export async function createBackupWriter(directory: string, input: { exportId: string; createdAt: string; passphrase: string }) {
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const salt = randomBytes(16); const key = keyFor(input.passphrase, salt); const files: BackupEnvelope["parts"] = [];
  async function encrypted(name: string, plaintext: Buffer) {
    if (plaintext.length < 1 || plaintext.length > BACKUP_PART_BYTES) throw new Error("A backup part exceeded its bounded plaintext size.");
    const result = seal(plaintext, key, input.exportId, name);
    if (result.ciphertext.length > BACKUP_FILE_LIMIT) throw new Error("A backup part exceeded its encrypted file limit.");
    await privateWrite(path.join(directory, name), result.ciphertext);
    return { name, bytes: result.ciphertext.length, sha256: sha256(result.ciphertext), iv: result.iv, tag: result.tag };
  }
  return {
    async part(name: string, plaintext: Buffer) { const descriptor = await encrypted(name, plaintext); files.push(descriptor); return descriptor; },
    async finish(manifest: BackupManifest) {
      const descriptor = await encrypted("manifest.enc", Buffer.from(JSON.stringify(manifest), "utf8"));
      const envelope: BackupEnvelope = { format: BACKUP_FORMAT, exportId: input.exportId, createdAt: input.createdAt,
        encryption: { algorithm: "aes-256-gcm", kdf: "scrypt", salt: salt.toString("base64"), ...SCRYPT }, manifest: descriptor, parts: files };
      await privateWrite(path.join(directory, "backup.json"), `${JSON.stringify(envelope, null, 2)}\n`);
      return envelope;
    },
  };
}

async function readBounded(filename: string, maximum: number) {
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 1 || stat.size > maximum) throw new Error(`Backup file is outside its size boundary: ${path.basename(filename)}`);
    return await readFile(handle);
  } finally { await handle.close(); }
}

export async function verifyBackup(directory: string, passphrase: string) {
  const envelopeRaw = await readBounded(path.join(directory, "backup.json"), ENVELOPE_LIMIT);
  let envelope: BackupEnvelope;
  try { envelope = backupEnvelopeSchema.parse(JSON.parse(envelopeRaw.toString("utf8"))); }
  catch { throw new Error("The backup envelope is invalid or unsupported."); }
  if (envelope.manifest.name !== "manifest.enc" || new Set(envelope.parts.map(part => part.name)).size !== envelope.parts.length) throw new Error("Backup file inventory is invalid.");
  const key = keyFor(passphrase, Buffer.from(envelope.encryption.salt, "base64"));
  const manifestPlaintext = unseal(await readBounded(path.join(directory, envelope.manifest.name), BACKUP_FILE_LIMIT), key, envelope.exportId, envelope.manifest);
  let manifest: BackupManifest;
  try { manifest = backupManifestSchema.parse(JSON.parse(manifestPlaintext.toString("utf8"))); }
  catch { throw new Error("The encrypted backup manifest is invalid or unsupported."); }
  if (manifest.exportId !== envelope.exportId || manifest.createdAt !== envelope.createdAt) throw new Error("Backup envelope and manifest do not match.");
  const expected = new Map(manifest.parts.map(part => [part.name, part]));
  if (expected.size !== manifest.parts.length || envelope.parts.length !== manifest.parts.length) throw new Error("Backup part inventory does not match its manifest.");
  const assigned = manifest.tables.flatMap(table => table.parts.map(name => `${table.name}\0${name}`));
  if (assigned.length !== manifest.parts.length || new Set(assigned.map(value => value.split("\0")[1])).size !== manifest.parts.length
    || manifest.parts.some(part => !assigned.includes(`${part.table}\0${part.name}`))) throw new Error("Backup table and part inventories do not match.");
  for (const file of envelope.parts) {
    const part = expected.get(file.name); if (!part) throw new Error("Backup contains an unexpected part.");
    const plaintext = unseal(await readBounded(path.join(directory, file.name), BACKUP_FILE_LIMIT), key, envelope.exportId, file);
    if (plaintext.length !== part.plaintextBytes || sha256(plaintext) !== part.plaintextSha256) throw new Error(`Backup plaintext failed checksum: ${file.name}`);
    const rows = plaintext.toString("utf8").split("\n").filter(Boolean);
    if (rows.length !== part.rowCount) throw new Error(`Backup row count does not match: ${file.name}`);
    for (const row of rows) { try { const value = JSON.parse(row); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); } catch { throw new Error(`Backup contains an invalid structured row: ${file.name}`); } }
  }
  return { envelope, manifest, async plaintext(part: BackupPart) {
    const file = envelope.parts.find(value => value.name === part.name); if (!file) throw new Error("Backup part is missing.");
    return unseal(await readBounded(path.join(directory, file.name), BACKUP_FILE_LIMIT), key, envelope.exportId, file).toString("utf8");
  } };
}
