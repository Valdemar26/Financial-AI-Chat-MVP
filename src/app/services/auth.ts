import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AuthUser {
  userId: string;
  email: string;
}

interface AccessTokenResponse {
  accessToken: string;
}

function decodeAccessToken(token: string): AuthUser | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = JSON.parse(json) as { sub?: string; email?: string };
    if (!decoded.sub || !decoded.email) return null;
    return { userId: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly accessToken = signal<string | null>(null);
  readonly currentUser = signal<AuthUser | null>(null);
  readonly isAuthenticated = computed(() => this.accessToken() !== null);

  async register(email: string, password: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<AccessTokenResponse>(
        `${environment.apiUrl}/auth/register`,
        { email, password },
        { withCredentials: true },
      ),
    );
    this.setSession(response.accessToken);
  }

  async login(email: string, password: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<AccessTokenResponse>(
        `${environment.apiUrl}/auth/login`,
        { email, password },
        { withCredentials: true },
      ),
    );
    this.setSession(response.accessToken);
  }

  async refreshToken(): Promise<string> {
    const response = await firstValueFrom(
      this.http.post<AccessTokenResponse>(
        `${environment.apiUrl}/auth/refresh`,
        {},
        { withCredentials: true },
      ),
    );
    this.setSession(response.accessToken);
    return response.accessToken;
  }

  async logout(): Promise<void> {
    try {
      // Revokes the refresh token server-side and clears the httpOnly cookie
      // — without this, a stale-but-still-valid cookie lets a later silent
      // refresh (e.g. in authGuard) log the user back in after "logout".
      await firstValueFrom(
        this.http.post(`${environment.apiUrl}/auth/logout`, {}, { withCredentials: true }),
      );
    } catch {
      // Best-effort: still clear local state below even if the call fails
      // (e.g. offline) — the guard will fall back to a failed refresh then.
    } finally {
      this.accessToken.set(null);
      this.currentUser.set(null);
    }
  }

  private setSession(accessToken: string): void {
    this.accessToken.set(accessToken);
    this.currentUser.set(decodeAccessToken(accessToken));
  }
}
