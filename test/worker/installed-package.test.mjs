import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
function execute(file, args, cwd, env = process.env) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${file}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

test('normal npm installation and declared default execute without Go, Bun, peer or development dependencies', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-installed-package-')));
  const prefix = join(scratch, 'prefix');
  const fixture = join(scratch, 'fixture');
  mkdirSync(prefix); mkdirSync(fixture);
  writeFileSync(join(prefix, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(fixture, 'source.ts'), 'export const installedNeedle = 1;\n');
  try {
    const packed = JSON.parse(execute('npm', ['pack', '--json', '--pack-destination', scratch], repository))[0];
    const binaries = join(scratch, 'bin');
    mkdirSync(binaries);
    symlinkSync(process.execPath, join(binaries, 'node'));
    const runtimeEnv = { ...process.env, PATH: `${binaries}:/usr/bin:/bin` };
    for (const binary of ['go', 'bun']) assert.equal(spawnSync(binary, ['--version'], { env: runtimeEnv }).error?.code, 'ENOENT');
    const npmPath = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, 'npm')).find(path => existsSync(path));
    assert.ok(npmPath, 'npm executable is a test prerequisite');
    execute(process.execPath, [realpathSync(npmPath), 'install', '--prefix', prefix, '--offline', '--omit=dev', '--omit=peer', '--legacy-peer-deps', '--no-audit', '--no-fund', join(scratch, packed.filename)], scratch, runtimeEnv);
    const installed = join(prefix, 'node_modules/pi-inspect-context');
    assert.equal(existsSync(join(prefix, 'node_modules/typebox')), false);
    assert.equal(existsSync(join(installed, 'node_modules/typebox')), false);
    assert.equal(existsSync(join(installed, 'bin/inspect-context')), false);
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.pi.extensions.length, 1);
    const host = join(scratch, 'host.ts');
    const probe = join(installed, 'extensions/probe.mjs');
    writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {
      typebox: [require.resolve('typebox')], 'typebox/value': [require.resolve('typebox/value')],
    } } }));
    writeFileSync(host, `
      import assert from 'node:assert/strict';
      import registerInspectContext from ${JSON.stringify(join(installed, manifest.pi.extensions[0]))};
      let tool;
      let shutdown;
      registerInspectContext({registerTool(value){tool=value},on(_event,handler){shutdown=handler}});
      try {
        const result=await tool.execute('installed',{query:'installedNeedle'},undefined,undefined,{cwd:${JSON.stringify(fixture)}});
        assert.ok(result.details.excerpts.some(item=>item.path==='source.ts'&&item.text==='export const installedNeedle = 1;\\n'));
        assert.equal(result.details.snapshot.validated,true);
        console.log('installed-package-success');
      } finally { if(shutdown) await shutdown({type:'session_shutdown',reason:'quit'}); }
    `);
    execute('bun', ['build', host, '--target=node', '--outfile', probe], scratch);
    assert.match(execute(process.execPath, [probe], scratch, runtimeEnv), /installed-package-success/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
