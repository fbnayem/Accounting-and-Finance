/**
 * The S3 side of `StorageSigner`.
 *
 * `@acct/subledger` declares the interface and never imports an SDK, because the
 * worker and the tests need the same file lifecycle without an object store — and
 * a test that swaps in a mock proves nothing unless the production adapter is a
 * thin, obvious translation. This is that translation and nothing else: no
 * retries, no caching, no key construction. The key is built in `FilesService`
 * from the tenant id, which is where migration 0001's CHECK can see it.
 *
 * Path-style addressing is the default because the local stack is MinIO, where
 * virtual-host style requires DNS the developer does not have.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageSigner } from '@acct/subledger';

export interface S3StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export class S3Storage implements StorageSigner {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async signUpload(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    // ContentType is signed, so the client cannot upload a script under a URL
    // that was issued for a PDF. Without it the media-type allowlist in
    // FilesService checks a value nothing later enforces.
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }

  async signDownload(key: string, filename: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        // Browsers otherwise render the storage key, which contains the tenant id.
        ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, '')}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string): Promise<{ size: number; sha256?: string | undefined } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return {
        size: response.ContentLength ?? 0,
        // S3's ChecksumSHA256 is base64; the file row stores hex, and only the
        // caller's declared hash is trusted for dedup, so this stays optional.
        ...(response.ChecksumSHA256 ? { sha256: hex(response.ChecksumSHA256) } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}

function hex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex');
}

/**
 * A missing object is an answer, not a failure — `completeUpload` calls `head` to
 * find out whether anything actually arrived, and that question has a legitimate
 * "no". Every other error still propagates: treating a credentials failure as
 * "the file is not there" would report an abandoned upload for a bucket the API
 * simply cannot reach.
 */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
