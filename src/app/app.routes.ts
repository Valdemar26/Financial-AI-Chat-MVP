import { Routes } from '@angular/router';
import { AppComponent } from './app';
import { LoginComponent } from './components/login/login';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', component: AppComponent, canActivate: [authGuard] },
  { path: 'login', component: LoginComponent },
  { path: '**', redirectTo: '' },
];
