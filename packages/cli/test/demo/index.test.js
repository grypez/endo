import test from 'ava';
import { $ } from 'execa';
import { sectionTester } from './section.js';

test.before(async () => $`alias endo=$PWD/bin/endo`);
test.beforeEach(async () => $`endo purge -f`);
test.afterEach(async () => $`endo stop`);
test.after(async () => $`endo purge -f`);

const withExeca = sectionTester($({ cwd: 'demo' }));

test('trivial (test of test setup)', withExeca(async (testLine, execa) => {
  const maxim = 'a failing test is better than failure to test';
  await testLine(execa`echo ${maxim}`, { stdout: maxim });
}));
