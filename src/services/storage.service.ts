import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private supabase: SupabaseClient;
  
  readonly productImageBucket = 'product-image';
  readonly productGalleryBucket = 'product-gallery';
  readonly scanHistoryBucket = 'scan-history';

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_KEY');
    
    if (!supabaseUrl || !supabaseKey) {
      this.logger.warn('Supabase URL or Key not set. Storage uploads will fail.');
    }
    
    this.supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');
  }

  async uploadImage(
    imageBuffer: Buffer,
    filename: string,
    contentType: string = 'image/jpeg',
    bucketName?: string,
  ): Promise<string> {
    const ext = filename.includes('.') ? filename.split('.').pop() : 'jpg';
    const uniqueFilename = `${crypto.randomUUID()}.${ext}`;
    const targetBucket = bucketName || this.productImageBucket;

    this.logger.log(`Uploading file ${filename} as ${uniqueFilename} to bucket ${targetBucket}...`);

    const { data, error } = await this.supabase.storage
      .from(targetBucket)
      .upload(uniqueFilename, imageBuffer, {
        contentType: contentType,
        upsert: true,
      });

    if (error) {
      this.logger.error(`Failed to upload image to Supabase: ${error.message}`);
      throw error;
    }

    const { data: publicUrlData } = this.supabase.storage
      .from(targetBucket)
      .getPublicUrl(uniqueFilename);

    return publicUrlData.publicUrl;
  }
}
