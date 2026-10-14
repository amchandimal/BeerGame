import { Component } from '@angular/core';
import { Routes } from '@angular/router';

// The game shell owns live WebRTC state so setup navigation does not recreate it.
@Component({ standalone: true, template: '' })
export class RouteMarker {}
export const GAME_ROUTES: Routes = [
  '', 'single-player', 'multiplayer', 'multiplayer/create',
  'multiplayer/team-supply-chain', 'multiplayer/classroom-challenge', 'multiplayer/classroom-group-challenge', 'multiplayer/join', 'multiplayer/join/:code'
].map(path => ({ path, pathMatch: 'full', component: RouteMarker }));
GAME_ROUTES.push({ path: '**', redirectTo: '' });
