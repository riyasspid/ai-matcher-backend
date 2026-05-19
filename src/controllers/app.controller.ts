import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Headers,
  InternalServerErrorException,
  BadRequestException,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DatabaseService } from '../database/database.service';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../services/storage.service';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Controller()
export class AppController {
  private supabase: SupabaseClient;

  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_KEY');
    this.supabase = createClient(
      supabaseUrl || 'https://placeholder.supabase.co',
      supabaseKey || 'placeholder',
    );
  }

  // Health endpoint
  @Get('health')
  healthCheck() {
    return { status: 'ok' };
  }

  // DB connection test endpoint
  @Get('health/db')
  async dbHealthCheck() {
    try {
      const result = await this.db.query('SELECT 1 as val');
      return { status: 'ok', db: result.rows[0].val };
    } catch (error) {
      throw new InternalServerErrorException(`DB connection failed: ${error.message}`);
    }
  }

  @Post('auth/login')
  async login(@Body() body: any) {
    const { email, password } = body;
    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }

    try {
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data.user) {
        throw new UnauthorizedException(error?.message || 'Invalid email or password');
      }

      // Query database profile to ensure user exists in public table
      const userCheck = await this.db.query(
        'SELECT id, email, full_name, avatar_url FROM users WHERE id = $1',
        [data.user.id],
      );

      // If user profile is not in the public database, sync it!
      let profile = userCheck.rows[0];
      if (!profile) {
        const result = await this.db.query(
          `INSERT INTO users (id, email, full_name, avatar_url) 
           VALUES ($1, $2, $3, $4) 
           RETURNING id, email, full_name, avatar_url`,
          [
            data.user.id,
            data.user.email,
            data.user.user_metadata?.full_name || email.split('@')[0],
            data.user.user_metadata?.avatar_url || '',
          ],
        );
        profile = result.rows[0];
      }

      return {
        session: {
          access_token: data.session?.access_token,
          expires_at: data.session?.expires_at,
        },
        user: {
          id: profile.id,
          email: profile.email,
          full_name: profile.full_name,
          avatar_url: profile.avatar_url || '',
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(`Login failed: ${error.message}`);
    }
  }

  // Active session profile details
  @Get('me')
  async getMe(@Headers('x-user-id') userIdHeader?: string) {
    const activeUserId = userIdHeader || '00000000-0000-0000-0000-000000000000';
    try {
      const result = await this.db.query(
        'SELECT id, email, full_name, avatar_url FROM users WHERE id = $1',
        [activeUserId],
      );
      if (result.rows.length > 0) {
        return {
          id: result.rows[0].id,
          email: result.rows[0].email,
          full_name: result.rows[0].full_name,
          avatar_url: result.rows[0].avatar_url || '',
        };
      }
    } catch (e) {
      // fallback
    }

    return {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'salesman@example.com',
      full_name: 'Luxe Furniture Admin',
      avatar_url: 'https://i.pravatar.cc/150?u=00000000-0000-0000-0000-000000000000',
    };
  }

  // Edit user profile (update full_name and/or upload avatar to avatars bucket)
  @Put('auth/profile')
  @UseInterceptors(FileInterceptor('file'))
  async updateProfile(
    @Headers('x-user-id') userIdHeader: string,
    @UploadedFile() file?: Express.Multer.File,
    @Body('full_name') fullName?: string,
  ) {
    const activeUserId = userIdHeader || '00000000-0000-0000-0000-000000000000';

    try {
      let avatarUrl: string | null = null;

      if (file) {
        // Upload the new avatar to Supabase Storage avatars bucket
        avatarUrl = await this.storageService.uploadImage(
          file.buffer,
          file.originalname || 'avatar.jpg',
          file.mimetype || 'image/jpeg',
          'avatars', // New bucket specified by the user!
        );
      }

      // Perform update query dynamically based on passed parameters
      const setStatements: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (fullName !== undefined && fullName !== null) {
        setStatements.push(`full_name = $${idx}`);
        values.push(fullName);
        idx++;
      }

      if (avatarUrl !== null) {
        setStatements.push(`avatar_url = $${idx}`);
        values.push(avatarUrl);
        idx++;
      }

      if (setStatements.length > 0) {
        values.push(activeUserId);
        const queryStr = `UPDATE users SET ${setStatements.join(', ')} WHERE id = $${idx} RETURNING *`;
        const result = await this.db.query(queryStr, values);
        
        return {
          id: result.rows[0].id,
          email: result.rows[0].email,
          full_name: result.rows[0].full_name,
          avatar_url: result.rows[0].avatar_url || '',
        };
      }

      // If no updates passed, just return existing profile
      const check = await this.db.query(
        'SELECT id, email, full_name, avatar_url FROM users WHERE id = $1',
        [activeUserId],
      );
      if (check.rows.length === 0) {
        throw new BadRequestException('User profile not found');
      }

      return {
        id: check.rows[0].id,
        email: check.rows[0].email,
        full_name: check.rows[0].full_name,
        avatar_url: check.rows[0].avatar_url || '',
      };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to update profile: ${error.message}`);
    }
  }
}
