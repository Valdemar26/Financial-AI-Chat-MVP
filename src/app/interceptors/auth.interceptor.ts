import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiUrl)) {
    return next(req);
  }

  const auth = inject(AuthService);
  const router = inject(Router);
  const isRefreshRequest = req.url.endsWith('/auth/refresh');

  const attach = (token: string | null) =>
    req.clone({
      withCredentials: true,
      ...(token ? { setHeaders: { Authorization: `Bearer ${token}` } } : {}),
    });

  return next(attach(auth.accessToken())).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401 || isRefreshRequest) {
        return throwError(() => error);
      }

      return from(auth.refreshToken()).pipe(
        switchMap((token) => next(attach(token))),
        catchError((refreshError: unknown) => {
          auth.logout();
          router.navigateByUrl('/login');
          return throwError(() => refreshError);
        }),
      );
    }),
  );
};
