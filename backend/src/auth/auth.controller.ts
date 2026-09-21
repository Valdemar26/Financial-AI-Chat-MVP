import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';

const REFRESH_COOKIE_NAME = 'refresh_token';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const { accessToken, refreshToken } = await this.authService.register(dto);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const { accessToken, refreshToken } = await this.authService.login(dto);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const { accessToken, refreshToken } = await this.authService.refresh(token);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await this.authService.logout(token);
    res.clearCookie(REFRESH_COOKIE_NAME, this.cookieOptions());
    return { success: true };
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      ...this.cookieOptions(),
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }

  // `path` must be explicit and identical on every set/clear call — without
  // it, browsers default the cookie's path to the directory of whichever
  // /auth/* endpoint set it, while Express's clearCookie() defaults to '/'.
  // That mismatch means clearCookie silently fails to remove the cookie the
  // browser actually stored, so logout doesn't revoke the session.
  //
  // In production the frontend (vercel.app) and backend (railway.app) are
  // different sites, so the cookie must be SameSite=None to survive
  // cross-site requests — which in turn requires Secure. Locally both run
  // on the same site (or plain http), so we keep Lax there.
  private cookieOptions() {
    const isLocal = this.config.get<string>('NODE_ENV') !== 'production';
    return {
      httpOnly: true,
      secure: !isLocal,
      sameSite: isLocal ? ('lax' as const) : ('none' as const),
      path: '/',
    };
  }
}
