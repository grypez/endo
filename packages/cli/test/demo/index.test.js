import test from 'ava';
import { $ } from 'execa';
import { sectionTester } from './section.js';
import { section as counterExample } from './counter-example.js';
import { section as doublerAgent } from './doubler-agent.js';
import { section as sendingMessages } from './sending-messages.js';
import { section as namesInTransit } from './names-in-transit.js';
import { section as mailboxesAreSymmetric } from './mailboxes-are-symmetric.js';
import { section as confinedScript } from './confined-script.js';

test.before(async () => $`alias endo=$PWD/bin/endo`);
test.beforeEach(async () => $`endo purge -f`);
test.afterEach(async () => $`endo stop`);
test.after(async () => $`endo purge -f`);

const withExeca = sectionTester($({ cwd: 'demo' }));

test('trivial (test of test setup)', withExeca(async (testLine, execa) => {
  const maxim = 'a failing test is better than failure to test';
  await testLine(execa`echo ${maxim}`, { stdout: maxim });
}));

test.serial('counter-example', withExeca(counterExample));
test.serial('doubler-agent', withExeca(doublerAgent));
test.serial('sending-messages', withExeca(sendingMessages));
test.serial('names-in-transit', withExeca(namesInTransit));
test.serial('mailboxes-are-symmetric', withExeca(mailboxesAreSymmetric));
test('confined-script', withExeca(confinedScript));
