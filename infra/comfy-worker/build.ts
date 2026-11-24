import { join } from 'node:path';

const workerDirectory = import.meta.dir;
const imageReferencePattern = /^[A-Za-z0-9][A-Za-z0-9./:@_-]+$/;

const buildRuntime = async (tag: string): Promise<void> => {
  if (!imageReferencePattern.test(tag)) throw new Error('invalid image tag');
  const build = Bun.spawn(['podman', 'build', '--format', 'oci', '--timestamp', '0', '--tag', tag, '--file', join(workerDirectory, 'Containerfile'), workerDirectory], { stdout: 'inherit', stderr: 'inherit' });
  if ((await build.exited) !== 0) throw new Error('Comfy worker runtime build failed');
};

if (import.meta.main) {
  const [tag, ...extra] = process.argv.slice(2);
  if (tag && extra.length === 0) await buildRuntime(tag);
  else throw new Error('usage: bun infra/comfy-worker/build.ts <local-image:tag>');
}
