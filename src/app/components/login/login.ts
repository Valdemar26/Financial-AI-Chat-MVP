import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <div class="login-page">
      <form class="login-card" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <h1>{{ mode() === 'login' ? 'Sign in' : 'Create account' }}</h1>

        <label for="email">Email</label>
        <input id="email" type="email" formControlName="email" autocomplete="email" />
        @if (form.controls.email.touched && form.controls.email.invalid) {
          <p class="field-error" role="alert">Enter a valid email address.</p>
        }

        <label for="password">Password</label>
        <input id="password" type="password" formControlName="password" autocomplete="current-password" />
        @if (form.controls.password.touched && form.controls.password.invalid) {
          <p class="field-error" role="alert">Password must be at least 8 characters.</p>
        }

        @if (errorMessage()) {
          <p class="form-error" role="alert">{{ errorMessage() }}</p>
        }

        <button type="submit" [disabled]="form.invalid || isSubmitting()">
          {{ isSubmitting() ? 'Please wait…' : mode() === 'login' ? 'Sign in' : 'Create account' }}
        </button>

        <button type="button" class="switch-mode" (click)="toggleMode()">
          {{ mode() === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in' }}
        </button>
      </form>
    </div>
  `,
  styles: [`
    .login-page {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
      background: #f0f2f5;
    }

    .login-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 360px;
      padding: 24px;
      border: 1px solid #dde1e7;
      border-radius: 12px;
      background: #fff;
    }

    h1 { margin: 0 0 8px; font-size: 20px; color: #1a1d23; }

    label { font-size: 13px; font-weight: 600; color: #374151; }

    input {
      padding: 10px 12px;
      border: 1px solid #dde1e7;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
    }

    input:focus-visible { outline: 2px solid #4f46e5; outline-offset: 1px; }

    .field-error, .form-error {
      color: #ef4444;
      font-size: 12px;
      margin: 0;
    }

    button[type="submit"] {
      margin-top: 8px;
      padding: 10px;
      border: none;
      border-radius: 8px;
      background: #4f46e5;
      color: #fff;
      font-size: 14px;
      cursor: pointer;
    }

    button[type="submit"]:hover:not(:disabled) { background: #4338ca; }
    button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }

    .switch-mode {
      background: transparent;
      border: none;
      color: #4f46e5;
      font-size: 13px;
      cursor: pointer;
      padding: 4px;
    }
  `],
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly mode = signal<'login' | 'register'>('login');
  readonly isSubmitting = signal(false);
  readonly errorMessage = signal('');

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  toggleMode(): void {
    this.mode.update((m) => (m === 'login' ? 'register' : 'login'));
    this.errorMessage.set('');
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.isSubmitting()) return;

    this.isSubmitting.set(true);
    this.errorMessage.set('');
    const { email, password } = this.form.getRawValue();

    try {
      if (this.mode() === 'login') {
        await this.auth.login(email, password);
      } else {
        await this.auth.register(email, password);
      }
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.errorMessage.set(this.extractErrorMessage(e));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  private extractErrorMessage(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const message: unknown = e.error?.message;
      if (Array.isArray(message)) return message.join(', ');
      if (typeof message === 'string') return message;
    }
    return 'Something went wrong. Please try again.';
  }
}
