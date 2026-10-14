import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createSignalingServer } from './index.mjs';

test('public pages, SEO assets, legal drafts, headers and origin restrictions', async () => {
  const old = process.env.PUBLIC_ORIGIN; process.env.PUBLIC_ORIGIN = 'https://beergame.io';
  const {server,wss} = createSignalingServer();
  if (old === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = old;
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/','/about','/how-to-play','/open-source','/privacy','/terms','/robots.txt','/sitemap.xml','/LICENSE.txt','/3rdpartylicenses.txt','/healthz']) {
      const response = await fetch(base+path); assert.equal(response.status,200,path);
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
      const text = await response.text();
      if (path === '/about') { assert.ok(text.includes('<h1>')); assert.ok(text.includes('bullwhip')); assert.ok(text.includes('https://beergame.io/about')); }
      if (path === '/privacy') assert.ok(text.includes('Chandimal Adikari'));
      if (path === '/sitemap.xml') { assert.ok(text.includes('https://beergame.io/how-to-play')); assert.ok(text.includes('https://beergame.io/multiplayer/classroom-group-challenge')); }
      if (path === '/') { assert.ok(text.includes('rel="stylesheet"')); assert.ok(!text.includes('onload='), 'CSP must not block stylesheet loading'); }
    }
    assert.equal((await fetch(base+'/not-a-page')).status,404);
    assert.equal((await fetch(base+'/.env')).status,404);
    assert.equal((await fetch(base+'/terms/',{redirect:'manual'})).status,308);
    for (const path of ['/single-player','/multiplayer','/multiplayer/create','/multiplayer/join','/multiplayer/team-supply-chain','/multiplayer/classroom-challenge','/multiplayer/classroom-group-challenge','/multiplayer/join/295384']) {
      const response = await fetch(base+path); assert.equal(response.status,200);
      const html = await response.text();
      if (path.startsWith('/multiplayer/classroom')) assert.ok(html.includes(`<title>${path.endsWith('group-challenge') ? 'Classroom Group Challenge' : 'Classroom Individual Challenge'} | beergame.io</title>`));
      assert.ok(html.includes(`rel="canonical" href="https://beergame.io${path}"`));
      assert.ok(html.includes('<app-root>'));
    }
    const about = await (await fetch(base+'/about')).text();
    assert.ok(about.includes('Copyright ©')); assert.ok(about.includes('aria-label="Footer"'));
    assert.ok(about.includes('href="/about" aria-current="page"'));
    assert.equal((await fetch(base+'/terms',{method:'POST'})).status,405);
    assert.equal(await (await fetch(base+'/terms',{method:'HEAD'})).text(),'');
    await new Promise((resolve,reject) => {
      const bad = new WebSocket(base.replace('http:','ws:')+'/signaling',{origin:'https://unrelated.example'});
      bad.on('open',()=>{bad.terminate();reject(new Error('Wrong origin accepted'));});
      bad.on('error',e=>{assert.match(e.message,/401/);resolve();});
    });
    const good = new WebSocket(base.replace('http:','ws:')+'/signaling',{origin:'https://beergame.io'});
    await once(good,'open'); good.close(); await once(good,'close');
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve=>wss.close(resolve)); await new Promise(resolve=>server.close(resolve));
  }
});
