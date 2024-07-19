import test from 'ava';
import { exec } from 'child_process';

/**
 * Execute simple shell command (async wrapper).
 * @param {string} cmd
 * @returns {object} { stdout: String, stderr: String }
 */
async function sh(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function testSection(name, t) {
  const observed = await sh(`bash test/demo/${  name  }.test.sh`);
  const { stdout } = await sh(`cat test/demo/${  name  }.test.stdout`);
  const { stdout: stderr } = await sh(`cat test/demo/${  name  }.test.stderr`);
  t.deepEqual(observed, { stdout, stderr });
}

test('trivial (test of test setup)', async t => testSection('trivial', t));
test('A counter example', async t => testSection('counter-example', t));
