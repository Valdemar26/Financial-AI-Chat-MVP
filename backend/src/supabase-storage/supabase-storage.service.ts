import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const DOCUMENTS_BUCKET = 'documents';
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60; // 1 hour

@Injectable()
export class SupabaseStorageService {
  private readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    // Only Storage is used here, but the SDK constructs a RealtimeClient
    // unconditionally, which needs a WebSocket constructor. Node 20 has none
    // natively, so provide `ws` as the transport (Node 22+ wouldn't need this).
    this.client = createClient(
      config.getOrThrow<string>('SUPABASE_URL'),
      config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      { realtime: { transport: WebSocket as never } },
    );
  }

  async upload(buffer: Buffer, path: string): Promise<void> {
    const { error } = await this.client.storage.from(DOCUMENTS_BUCKET).upload(path, buffer, {
      upsert: false,
    });
    if (error) {
      throw new InternalServerErrorException(`Failed to upload file: ${error.message}`);
    }
  }

  async download(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(DOCUMENTS_BUCKET).download(path);
    if (error || !data) {
      throw new InternalServerErrorException(`Failed to download file: ${error?.message}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async getSignedUrl(path: string): Promise<string> {
    const { data, error } = await this.client.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS);

    if (error || !data) {
      throw new InternalServerErrorException(`Failed to create signed URL: ${error?.message}`);
    }
    return data.signedUrl;
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.client.storage.from(DOCUMENTS_BUCKET).remove([path]);
    if (error) {
      throw new InternalServerErrorException(`Failed to delete file: ${error.message}`);
    }
  }
}
