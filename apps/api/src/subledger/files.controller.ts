import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { FilesService } from '@acct/subledger';
import { Operation } from '../common/operation';
import { parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 21 Phase 3's document service. Four operations and no bytes: the API issues
 * pre-signed URLs and the client transfers directly to storage, so a 40MB scan
 * never occupies a request thread.
 *
 * `POST /files/upload-url` is therefore only half a lifecycle — F-705 added the
 * upload state because the row exists from the moment the URL is issued and only
 * `POST /files/{id}/complete` can say whether anything arrived.
 */

const UploadUrlBody = z.object({
  filename: z.string().trim().min(1).max(255),
  media_type: z.string().trim().min(1).max(120),
  byte_size: z.number().int().min(0).optional(),
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, 'a hex SHA-256 digest')
    .optional(),
});

const CompleteBody = z.object({
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, 'a hex SHA-256 digest')
    .optional(),
  links: z
    .array(
      z.object({
        resource_type: z.string().trim().min(1).max(60),
        resource_id: uuid,
        link_type: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .max(20)
    .optional(),
});

@Controller()
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post('files/upload-url')
  @Operation('createUploadUrl')
  async createUploadUrl(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(UploadUrlBody, body);
    return this.files.createUploadUrl(tenantPrincipal(request), {
      filename: input.filename,
      mediaType: input.media_type,
      byteSize: input.byte_size,
      sha256: input.sha256,
    });
  }

  @Post('files/:id/complete')
  @Operation('completeUpload')
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(CompleteBody, body);
    return this.files.completeUpload(tenantPrincipal(request), parse(uuid, id), {
      sha256: input.sha256,
      links: input.links?.map((l) => ({
        resourceType: l.resource_type,
        resourceId: l.resource_id,
        linkType: l.link_type,
      })),
    });
  }

  @Get('files/:id')
  @Operation('getFile')
  async getFile(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.files.getFile(tenantPrincipal(request), parse(uuid, id));
  }

  @Get('files/:id/download-url')
  @Operation('createDownloadUrl')
  async downloadUrl(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.files.createDownloadUrl(tenantPrincipal(request), parse(uuid, id));
  }

  @Delete('files/:id')
  @Operation('deleteFile')
  async deleteFile(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    await this.files.deleteFile(tenantPrincipal(request), parse(uuid, id));
  }
}
