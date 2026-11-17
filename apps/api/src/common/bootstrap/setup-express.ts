import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'crypto';

/**
 * Configures foundational Express middleware and security settings in strict order.
 * Shared between main.ts production bootstrap and createTestApp() to guarantee
 * 100% parity across test and production environments.
 *
 * Execution order:
 * 1. Disable X-Powered-By
 * 2. Trust proxy
 * 3. Helmet security headers (before body-parsers so even parsing errors get security headers)
 * 4. RequestId assignment (before body-parsers so even malformed JSON gets a real requestId)
 * 5. Content-Type check (rejecting unsupported media types with 415 and Persian message)
 * 6. Body parsers with 1MB limit
 */
export function setupExpressApp(expressApp: express.Express): void {
  // 1. Disable X-Powered-By header unconditionally across all responses
  expressApp.disable('x-powered-by');

  // 2. Trust proxy for accurate client IP behind reverse proxy / Nginx
  expressApp.set('trust proxy', true);

  // 3. Security headers (Helmet) registered FIRST before body parsers and routes
  expressApp.use(helmet());

  // 4. Request ID middleware registered BEFORE body parsers so errors during parsing have a valid UUID requestId
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    const existingHeader = req.headers['x-request-id'];
    const requestId =
      (Array.isArray(existingHeader) ? existingHeader[0] : existingHeader) || randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

  // 5. Strict Content-Type guard for mutating HTTP methods with a body
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const contentLength = req.headers['content-length'];
      const transferEncoding = req.headers['transfer-encoding'];
      const hasBody =
        (contentLength !== undefined && parseInt(contentLength, 10) > 0) ||
        Boolean(transferEncoding);

      if (hasBody) {
        // Allow JSON and multipart for file uploads
        if (
          !req.is('json') &&
          !req.is('multipart/form-data') &&
          !req.is('application/x-www-form-urlencoded')
        ) {
          const requestId =
            req.requestId || (req.headers['x-request-id'] as string) || randomUUID();
          res.setHeader('X-Request-Id', requestId);
          res.removeHeader('X-Powered-By');
          res.removeHeader('x-powered-by');
          return res.status(415).json({
            error: {
              code: 'UNSUPPORTED_MEDIA_TYPE',
              message:
                'قالب رسانه درخواست پشتیبانی نمی‌شود. لطفاً درخواست را به صورت application/json ارسال کنید.',
              requestId,
            },
          });
        }
      }
    }
    next();
  });

  // 6. Express body limits
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.use(express.urlencoded({ extended: true, limit: '1mb' }));
}
