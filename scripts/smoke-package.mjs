import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const runtime = resolve(process.argv[2]);
const { createSignalingServer } = await import(pathToFileURL(resolve(runtime,'server/index.mjs')));
const { server,wss } = createSignalingServer();
server.listen(0,'127.0.0.1'); await once(server,'listening');
try {
  for (const path of ['/','/healthz','/privacy','/terms','/about','/sitemap.xml','/3rdpartylicenses.txt']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status,200,path);
  }
  console.log('Packaged runtime serves game, legal, SEO, license and health routes.');
} finally { await new Promise(resolve=>wss.close(resolve)); await new Promise(resolve=>server.close(resolve)); }
