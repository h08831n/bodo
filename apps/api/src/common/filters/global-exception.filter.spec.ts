import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { GlobalExceptionFilter } from './global-exception.filter';
import {
  DatabaseRequiredError,
  DatabaseNotFoundError,
  DatabaseMaintenanceError,
} from '../../infra/tenancy/errors';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  const createMockHost = (requestId = 'test-req-123') => {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const setHeaderMock = jest.fn();

    const mockResponse = {
      status: statusMock,
      setHeader: setHeaderMock,
    };

    const mockRequest = {
      requestId,
    };

    const host = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;

    return { host, statusMock, jsonMock, setHeaderMock };
  };

  it('formats HttpException with standard Persian error format', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const exception = new HttpException('منبع یافت نشد', HttpStatus.NOT_FOUND);

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'NOT_FOUND',
        message: 'منبع یافت نشد',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('formats unhandled exceptions with 500 INTERNAL and generic Persian message', () => {
    const { host, statusMock, jsonMock } = createMockHost('req-err-456');
    const exception = new Error('Database connection crashed');

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL',
        message: 'خطای داخلی سرور رخ داده است. لطفاً بعداً دوباره تلاش کنید.',
        details: undefined,
        requestId: 'req-err-456',
      },
    });
  });

  it('preserves custom error codes and validation details if provided', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const exception = new HttpException(
      {
        code: 'VALIDATION_FAILED',
        message: 'ورودی نامعتبر است',
        details: [{ path: 'username', message: 'نام کاربری تکراری است' }],
      },
      HttpStatus.BAD_REQUEST,
    );

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'ورودی نامعتبر است',
        details: [{ path: 'username', message: 'نام کاربری تکراری است' }],
        requestId: 'test-req-123',
      },
    });
  });

  it('maps DatabaseRequiredError to 400 DATABASE_REQUIRED', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const exception = new DatabaseRequiredError();

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'DATABASE_REQUIRED',
        message: 'شناسه یا نام دیتابیس شرکت در درخواست الزامی است',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps DatabaseNotFoundError to 404 DATABASE_NOT_FOUND', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const exception = new DatabaseNotFoundError();

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'DATABASE_NOT_FOUND',
        message: 'دیتابیس شرکت یافت نشد یا معتبر نیست',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps DatabaseMaintenanceError to 503 DATABASE_MAINTENANCE with Retry-After header', () => {
    const { host, statusMock, jsonMock, setHeaderMock } = createMockHost();
    const exception = new DatabaseMaintenanceError('erp_acme', 'ارتقای ساختار', 120);

    filter.catch(exception, host);

    expect(setHeaderMock).toHaveBeenCalledWith('Retry-After', '120');
    expect(statusMock).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'DATABASE_MAINTENANCE',
        message: 'دیتابیس شرکت (erp_acme) در حالت تعمیرات است: ارتقای ساختار',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps ZodError to 400 VALIDATION_FAILED with field paths and Persian message', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const zodSchema = z.object({
      adminPassword: z.string().min(10, 'Password must be at least 10 characters'),
    });

    let zodError: unknown;
    try {
      zodSchema.parse({ adminPassword: 'short' });
    } catch (err) {
      zodError = err;
    }

    filter.catch(zodError, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'داده‌های ارسالی معتبر نیستند.',
        details: [
          {
            path: 'adminPassword',
            message: 'Password must be at least 10 characters',
          },
        ],
        requestId: 'test-req-123',
      },
    });
  });

  it('maps malformed JSON SyntaxError to 400 VALIDATION_FAILED', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const syntaxError = Object.assign(
      new SyntaxError('Unexpected token } in JSON at position 12'),
      {
        status: 400,
        body: '{ invalid: }',
      },
    );

    filter.catch(syntaxError, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'قالب داده ارسالی (JSON) نامعتبر است.',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps 413 payload too large to PAYLOAD_TOO_LARGE', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const error = { type: 'entity.too.large', status: 413 };

    filter.catch(error, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'حجم بدنه درخواست بیش از حد مجاز است.',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps 415 unsupported media type to UNSUPPORTED_MEDIA_TYPE', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const exception = new HttpException(
      'Unsupported Media Type',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'قالب رسانه درخواست پشتیبانی نمی‌شود.',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps Prisma P2002 to 409 CONFLICT', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const error = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      message: 'Unique constraint failed on the fields: (`email`)',
    };

    filter.catch(error, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'CONFLICT',
        message: 'رکورد تکراری است یا با رکورد دیگری تداخل دارد.',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });

  it('maps Prisma P2025 to 404 NOT_FOUND', () => {
    const { host, statusMock, jsonMock } = createMockHost();
    const error = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2025',
      message: 'Record to update not found.',
    };

    filter.catch(error, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'NOT_FOUND',
        message: 'منبع مورد نظر یافت نشد.',
        details: undefined,
        requestId: 'test-req-123',
      },
    });
  });
});
