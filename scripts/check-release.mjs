import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../site.config.json', import.meta.url), 'utf8'));
const errors = [];
for (const [key,value] of Object.entries(config)) if (!value || String(value).includes('TODO_')) errors.push(`Complete site.config.json: ${key}`);
if (!/^https:\/\//.test(config.origin)) errors.push('Public origin must use HTTPS.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail)) errors.push('Provide a working contact email.');
if (!/^https:\/\//.test(config.sourceUrl)) errors.push('Provide the exact public corresponding-source URL.');
if ((await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8')).includes('TODO_CONTACT_EMAIL')) errors.push('Set the private reporting contact in SECURITY.md.');
const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
if (!license.startsWith('MIT License') || !license.includes(`Copyright (c) 2026 ${config.operator}`) || !license.includes('Permission is hereby granted, free of charge') || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) errors.push('The MIT License text or its copyright line is missing or incomplete.');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Release metadata checks passed. Review deployment, privacy, dependencies and source availability before enabling indexing.');
