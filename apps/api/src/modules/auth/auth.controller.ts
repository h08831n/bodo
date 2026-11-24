import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Req,
  Res,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { Public, CurrentUser } from '../../common/decorators/auth.decorators';
import { AccessTokenClaims } from '../../common/auth/token.service';
import { getCurrentDb } from '../../infra/tenancy/tenant-context';
import {
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RefreshResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  MeResponse,
  SessionsListResponse,
  LogoutResponse,
  LogoutAllResponse,
  DeleteSessionResponse,
} from '@bodo/contracts';

@ApiTags('Auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login to tenant database' })
  @ApiResponse({ status: 200, description: 'Authentication successful' })
  async login(
    @Body() body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const db = getCurrentDb();
    return this.authService.login(db, body, req, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate and refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  async refresh(
    @Body() body: RefreshRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponse> {
    const db = getCurrentDb();
    return this.authService.refresh(db, req, res, body?.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout from current session' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(
    @CurrentUser() claims: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    const db = getCurrentDb();
    return this.authService.logout(db, claims, req, res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all active sessions for current user' })
  @ApiResponse({ status: 200, description: 'All sessions revoked' })
  async logoutAll(
    @CurrentUser() claims: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutAllResponse> {
    const db = getCurrentDb();
    return this.authService.logoutAll(db, claims, req, res);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile, permissions, and active session' })
  @ApiResponse({ status: 200, description: 'Profile details returned' })
  async getMe(@CurrentUser() claims: AccessTokenClaims): Promise<MeResponse> {
    const db = getCurrentDb();
    return this.authService.getMe(db, claims);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password and revoke other sessions' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  async changePassword(
    @Body() body: ChangePasswordRequest,
    @CurrentUser() claims: AccessTokenClaims,
    @Req() req: Request,
  ): Promise<ChangePasswordResponse> {
    const db = getCurrentDb();
    return this.authService.changePassword(db, claims, body, req);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions for current user' })
  @ApiResponse({ status: 200, description: 'Active sessions list returned' })
  async getSessions(@CurrentUser() claims: AccessTokenClaims): Promise<SessionsListResponse> {
    const db = getCurrentDb();
    return this.authService.getSessions(db, claims);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a specific session for current user' })
  @ApiResponse({ status: 200, description: 'Session revoked successfully' })
  async deleteSession(
    @Param('id') sessionId: string,
    @CurrentUser() claims: AccessTokenClaims,
    @Req() req: Request,
  ): Promise<DeleteSessionResponse> {
    const db = getCurrentDb();
    return this.authService.deleteSession(db, sessionId, claims, req);
  }
}
