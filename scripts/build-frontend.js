#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdir, copyFile, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src/public');
const outDir = join(root, 'dist/public');

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    const s = await stat(src);
    if (s.isDirectory()) await copyDir(src, dst);
    else if (entry !== 'app.ts') await copyFile(src, dst);
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await copyDir(srcDir, outDir);
  await build({
    entryPoints: [join(srcDir, 'app.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile: join(outDir, 'app.js'),
    sourcemap: true,
    minify: false,
    logLevel: 'info',
  });
  console.log(`✔ frontend bundled → ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
