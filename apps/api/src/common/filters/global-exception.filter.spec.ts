import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  const createMockHost = (requestId = 'test-req-123') => {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    const mockResponse = {
      status: statusMock,
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

    return { host, statusMock, jsonMock };
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
});
