import { Pool } from 'pg';
import { AppError, notFound, uuidv7, assertPermission, type TenantPrincipal } from '@acct/domain';
import { recordAudit, readInTenant, writeInTenant } from '@acct/database';

/**
 * The document service — doc 21 Phase 3: "S3 attachment upload/download,
 * hashing/dedup support, file metadata and source links, malware scanning
 * integration point."
 *
 * Uploads and downloads are pre-signed rather than streamed through the API, so
 * a 40MB scan of a purchase order never occupies a request thread or a memory
 * buffer. The consequence is that the API never sees the bytes, which is why
 * F-705 added an upload state: the row exists from the moment the URL is issued,
 * and only the client can say whether anything arrived.
 *
 * The storage adapter is injected rather than imported. `apps/api` supplies an
 * S3/MinIO signer; the tests supply one that returns a deterministic string, so
 * the lifecycle can be tested without an object store — and without the test
 * quietly proving that a mock returns what it was told to.
 */

export interface StorageSigner {
  signUpload(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  signDownload(key: string, filename: string, expiresInSeconds: number): Promise<string>;
  head(key: string): Promise<{ size: number; sha256?: string | undefined } | null>;
  remove(key: string): Promise<void>;
}

const UPLOAD_TTL_SECONDS = 900;
const DOWNLOAD_TTL_SECONDS = 300;

/** doc 16: an attachment is evidence, so the accepted set is stated, not implied. */
const ALLOWED_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'message/rfc822',
]);

const MAX_BYTES = 50 * 1024 * 1024;

