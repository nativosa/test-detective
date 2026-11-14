// TEST ONLY: the child the relay harness starts (as the current user). Modes (argv[2]):
//   echo  read stdin to EOF; print the first line and the rest upper-cased; a line on stderr; exit 7
//   tree  start a grandchild (and a detached one), print their PIDs, exit 0 (the job must end them)
//   hang  start a grandchild, print its PID, never exit (killing the relay must end both)
import { spawn } from 'node:child_process';

const mode = process.argv[2];
const sleeper = ['-e', 'setInterval(() => {}, 1000)'];

if (mode === 'echo') {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (data += d));
  process.stdin.on('end', () => {
    const [first, ...rest] = data.split('\n');
    process.stdout.write(`FIRST ${first}\nREST ${rest.join('\n').toUpperCase()}\n`);
    process.stderr.write('ERR line\n');
    process.exitCode = 7;
  });
} else if (mode === 'tree' || mode === 'hang') {
  const child = spawn(process.execPath, sleeper, { stdio: 'ignore' });
  process.stdout.write(`PID ${child.pid}\n`);
  if (mode === 'tree') {
    try {
      const detached = spawn(process.execPath, sleeper, { stdio: 'ignore', detached: true });
      detached.on('error', (e) => process.stdout.write(`DERR ${e.code}\n`));
      if (detached.pid) process.stdout.write(`DPID ${detached.pid}\n`);
      detached.unref();
    } catch (e) {
      process.stdout.write(`DERR ${e.code}\n`);
    }
    child.unref();
    setTimeout(() => process.exit(0), 300);
  } else {
    process.stdout.write('HANGING\n');
    setInterval(() => {}, 1000);
  }
} else {
  process.exit(2);
}
