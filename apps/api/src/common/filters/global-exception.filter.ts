import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiErrorResponse, ErrorCode } from '@bodo/contracts';
import { LoggerService } from '../logger/logger.service';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger?: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId || 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'INTERNAL';
    let message = 'خطای داخلی سرور رخ داده است. لطفاً بعداً دوباره تلاش کنید.';
    let details: Array<{ path?: string; message: string }> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        if (typeof obj.message === 'string') {
          message = obj.message;
        } else if (Array.isArray(obj.message)) {
          // NestJS default ValidationPipe format
          details = obj.message.map((msg: unknown) => ({
            message: String(msg),
          }));
          message = 'داده‌های ارسالی معتبر نیستند.';
        }
        if (typeof obj.code === 'string') {
          code = obj.code as ErrorCode;
        }
        if (Array.isArray(obj.details)) {
          details = obj.details as Array<{ path?: string; message: string }>;
        }
      }

      // Map HTTP status codes to standard error codes if not explicitly set
      if (code === 'INTERNAL') {
        switch (status) {
          case HttpStatus.BAD_REQUEST:
            code = 'VALIDATION_FAILED';
            if (message === 'Bad Request') message = 'درخواست نامعتبر است.';
            break;
          case HttpStatus.UNAUTHORIZED:
            code = 'UNAUTHENTICATED';
            if (message === 'Unauthorized') message = 'لطفاً ابتدا وارد سیستم شوید.';
            break;
          case HttpStatus.FORBIDDEN:
            code = 'FORBIDDEN';
            if (message === 'Forbidden') message = 'شما دسترسی لازم برای این عملیات را ندارید.';
            break;
          case HttpStatus.NOT_FOUND:
            code = 'NOT_FOUND';
            if (message === 'Not Found') message = 'منبع مورد نظر یافت نشد.';
            break;
          case HttpStatus.CONFLICT:
            code = 'CONFLICT';
            if (message === 'Conflict') message = 'تداخل داده‌ها رخ داده است.';
            break;
          case HttpStatus.TOO_MANY_REQUESTS:
            code = 'RATE_LIMITED';
            if (message === 'Too Many Requests')
              message = 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی صبر کنید.';
            break;
          case HttpStatus.SERVICE_UNAVAILABLE:
            code = 'DATABASE_MAINTENANCE';
            if (message === 'Service Unavailable')
              message = 'سیستم در حال به‌روزرسانی یا تعمیرات است.';
            break;
        }
      }
    } else if (exception instanceof Error) {
      if (this.logger) {
        this.logger.error(
          `Unhandled exception: ${exception.message}`,
          exception.stack,
          'GlobalExceptionFilter',
          {
            requestId,
          },
        );
      }
    }

    const errorBody: ApiErrorResponse = {
      error: {
        code,
        message,
        details,
        requestId,
      },
    };

    response.status(status).json(errorBody);
  }
}
