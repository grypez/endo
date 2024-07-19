import test from 'ava';
import { $ } from 'execa';
import { wrapSectionTest } from './section.js';

test.before(async () => $`alias endo=$PWD/bin/endo`);

test.serial('trivial (test of test)', wrapSectionTest($({ cwd: 'demo' }), {}, async (execa, testLine) => {
  const maxim = 'a failing test is better than failure to test';
  await testLine(execa`echo ${maxim}`, { stdout: maxim });
}));
