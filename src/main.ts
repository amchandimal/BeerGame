import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { GAME_ROUTES } from './app/routes';
bootstrapApplication(AppComponent, { providers: [provideRouter(GAME_ROUTES, withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }))] }).catch(console.error);