export class FilesService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageSigner,
  ) {}

  /**
   * Issues a pre-signed upload URL and the file row it will fill.
   *
   * The storage key is built from the tenant id, which migration 0001 enforces
   * with a CHECK (F-048) — a cross-tenant object key is impossible rather than
   * discouraged. The key is generated here and never accepted from the client
   * for the same reason.
   */
  async createUploadUrl(
    principal: TenantPrincipal,
    input: {
      filename: string;
      mediaType: string;
      byteSize?: number | undefined;
      sha256?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertPermission(principal, 'file.create');

      if (!ALLOWED_MEDIA_TYPES.has(input.mediaType)) {
        throw new AppError(
          'UNSUPPORTED_MEDIA_TYPE',
          `${input.mediaType} is not an accepted attachment type. Accepted: ` +
            [...ALLOWED_MEDIA_TYPES].join(', '),
          { details: { media_type: input.mediaType } },
        );
      }
      if (input.byteSize !== undefined && input.byteSize > MAX_BYTES) {
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          `${input.filename} is ${Math.round(input.byteSize / 1024 / 1024)}MB; the limit is ` +
            `${MAX_BYTES / 1024 / 1024}MB.`,
        );
      }

      // doc 13's dedup: if the client already knows the hash and we have that
      // content, hand back the existing file instead of storing it twice. The
      // same PDF attached to a bill and to an expense claim is one object with
      // two links.
      if (input.sha256) {
        const { rows: existing } = await client.query<{ id: string; storage_key: string }>(
          `SELECT id, storage_key FROM files
            WHERE tenant_id = $1 AND sha256 = $2 AND upload_state = 'COMPLETED'
            LIMIT 1`,
          [principal.tenantId, input.sha256],
        );
        if (existing[0]) {
          return {
            id: existing[0].id,
            upload_url: null,
            deduplicated: true,
            note: 'Content with this hash is already stored; link to it rather than uploading again.',
          };
        }
      }

      const id = uuidv7();
      const key = `${principal.tenantId}/${id}/${sanitize(input.filename)}`;
      await client.query(
        `INSERT INTO files (id, tenant_id, storage_key, original_filename, media_type, byte_size,
                            sha256, created_by, upload_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')`,
        [
          id,
          principal.tenantId,
          key,
          input.filename,
          input.mediaType,
          input.byteSize ?? null,
          input.sha256 ?? null,
          principal.userId,
        ],
      );

      const uploadUrl = await this.storage.signUpload(key, input.mediaType, UPLOAD_TTL_SECONDS);

      await recordAudit(client, context, {
        action: 'file.upload_requested',
        resourceType: 'file',
        resourceId: id,
        tenantId: principal.tenantId,
        after: { filename: input.filename, media_type: input.mediaType },
      });

      return {
        id,
        storage_key: key,
        upload_url: uploadUrl,
        expires_in: UPLOAD_TTL_SECONDS,
        deduplicated: false,
      };
    });
  }

  /**
   * Confirms the bytes arrived, and verifies it rather than believing it.
   *
   * `head` asks the object store what is actually there. A client that says
   * "done" without uploading, or that uploads something other than what it
   * declared, is the ordinary case rather than the malicious one — a dropped
   * connection produces exactly that — and a file row marked COMPLETED with no
   * object behind it is an attachment that fails at the worst moment, which is
   * when an auditor asks for it.
   */
  async completeUpload(
    principal: TenantPrincipal,
    id: string,
    input: {
      sha256?: string | undefined;
      links?:
        | ReadonlyArray<{ resourceType: string; resourceId: string; linkType?: string | undefined }>
        | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertPermission(principal, 'file.create');
      const { rows } = await client.query<{
        id: string;
        storage_key: string;
        upload_state: string;
        byte_size: string | null;
        sha256: string | null;
      }>(
        `SELECT id, storage_key, upload_state::text AS upload_state, byte_size::text AS byte_size,
                sha256
           FROM files WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const file = rows[0];
      if (!file) throw notFound('file', id);
      if (file.upload_state === 'COMPLETED') return this.linkAndReturn(client, id, input.links);

      const head = await this.storage.head(file.storage_key);
      if (!head) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Nothing has been uploaded to this file’s storage key yet. Complete the upload to ' +
            'the pre-signed URL first; the record stays PENDING until the object exists.',
          { details: { file_id: id } },
        );
      }
      const declared = input.sha256 ?? file.sha256;
      if (declared && head.sha256 && head.sha256 !== declared) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The stored object’s hash does not match the one declared for this upload, so the ' +
            'content is not what was described. The record stays PENDING.',
          { details: { declared, stored: head.sha256 } },
        );
      }

      await client.query(
        `UPDATE files
            SET upload_state = 'COMPLETED', completed_at = now(), uploaded_size = $2,
                sha256 = coalesce($3, sha256),
                byte_size = coalesce(byte_size, $2)
          WHERE id = $1`,
        [id, head.size, declared ?? head.sha256 ?? null],
      );

      await recordAudit(client, context, {
        action: 'file.uploaded',
        resourceType: 'file',
        resourceId: id,
        tenantId: principal.tenantId,
        after: { bytes: head.size, sha256: declared ?? head.sha256 ?? null },
      });

      return this.linkAndReturn(client, id, input.links);
    });
  }

  private async linkAndReturn(
    client: Parameters<typeof recordAudit>[0],
    id: string,
    links?:
      | ReadonlyArray<{ resourceType: string; resourceId: string; linkType?: string | undefined }>
      | undefined,
  ) {
    for (const link of links ?? []) {
      await client.query(
        `INSERT INTO file_links (file_id, resource_type, resource_id, link_type)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (file_id, resource_type, resource_id) DO NOTHING`,
        [id, link.resourceType, link.resourceId, link.linkType ?? 'ATTACHMENT'],
      );
    }
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT f.id, f.original_filename, f.media_type, f.byte_size::text AS byte_size, f.sha256,
              f.upload_state::text AS upload_state, f.scan_state::text AS scan_state,
              f.completed_at,
              coalesce(json_agg(json_build_object('resource_type', l.resource_type,
                'resource_id', l.resource_id, 'link_type', l.link_type))
                FILTER (WHERE l.file_id IS NOT NULL), '[]') AS links
         FROM files f
         LEFT JOIN file_links l ON l.file_id = f.id
        WHERE f.id = $1
        GROUP BY f.id`,
      [id],
    );
    return rows[0];
  }

  async getFile(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT f.id, f.original_filename, f.media_type, f.byte_size::text AS byte_size, f.sha256,
                f.upload_state::text AS upload_state, f.scan_state::text AS scan_state,
                f.created_by, f.created_at, f.completed_at,
                coalesce(json_agg(json_build_object('resource_type', l.resource_type,
                  'resource_id', l.resource_id, 'link_type', l.link_type))
                  FILTER (WHERE l.file_id IS NOT NULL), '[]') AS links
           FROM files f
           LEFT JOIN file_links l ON l.file_id = f.id
          WHERE f.id = $1
          GROUP BY f.id`,
        [id],
      );
      if (!rows[0]) throw notFound('file', id);
      return rows[0];
    });
  }

  /**
   * F-718. A short-lived download URL, refused unless the file is complete and
   * the scan came back clean.
   *
   * PENDING and INFECTED are refused for different reasons and get different
   * messages: one is a file that does not exist yet, the other is a file nobody
   * should open. SKIPPED is permitted, because a deployment with no scanner
   * configured should not be a deployment where attachments cannot be read —
   * but it is reported in the response so the caller knows what it is holding.
   */
  async createDownloadUrl(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'file.view');
      const { rows } = await client.query<{
        id: string;
        storage_key: string;
        original_filename: string;
        upload_state: string;
        scan_state: string;
      }>(
        `SELECT id, storage_key, original_filename, upload_state::text AS upload_state,
                scan_state::text AS scan_state
           FROM files WHERE id = $1`,
        [id],
      );
      const file = rows[0];
      if (!file) throw notFound('file', id);

      if (file.upload_state !== 'COMPLETED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This file is ${file.upload_state}: the upload was never confirmed, so there may be ` +
            'nothing behind the key.',
          { details: { upload_state: file.upload_state } },
        );
      }
      if (file.scan_state === 'INFECTED') {
        throw new AppError(
          'FORBIDDEN',
          'This file was flagged by the malware scanner and cannot be downloaded.',
          { details: { scan_state: file.scan_state } },
        );
      }
      if (file.scan_state === 'PENDING') {
        throw new AppError(
          'VALIDATION_FAILED',
          'This file has not been scanned yet. Try again shortly.',
          { details: { scan_state: file.scan_state } },
        );
      }

      const url = await this.storage.signDownload(
        file.storage_key,
        file.original_filename,
        DOWNLOAD_TTL_SECONDS,
      );
      return {
        id: file.id,
        download_url: url,
        expires_in: DOWNLOAD_TTL_SECONDS,
        filename: file.original_filename,
        scan_state: file.scan_state,
      };
    });
  }

  /**
   * Deletes a file, refusing anything attached to posted history.
   *
   * doc 01: posted history is not destroyed, and an attachment to a posted bill
   * is part of the evidence for it. A draft's attachment is fair game; the check
   * is on what the file is linked to, not on the file.
   */
  async deleteFile(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertPermission(principal, 'file.delete');
      const { rows } = await client.query<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM files WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const file = rows[0];
      if (!file) throw notFound('file', id);

      const { rows: posted } = await client.query<{ resource_type: string; resource_id: string }>(
        `SELECT l.resource_type, l.resource_id
           FROM file_links l
          WHERE l.file_id = $1
            AND ( (l.resource_type = 'invoice' AND EXISTS (
                     SELECT 1 FROM invoices i WHERE i.id = l.resource_id
                       AND i.status NOT IN ('DRAFT','PENDING_APPROVAL','APPROVED')))
               OR (l.resource_type = 'vendor_bill' AND EXISTS (
                     SELECT 1 FROM vendor_bills b WHERE b.id = l.resource_id
                       AND b.status NOT IN ('DRAFT','PENDING_APPROVAL','APPROVED'))) )`,
        [id],
      );
      if (posted.length > 0) {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `This file is attached to ${posted.length} posted document(s) and is part of the ` +
            'evidence for them (doc 01). Detach it from the draft that no longer needs it, or ' +
            'leave it where it is.',
          { details: { attached_to: posted } },
        );
      }

      await client.query(`DELETE FROM file_links WHERE file_id = $1`, [id]);
      await client.query(`DELETE FROM files WHERE id = $1`, [id]);
      await this.storage.remove(file.storage_key);

      await recordAudit(client, context, {
        action: 'file.deleted',
        resourceType: 'file',
        resourceId: id,
        tenantId: principal.tenantId,
        before: file as unknown as Record<string, unknown>,
      });
      return { id, deleted: true };
    });
  }
}

/** Keeps the original name recognisable without letting it choose the key's shape. */
function sanitize(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}
