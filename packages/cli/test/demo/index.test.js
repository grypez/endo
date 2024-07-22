import test from 'ava';
import { $ } from 'execa';
import { wrapSectionTest } from './section.js';
import * as counterExample from './counter-example.js';

test.before(async () => $`alias endo=$PWD/bin/endo`);

test.serial('trivial (test of test)', wrapSectionTest($({ cwd: 'demo' }), {}, async (execa, testLine) => {
  const maxim = 'a failing test is better than failure to test';
  await testLine(execa`echo ${maxim}`, { stdout: maxim });
}));

test.serial('fixtures', wrapSectionTest($({ cwd: 'demo' }), counterExample.fixture, async (execa, testLine) => {
  await testLine(execa`endo show counter`, {
    stdout: 'Object [Alleged: Counter] {}'
  });
}));

test.serial('counter-example', wrapSectionTest($({ cwd: 'demo' }), {}, counterExample.section));
