import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
const prod = process.argv[2] === 'production';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const banner = `/*! Passagewise ${manifest.version} - Copyright (c) 2026 Smallbench Labs (Roger Chang) - MIT License. */`;
await esbuild.build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	format: 'cjs',
	target: 'es2021',
	platform: 'browser',
	outfile: 'main.js',
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
	minify: prod,
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	logLevel: 'info',
	legalComments: 'eof',
	banner: { js: banner },
});
