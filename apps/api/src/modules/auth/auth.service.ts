import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { getEnv } from '../../config/env.config';
import { PasswordPolicy } from '../../common/auth/password-policy';
import { PasswordHasher } from '../../common/auth/password-hasher';
import { TokenService, AccessTokenClaims } from '../../common/auth/token.service';
import { RefreshTokenService } from '../../common/auth/refresh-token.service';
import { AuthRevocationService } from '../../common/auth/auth-revocation.service';
import { AuthRateLimitService } from '../../common/auth/auth-rate-limit.service';
import { AuditWriter } from '../../common/audit/audit-writer';
import { PermissionService } from '../../common/permissions/permission.service';
import { TenantClientManager } from '../../infra/tenancy/tenant-client-manager';
import {
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  MeResponse,
  SessionsListResponse,
  LogoutResponse,
  LogoutAllResponse,
  DeleteSessionResponse,
} from '@bodo/contracts';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly authRevocationService: AuthRevocationService,
    private readonly authRateLimitService: AuthRateLimitService,
    private readonly auditWriter: AuditWriter,
    private readonly permissionService: PermissionService,
    private readonly tenantClientManager: TenantClientManager,
  ) {}

  private parseCookies(header?: string): Record<string, string> {
    if (!header) return {};
    const cookies: Record<string, string> = {};
    for (const pair of header.split(';')) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const key = pair.substring(0, idx).trim();
      const val = pair.substring(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
    return cookies;
  }

  private verifyCsrf(req: Request): boolean {
    const env = getEnv();
    const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
    const origin = (req.headers['origin'] || req.headers['referer'] || '') as string;
    if (!origin) return false;
    return allowedOrigins.some((allowed) => origin.startsWith(allowed));
  }

  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      if (first) return first.trim();
    }
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
  }

  private getCookieName(db: string): string {
    const slug = db.startsWith('erp_') ? db.replace('erp_', '') : db;
    return `bodo_rt_${slug}`;
  }

  private setRefreshTokenCookie(res: Response, db: string, token: string): void {
    const env = getEnv();
    res.cookie(this.getCookieName(db), token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/v1/auth',
      secure: env.COOKIE_SECURE,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }

  private clearRefreshTokenCookie(res: Response, db: string): void {
    const env = getEnv();
    res.clearCookie(this.getCookieName(db), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/v1/auth',
      secure: env.COOKIE_SECURE,
    });
  }

  /**
   * POST /login
   */
  async login(db: string, body: LoginRequest, req: Request, res: Response): Promise<LoginResponse> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const requestId = (req.headers['x-request-id'] as string) || null;
    const isMobileClient = req.headers['x-client'] === 'mobile';

    // Anti-DoS check before expensive argon2 execution
    if (Buffer.byteLength(body.password, 'utf8') > PasswordPolicy.MAX_INPUT_BYTES) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نام کاربری یا رمز عبور اشتباه است',
      });
    }

    const normalizedUsername = PasswordPolicy.normalizeUsername(body.username);
    const usernameHash = AuditWriter.hashIdentifier(normalizedUsername);

    // 1. Check rate limits & lockout
    const rateCheck = await this.authRateLimitService.checkLoginAllowed(db, ip, normalizedUsername);
    if (!rateCheck.allowed) {
      if (rateCheck.retryAfterSec) {
        res.setHeader('Retry-After', rateCheck.retryAfterSec.toString());
      }
      await this.auditWriter.write(db, {
        action: 'auth.lockout',
        entityType: 'auth',
        meta: { ip, userAgent, requestId, usernameHash, reason: rateCheck.reason },
      });
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً بعداً تلاش کنید.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. Query user from database
    const client = await this.tenantClientManager.getClient(db);
    const user = await client.user.findFirst({
      where: {
        username: {
          equals: normalizedUsername,
          mode: 'insensitive',
        },
      },
    });

    // 3. Timing shield for non-existent or inactive user
    if (!user || user.status !== 'ACTIVE') {
      await this.passwordHasher.dummyVerify(body.password);
      const attemptRes = await this.authRateLimitService.recordLoginAttempt(
        db,
        ip,
        normalizedUsername,
        false,
      );
      await this.auditWriter.write(db, {
        action: 'auth.login.failure',
        entityType: 'auth',
        meta: {
          ip,
          userAgent,
          requestId,
          usernameHash,
          reason: !user ? 'user_not_found' : 'user_inactive',
        },
      });

      if (attemptRes.lockedNow && attemptRes.retryAfterSec) {
        res.setHeader('Retry-After', attemptRes.retryAfterSec.toString());
        throw new HttpException(
          {
            code: 'RATE_LIMITED',
            message: 'تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً بعداً تلاش کنید.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نام کاربری یا رمز عبور اشتباه است',
      });
    }

    // 4. Verify password
    const isPasswordValid = await this.passwordHasher.verifyPassword(
      user.passwordHash,
      body.password,
    );

    if (!isPasswordValid) {
      const attemptRes = await this.authRateLimitService.recordLoginAttempt(
        db,
        ip,
        normalizedUsername,
        false,
      );

      // Track failed attempts in DB for administrative visibility
      const newFailCount = user.failedLoginCount + 1;
      const lockedUntil =
        newFailCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : user.lockedUntil;

      await client.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: newFailCount,
          lockedUntil,
        },
      });

      await this.auditWriter.write(db, {
        actorId: user.id,
        action: 'auth.login.failure',
        entityType: 'auth',
        meta: { ip, userAgent, requestId, usernameHash, reason: 'wrong_password' },
      });

      if (attemptRes.lockedNow && attemptRes.retryAfterSec) {
        res.setHeader('Retry-After', attemptRes.retryAfterSec.toString());
        throw new HttpException(
          {
            code: 'RATE_LIMITED',
            message: 'تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً بعداً تلاش کنید.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نام کاربری یا رمز عبور اشتباه است',
      });
    }

    // 5. Successful login: reset rate limit counters and clear any prior user-level revocation
    await this.authRateLimitService.recordLoginAttempt(db, ip, normalizedUsername, true);
    await this.authRevocationService.clearUserRevokedBefore(db, user.id);

    // Check automatic Argon2 rehash
    let updatedPasswordHash: string | undefined = undefined;
    if (this.passwordHasher.needsRehash(user.passwordHash)) {
      updatedPasswordHash = await this.passwordHasher.hashPassword(body.password);
    }

    await client.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        passwordHash: updatedPasswordHash || undefined,
      },
    });

    // 6. Create session
    const sessionId = crypto.randomUUID();
    const familyId = crypto.randomUUID();
    const refreshTokenObj = this.refreshTokenService.generateToken(sessionId);
    const now = new Date();
    const expiresAt = this.refreshTokenService.getSlidingExpirationDate();

    await client.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        familyId,
        familyCreatedAt: now,
        refreshTokenHash: refreshTokenObj.hash,
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
        lastIp: ip,
        userAgent: userAgent ? userAgent.substring(0, 512) : null,
      },
    });

    // Enforce max 10 active sessions: revoke oldest active families if limit exceeded
    const activeSessionsCount = await client.session.count({
      where: {
        userId: user.id,
        revokedReason: null,
        expiresAt: { gt: now },
      },
    });

    if (activeSessionsCount > this.refreshTokenService.getMaxActiveSessionsLimit()) {
      const oldestSession = await client.session.findFirst({
        where: {
          userId: user.id,
          revokedReason: null,
          id: { not: sessionId },
        },
        orderBy: { familyCreatedAt: 'asc' },
      });

      if (oldestSession) {
        await client.session.updateMany({
          where: { familyId: oldestSession.familyId },
          data: { revokedReason: 'max_sessions_exceeded' },
        });
        await this.authRevocationService.revokeSession(db, oldestSession.id);
      }
    }

    // 7. Sign access JWT
    const { token: accessToken, expiresIn } = await this.tokenService.signAccessToken({
      sub: user.id,
      typ: user.type as 'INTERNAL' | 'PORTAL',
      db,
      sid: sessionId,
      mcp: user.mustChangePassword,
    });

    await this.auditWriter.write(db, {
      actorId: user.id,
      action: 'auth.login.success',
      entityType: 'auth',
      entityId: sessionId,
      meta: { ip, userAgent, requestId },
    });

    if (isMobileClient) {
      return {
        accessToken,
        expiresIn,
        refreshToken: refreshTokenObj.tokenString,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.fullName,
          type: user.type as 'INTERNAL' | 'PORTAL',
          mustChangePassword: user.mustChangePassword,
        },
      };
    } else {
      this.setRefreshTokenCookie(res, db, refreshTokenObj.tokenString);
      return {
        accessToken,
        expiresIn,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.fullName,
          type: user.type as 'INTERNAL' | 'PORTAL',
          mustChangePassword: user.mustChangePassword,
        },
      };
    }
  }

  /**
   * POST /refresh
   */
  async refresh(
    db: string,
    req: Request,
    res: Response,
    bodyToken?: string,
  ): Promise<RefreshResponse> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const requestId = (req.headers['x-request-id'] as string) || null;
    const isMobileClient = req.headers['x-client'] === 'mobile';

    const cookies = this.parseCookies(req.headers['cookie']);
    const cookieToken = cookies[this.getCookieName(db)];

    const tokenString = bodyToken || cookieToken;

    // CSRF check: If cookie was used (or in web context), strictly verify Origin
    if (cookieToken) {
      if (!this.verifyCsrf(req)) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'درخواست غیرمجاز (خطای اعتبارسنجی مبدا CSRF)',
        });
      }
    }

    if (!tokenString) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن تازه‌سازی ارائه نشده است',
      });
    }

    const parsed = this.refreshTokenService.parseToken(tokenString);
    if (!parsed) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'قالب توکن تازه‌سازی نامعتبر است',
      });
    }

    const client = await this.tenantClientManager.getClient(db);
    const session = await client.session.findUnique({
      where: { id: parsed.sessionId },
      include: { user: true },
    });

    if (!session || !session.user || session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نشست نامعتبر است',
      });
    }

    // Check family 90-day absolute ceiling
    if (this.refreshTokenService.isFamilyExpired(session.familyCreatedAt)) {
      await client.session.updateMany({
        where: { familyId: session.familyId },
        data: { revokedReason: 'family_expired' },
      });
      await this.authRevocationService.revokeSession(db, session.id);
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'عمر مجاز خانواده نشست‌ها به پایان رسیده است؛ لطفاً دوباره وارد شوید',
      });
    }

    // Check session sliding 30-day lifetime
    if (this.refreshTokenService.isSessionExpired(session.expiresAt)) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن تازه‌سازی منقضی شده است',
      });
    }

    // Verify cryptographic HMAC in constant time
    const isSecretValid = this.refreshTokenService.verifySecret(
      parsed.secret,
      session.refreshTokenHash,
    );
    if (!isSecretValid) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن تازه‌سازی نامعتبر است',
      });
    }

    // Atomic rotation via UPDATE ... WHERE rotated_at IS NULL RETURNING *
    const rotationNow = new Date();
    const rotationResult = await client.$queryRaw<Array<{ id: string }>>`
      UPDATE "sessions"
      SET "rotated_at" = ${rotationNow}
      WHERE "id" = ${parsed.sessionId}::uuid AND "rotated_at" IS NULL AND "revoked_reason" IS NULL
      RETURNING "id";
    `;

    if (!rotationResult || rotationResult.length === 0) {
      // Rotation failed: already rotated or revoked!
      const recheckedSession = await client.session.findUnique({
        where: { id: parsed.sessionId },
      });

      if (recheckedSession && recheckedSession.rotatedAt) {
        const deltaMs = Math.abs(Date.now() - new Date(recheckedSession.rotatedAt).getTime());
        const env = getEnv();

        if (deltaMs <= env.REFRESH_REUSE_GRACE_MS) {
          // Grace period: concurrent browser tab race condition
          // Reject with 401 WITHOUT revoking the family
          throw new UnauthorizedException({
            code: 'UNAUTHENTICATED',
            message: 'توکن تازه‌سازی اخیراً در تب دیگری استفاده شده است',
          });
        } else {
          // Reuse detected outside grace period! Revoke entire session family!
          await client.session.updateMany({
            where: { familyId: session.familyId },
            data: { revokedReason: 'reuse_detected' },
          });

          await this.authRevocationService.revokeUserBefore(db, session.userId);

          await this.auditWriter.write(db, {
            actorId: session.userId,
            action: 'auth.refresh_reuse_detected',
            entityType: 'auth',
            entityId: session.familyId,
            meta: {
              ip,
              userAgent,
              requestId,
              reusedSessionId: session.id,
              deltaMs,
            },
          });

          throw new UnauthorizedException({
            code: 'UNAUTHENTICATED',
            message: 'استفاده غیرمجاز از توکن قدیمی تشخیص داده شد؛ کلیه نشست‌های مرتبط باطل شدند',
          });
        }
      }

      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نشست باطل شده است',
      });
    }

    // Successful atomic rotation: create child session in the same family
    const newSessionId = crypto.randomUUID();
    const newRefreshToken = this.refreshTokenService.generateToken(newSessionId);
    const now = new Date();
    const newExpiresAt = this.refreshTokenService.getSlidingExpirationDate();

    await client.session.create({
      data: {
        id: newSessionId,
        userId: session.userId,
        familyId: session.familyId,
        familyCreatedAt: session.familyCreatedAt,
        refreshTokenHash: newRefreshToken.hash,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: newExpiresAt,
        lastIp: ip,
        userAgent: userAgent ? userAgent.substring(0, 512) : null,
      },
    });

    const { token: newAccessToken, expiresIn } = await this.tokenService.signAccessToken({
      sub: session.userId,
      typ: session.user.type as 'INTERNAL' | 'PORTAL',
      db,
      sid: newSessionId,
      mcp: session.user.mustChangePassword,
    });

    if (isMobileClient) {
      return {
        accessToken: newAccessToken,
        expiresIn,
        refreshToken: newRefreshToken.tokenString,
      };
    } else {
      this.setRefreshTokenCookie(res, db, newRefreshToken.tokenString);
      return {
        accessToken: newAccessToken,
        expiresIn,
      };
    }
  }

  /**
   * POST /logout
   */
  async logout(
    db: string,
    claims: AccessTokenClaims,
    req: Request,
    res: Response,
  ): Promise<LogoutResponse> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const requestId = (req.headers['x-request-id'] as string) || null;

    const cookies = this.parseCookies(req.headers['cookie']);
    if (cookies[this.getCookieName(db)]) {
      if (!this.verifyCsrf(req)) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'درخواست غیرمجاز (خطای اعتبارسنجی مبدا CSRF)',
        });
      }
    }

    const client = await this.tenantClientManager.getClient(db);
    await client.session.updateMany({
      where: { id: claims.sid },
      data: { revokedReason: 'logout' },
    });

    // Immediate access token rejection via Redis
    await this.authRevocationService.revokeSession(db, claims.sid);

    this.clearRefreshTokenCookie(res, db);

    await this.auditWriter.write(db, {
      actorId: claims.sub,
      action: 'auth.logout',
      entityType: 'auth',
      entityId: claims.sid,
      meta: { ip, userAgent, requestId },
    });

    return { success: true };
  }

  /**
   * POST /logout-all
   */
  async logoutAll(
    db: string,
    claims: AccessTokenClaims,
    req: Request,
    res: Response,
  ): Promise<LogoutAllResponse> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const requestId = (req.headers['x-request-id'] as string) || null;

    const client = await this.tenantClientManager.getClient(db);
    const userSessions = await client.session.findMany({
      where: {
        userId: claims.sub,
        revokedReason: null,
      },
      select: { id: true },
    });

    const updateResult = await client.session.updateMany({
      where: {
        userId: claims.sub,
        revokedReason: null,
      },
      data: { revokedReason: 'logout_all' },
    });

    for (const s of userSessions) {
      await this.authRevocationService.revokeSession(db, s.id);
    }

    // Invalidate all access tokens issued on or before now
    await this.authRevocationService.revokeUserBefore(db, claims.sub, Date.now());

    this.clearRefreshTokenCookie(res, db);

    await this.auditWriter.write(db, {
      actorId: claims.sub,
      action: 'auth.logout_all',
      entityType: 'auth',
      meta: { ip, userAgent, requestId, revokedCount: updateResult.count },
    });

    return { success: true, revokedCount: updateResult.count };
  }

  /**
   * GET /me
   */
  async getMe(db: string, claims: AccessTokenClaims): Promise<MeResponse> {
    const client = await this.tenantClientManager.getClient(db);

    const user = await client.user.findUnique({
      where: { id: claims.sub },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'کاربر نامعتبر یا غیرفعال است',
      });
    }

    const session = await client.session.findUnique({
      where: { id: claims.sid },
    });

    const companyProfile = await client.companyProfile.findFirst();
    const permissions = await this.permissionService.getUserPermissions(db, user.id);

    return {
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        type: user.type as 'INTERNAL' | 'PORTAL',
        mustChangePassword: user.mustChangePassword,
      },
      permissions,
      company: {
        name: companyProfile?.name || 'شرکت پیش‌فرض',
        defaultCurrency: companyProfile?.defaultCurrencyCode || 'IRR',
      },
      session: {
        id: session?.id || claims.sid,
        ip: session?.lastIp || null,
        userAgent: session?.userAgent || null,
        createdAt: session?.createdAt.toISOString() || new Date(claims.iat * 1000).toISOString(),
        lastUsedAt: session?.lastUsedAt.toISOString() || new Date().toISOString(),
        expiresAt: session?.expiresAt.toISOString() || new Date(claims.exp * 1000).toISOString(),
      },
    };
  }

  /**
   * POST /change-password
   */
  async changePassword(
    db: string,
    claims: AccessTokenClaims,
    body: ChangePasswordRequest,
    req: Request,
  ): Promise<ChangePasswordResponse> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const requestId = (req.headers['x-request-id'] as string) || null;

    const client = await this.tenantClientManager.getClient(db);
    const user = await client.user.findUnique({
      where: { id: claims.sub },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'کاربر نامعتبر یا غیرفعال است',
      });
    }

    // 1. Verify current password
    const isCurrentValid = await this.passwordHasher.verifyPassword(
      user.passwordHash,
      body.currentPassword,
    );
    if (!isCurrentValid) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'رمز عبور فعلی اشتباه است',
      });
    }

    // 2. Validate new password against strict policy
    const policyResult = PasswordPolicy.validate(body.newPassword, user.username);
    if (!policyResult.valid) {
      throw new HttpException(
        {
          code: 'VALIDATION_FAILED',
          message: policyResult.error || 'رمز عبور با سیاست امنیتی سازگار نیست',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // 3. Hash new password and update user
    const newPasswordHash = await this.passwordHasher.hashPassword(body.newPassword);

    await client.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        mustChangePassword: false,
      },
    });

    // 4. Invalidate all OTHER sessions of this user in DB and Redis
    const otherSessions = await client.session.findMany({
      where: {
        userId: user.id,
        id: { not: claims.sid },
        revokedReason: null,
      },
      select: { id: true },
    });

    await client.session.updateMany({
      where: {
        userId: user.id,
        id: { not: claims.sid },
        revokedReason: null,
      },
      data: { revokedReason: 'password_changed' },
    });

    for (const s of otherSessions) {
      await this.authRevocationService.revokeSession(db, s.id);
    }

    // 5. Generate fresh access token for current session (mcp: false)
    const { token: newAccessToken, expiresIn } = await this.tokenService.signAccessToken({
      sub: user.id,
      typ: user.type as 'INTERNAL' | 'PORTAL',
      db,
      sid: claims.sid,
      mcp: false,
    });

    await this.auditWriter.write(db, {
      actorId: user.id,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
      meta: { ip, userAgent, requestId },
    });

    return {
      accessToken: newAccessToken,
      expiresIn,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        type: user.type as 'INTERNAL' | 'PORTAL',
        mustChangePassword: false,
      },
    };
  }

  /**
   * GET /sessions
   */
  async getSessions(db: string, claims: AccessTokenClaims): Promise<SessionsListResponse> {
    const client = await this.tenantClientManager.getClient(db);

    const sessions = await client.session.findMany({
      where: {
        userId: claims.sub,
        revokedReason: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    return {
      items: sessions.map((s) => ({
        id: s.id,
        ip: s.lastIp,
        userAgent: s.userAgent,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        isCurrent: s.id === claims.sid,
      })),
    };
  }

  /**
   * DELETE /sessions/:id
   */
  async deleteSession(
    db: string,
    sessionId: string,
    claims: AccessTokenClaims,
    req: Request,
  ): Promise<DeleteSessionResponse> {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const requestId = (req.headers['x-request-id'] as string) || null;

    const client = await this.tenantClientManager.getClient(db);
    const session = await client.session.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== claims.sub) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'نشست مورد نظر یافت نشد',
      });
    }

    await client.session.update({
      where: { id: sessionId },
      data: { revokedReason: 'session_revoked' },
    });

    await this.authRevocationService.revokeSession(db, sessionId);

    await this.auditWriter.write(db, {
      actorId: claims.sub,
      action: 'auth.session_revoked',
      entityType: 'session',
      entityId: sessionId,
      meta: { ip, userAgent, requestId },
    });

    return { success: true };
  }
}
