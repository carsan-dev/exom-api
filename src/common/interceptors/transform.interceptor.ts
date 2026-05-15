import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { UploadsService } from '../../modules/uploads/uploads.service';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  private readonly mediaUrlKeys = new Set([
    'avatar_url',
    'media_url',
    'clientAvatar',
    'image_url',
    'thumbnail_url',
    'video_url',
  ]);

  constructor(private readonly uploadsService?: UploadsService) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      mergeMap((data) => from(this.buildResponse(data))),
    );
  }

  private async buildResponse(data: T): Promise<ApiResponse<T>> {
    const signedData = await this.signMediaUrls(data);
    return {
      success: true,
      data: signedData as T,
      timestamp: new Date().toISOString(),
    };
  }

  private async signMediaUrls(value: unknown): Promise<unknown> {
    if (!this.uploadsService || value == null) {
      return value;
    }

    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.signMediaUrls(item)));
    }

    if (typeof value !== 'object' || value instanceof Date) {
      return value;
    }

    const signedEntries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(
        async ([key, entryValue]) => {
          if (this.mediaUrlKeys.has(key) && typeof entryValue === 'string') {
            return [
              key,
              await this.uploadsService!.getSignedReadUrl(entryValue),
            ];
          }

          return [key, await this.signMediaUrls(entryValue)];
        },
      ),
    );

    return Object.fromEntries(signedEntries);
  }
}
