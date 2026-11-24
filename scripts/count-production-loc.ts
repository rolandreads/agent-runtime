import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const git = spawnSync('git', ['ls-files', '*.ts'], { encoding: 'utf8' });

if (git.status !== 0) throw new Error(git.stderr.trim() || 'git ls-files failed');

const files = git.stdout
  .split('\n')
  .filter((path) => path.length > 0)
  .filter((path) => path.startsWith('src/'))
  .filter((path) => !path.endsWith('.d.ts'))
  .filter((path) => !path.endsWith('.test.ts'))
  .filter((path) => !path.includes('/tests/'))
  .filter((path) => path !== 'src/test-setup.ts');

let totalLines = 0;

for (const file of files) {
  const contents = readFileSync(file, 'utf8');
  totalLines += contents.length === 0 ? 0 : contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
}

console.log(`${totalLines} lines`);
console.log(`${files.length} files`);
