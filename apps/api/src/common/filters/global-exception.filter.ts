import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ApiErrorResponse, ErrorCode } from '@bodo/contracts';
import { LoggerService } from '../logger/logger.service';
import {
  DatabaseRequiredError,
  DatabaseNotFoundError,
  DatabaseMaintenanceError,
} from '../../infra/tenancy/errors';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger?: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId =
      request.requestId ||
      (request.headers ? (request.headers['x-request-id'] as string) : undefined) ||
      randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'INTERNAL';
    let message = 'خطای داخلی سرور رخ داده است. لطفاً بعداً دوباره تلاش کنید.';
    let details: Array<{ path?: string; message: string }> | undefined;

    // 1. Tenancy errors
    if (exception instanceof DatabaseRequiredError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'DATABASE_REQUIRED';
      message = exception.message || 'شناسه یا نام دیتابیس شرکت در درخواست الزامی است.';
    } else if (exception instanceof DatabaseNotFoundError) {
      status = HttpStatus.NOT_FOUND;
      code = 'DATABASE_NOT_FOUND';
      message = exception.message || 'دیتابیس شرکت یافت نشد یا معتبر نیست.';
    } else if (exception instanceof DatabaseMaintenanceError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'DATABASE_MAINTENANCE';
      message = exception.message || 'دیتابیس شرکت در حال حاضر در حالت تعمیرات است.';
      response.setHeader('Retry-After', String(exception.retryAfterSeconds || 60));
    }
    // 2. Body-parser malformed JSON or payload too large
    else if (
      (exception instanceof SyntaxError &&
        ((exception as unknown as Record<string, unknown>).status === 400 ||
          'body' in exception ||
          (exception as unknown as Record<string, unknown>).type === 'entity.parse.failed')) ||
      (typeof exception === 'object' &&
        exception !== null &&
        (exception as Record<string, unknown>).type === 'entity.parse.failed')
    ) {
      status = HttpStatus.BAD_REQUEST;
      code = 'VALIDATION_FAILED';
      message = 'قالب داده ارسالی (JSON) نامعتبر است.';
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      ((exception as Record<string, unknown>).type === 'entity.too.large' ||
        (exception as Record<string, unknown>).status === 413)
    ) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'حجم بدنه درخواست بیش از حد مجاز است.';
    }
    // 3. ZodValidationException (from nestjs-zod) or raw ZodError
    else if (
      (typeof exception === 'object' &&
        exception !== null &&
        (exception as Record<string, unknown>).name === 'ZodValidationException') ||
      exception instanceof ZodError ||
      (typeof exception === 'object' &&
        exception !== null &&
        (exception as Record<string, unknown>).name === 'ZodError')
    ) {
      status = HttpStatus.BAD_REQUEST;
      code = 'VALIDATION_FAILED';
      message = 'داده‌های ارسالی معتبر نیستند.';

      const zodObj =
        typeof (exception as Record<string, unknown>).getZodError === 'function'
          ? (exception as { getZodError: () => ZodError }).getZodError()
          : exception;

      const issues =
        (zodObj as ZodError).issues ||
        (zodObj as { errors?: Array<{ path?: unknown; message: string }> }).errors;
      if (Array.isArray(issues)) {
        details = issues.map((err) => ({
          path: Array.isArray(err.path) ? err.path.join('.') : String(err.path ?? ''),
          message: err.message,
        }));
      }
    }
    // 4. Prisma known request errors
    else if (
      typeof exception === 'object' &&
      exception !== null &&
      (exception as Record<string, unknown>).name === 'PrismaClientKnownRequestError'
    ) {
      const prismaCode = (exception as Record<string, unknown>).code;
      switch (prismaCode) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          code = 'CONFLICT';
          message = 'رکورد تکراری است یا با رکورد دیگری تداخل دارد.';
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          code = 'NOT_FOUND';
          message = 'منبع مورد نظر یافت نشد.';
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          code = 'VALIDATION_FAILED';
          message = 'ارجاع به رکورد نامعتبر است.';
          break;
        case 'P2034':
          status = HttpStatus.CONFLICT;
          code = 'CONFLICT';
          message = 'تداخل تراکنش هم‌زمان، لطفاً دوباره تلاش کنید.';
          break;
        default:
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          code = 'INTERNAL';
          message = 'خطای پایگاه داده رخ داده است.';
          break;
      }
    }
    // 5. Standard NestJS HttpException
    else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        if (typeof obj.message === 'string') {
          message = obj.message;
        } else if (Array.isArray(obj.message)) {
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
            if (
              message === 'Bad Request' ||
              /JSON|Unexpected token|Unterminated string|Expected property name|is not valid JSON/i.test(
                message,
              )
            ) {
              message = 'قالب داده ارسالی (JSON) نامعتبر است.';
            }
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
          case HttpStatus.UNPROCESSABLE_ENTITY:
            code = 'IDEMPOTENCY_KEY_REUSED';
            if (message === 'Unprocessable Entity') message = 'درخواست قابل پردازش نیست.';
            break;
          case HttpStatus.PAYLOAD_TOO_LARGE:
            code = 'PAYLOAD_TOO_LARGE';
            if (message === 'Payload Too Large') message = 'حجم بدنه درخواست بیش از حد مجاز است.';
            break;
          case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
            code = 'UNSUPPORTED_MEDIA_TYPE';
            if (message === 'Unsupported Media Type')
              message = 'قالب رسانه درخواست پشتیبانی نمی‌شود.';
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

    if (typeof response.setHeader === 'function') {
      response.setHeader('X-Request-Id', requestId);
    }
    if (typeof response.removeHeader === 'function') {
      response.removeHeader('X-Powered-By');
      response.removeHeader('x-powered-by');
    }
    response.status(status).json(errorBody);
  }
}
