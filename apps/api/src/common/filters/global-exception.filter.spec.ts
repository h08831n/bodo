import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
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
});
