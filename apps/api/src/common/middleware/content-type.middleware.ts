import { Injectable, NestMiddleware, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH']);

@Injectable()
export class ContentTypeValidationMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    if (MUTATION_METHODS.has(req.method.toUpperCase())) {
      const contentLength = req.headers['content-length'];
      const transferEncoding = req.headers['transfer-encoding'];
      const hasBody = (contentLength && parseInt(contentLength, 10) > 0) || transferEncoding;

      if (hasBody) {
        const contentType = req.headers['content-type'];
        if (!contentType) {
          throw new UnsupportedMediaTypeException({
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'هدر Content-Type برای درخواست‌های دارای بدنه الزامی است.',
          });
        }

        const isJson = contentType.includes('application/json');
        const isMultipart = contentType.includes('multipart/form-data');
        const isUrlEncoded = contentType.includes('application/x-www-form-urlencoded');

        if (!isJson && !isMultipart && !isUrlEncoded) {
          throw new UnsupportedMediaTypeException({
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message:
              'قالب رسانه درخواست پشتیبانی نمی‌شود. لطفاً Content-Type را application/json ارسال کنید.',
          });
        }
      }
    }

    next();
  }
}
