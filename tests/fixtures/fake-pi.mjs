// Stand-in for `pi -p`: echoes what it was called with, so tests can check
// the argv pi-cron builds. The prompt (last arg) steers the behaviour.
const args = process.argv.slice(2);
const prompt = args.at(-1);

if (prompt === "fail") {
  process.stderr.write("boom\n");
  process.exit(3);
}
if (prompt === "hang") {
  setTimeout(() => {}, 1_000_000);
} else {
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), piCron: process.env.PI_CRON ?? null }));
}
