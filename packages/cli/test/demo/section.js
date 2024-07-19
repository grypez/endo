/**
 * Wraps a test routine with a context's setup and teardown routines
 * 
 * @param {*} execa - The environment that executes cli commands
 * @param {{setup: (execa: *) => Promise, teardown: (execa: *) => Promise}} context - A conjugation of setup and teardown routines
 * @param {(execa: *) => Promise} implementation - The core routine to be wrapped
 */
export async function wrapWithContext(execa, context, implementation) {
  try {
    if ( context.setup !== undefined ) {
      await context.setup(execa);
    }
    await implementation(execa);
  } finally {
    if ( context.teardown !== undefined ) {
      await context.teardown(execa);
    }
  }
}

function makeEndoDaemonContext() {
  return {
    setup: async $ => {
      try {
        await $`endo restart`;
      } catch (err) {
        if ( !/EADDRINUSE\: address already in use/.test(err.message) ) {
          throw err;
        }
      }
    }
  }
}

export function wrapSectionTest(execa, context, testRoutine) {
  return async t => {
    const matchExpecation = (expectation, result, errMsg) => {
      (expectation instanceof RegExp ? t.regex : t.is)(
        result,
        expectation ?? '',
        errMsg,
      );
    }
    const testCommand = async (command, expectation) => {
      const result = await command;
      if ( expectation !== undefined ) {
        const errMsg = JSON.stringify({ expectation, result }, null, 2);
        matchExpecation(expectation.stdout, result.stdout, errMsg);
        matchExpecation(expectation.stderr, result.stderr, errMsg);
      }
    }
    await wrapWithContext(
      execa,
      makeEndoDaemonContext(),
      async $ => wrapWithContext(
        $,
        context,
        async $ => await testRoutine($, testCommand),
      )
    );
  }
}
