export async function section(testLine, execa) {
  // If a runlet returns a promise for some value, it will print that value before exiting gracefully.
  await testLine(execa`endo run runlet.js a b c`, {
    stderr: 'Starting Endo daemon...',
    stdout: "Hello, World! [ 'a', 'b', 'c' ]\n42"
  });
}
