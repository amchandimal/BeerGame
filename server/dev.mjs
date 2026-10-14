import { spawn, spawnSync } from 'node:child_process';
const generated = spawnSync(process.execPath, ['scripts/build-site.mjs'], { stdio: 'inherit' });
if (generated.status !== 0) process.exit(generated.status ?? 1);
const children = [spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', env: { ...process.env, DEV_PUBLIC_PAGES: 'true' } }), spawn(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'serve', '--host', '127.0.0.1', '--proxy-config', 'proxy.conf.json'], { stdio: 'inherit' })];
let closing = false;
function close() { if (closing) return; closing = true; for (const child of children) child.kill(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
for (const child of children) child.on('exit', code => { close(); process.exitCode = code || 0; });
