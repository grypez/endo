function matchExpecation(t, expectation, result, errMsg) {
  (expectation instanceof RegExp ? t.regex : t.is)(
    result,
    expectation ?? '',
    errMsg,
  );
}

function testLine(t, execaCmd, expectation) {
  return expectation === undefined
    ? execaCmd
    : execaCmd.then(result => {
        const errMsg = JSON.stringify({ expectation, result }, null, 2);
        matchExpecation(t, expectation.stdout, result.stdout, errMsg);
        matchExpecation(t, expectation.stderr, result.stderr, errMsg);
      });
};

export function sectionTest(execa, implementation) {
  return async t => implementation((execaCmd, expectation) => testLine(t, execaCmd, expectation), execa);
}

export const sectionTester = execa => implementation => sectionTest(execa, implementation);